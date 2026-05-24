"""
voice-transcription-bot — Matrix bot that transcribes and summarizes voice messages.

Lifecycle:
  1. Join as a regular Matrix user (registered once via Conduit admin room).
  2. Listen for m.room.message events with msgtype = m.audio.
  3. Download the audio file from the homeserver (local — stays on-cluster).
  4. POST to whisper.cpp (flinker:8081) → get transcript text.
  5. POST transcript to llama.cpp (flinker:8080) → get summary.
  6. Send transcript + summary as a threaded reply in the originating room.

Design:
  - Events processed sequentially to avoid overloading whisper.cpp / llama.cpp.
  - In-memory dedup set prevents duplicate processing on reconnect.
  - Error handling tiers (see design.md §4): graceful degradation, crash-on-auth-failure.
  - Structured JSON logging (kubectl logs | jq compatible).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import aiohttp
from nio import AsyncClient, InviteEvent, MatrixRoom, RoomMessageAudio, RoomSpaceChildEvent, SyncResponse

# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------

class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log_entry = {
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_entry)


def setup_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)


logger = logging.getLogger("voice-transcription-bot")

# ---------------------------------------------------------------------------
# Config from environment variables
# ---------------------------------------------------------------------------

def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        logger.error({"config_error": f"Required environment variable {name!r} is not set"})
        sys.exit(1)
    return value


HOMESERVER_URL = require_env("MATRIX_HOMESERVER_URL")
BOT_USER_ID = require_env("MATRIX_BOT_USER_ID")
# BOT_ACCESS_TOKEN is provisioned after Conduit is running (bootstrap step).
# Read lazily in run() so the container starts cleanly before the secret exists.
WHISPER_URL = os.environ.get("WHISPER_URL", "http://flinker:8081")  # whisper.cpp ASR
WHISPER_NO_SPEECH_THOLD = float(os.environ.get("WHISPER_NO_SPEECH_THOLD", "0.6"))
LLM_URL = os.environ.get("LLM_URL", "http://flinker:8080/v1")  # llama.cpp OpenAI-compatible API
LLM_MODEL = os.environ.get("LLM_MODEL", "default")  # model loaded in llama.cpp
LLM_API_KEY = os.environ.get("LLM_API_KEY", "not-needed")  # llama.cpp ignores this
STORE_PATH = os.environ.get("STORE_PATH", "/data/nio-store")

# ---------------------------------------------------------------------------
# Dedup set — prevents double-processing on reconnect
# ---------------------------------------------------------------------------

_processed_event_ids: set[str] = set()

# ---------------------------------------------------------------------------
# Whisper transcription
# ---------------------------------------------------------------------------

async def transcribe(audio_bytes: bytes, filename: str = "audio.ogg") -> str | None:
    """
    POST audio to whisper.cpp and return the transcript text, or None on failure.

    API: POST /inference
         Content-Type: multipart/form-data
         Fields:
           file=<audio bytes>
           temperature=0.0
           temperature_inc=0.2
           no_speech_thold=<configurable>
           response_format=json
    """
    asr_url = f"{WHISPER_URL}/inference"
    try:
        async with aiohttp.ClientSession() as session:
            form = aiohttp.FormData()
            form.add_field(
                "file",
                audio_bytes,
                filename=filename,
                content_type="audio/ogg",
            )
            form.add_field("temperature", "0.0")
            form.add_field("temperature_inc", "0.2")
            form.add_field("no_speech_thold", str(WHISPER_NO_SPEECH_THOLD))
            form.add_field("response_format", "json")

            async with session.post(asr_url, data=form, timeout=aiohttp.ClientTimeout(total=120)) as resp:
                if resp.status != 200:
                    logger.warning(
                        {"event": "whisper_error", "status": resp.status, "body": await resp.text()}
                    )
                    return None
                data = await resp.json()
                # whisper.cpp returns {"text": "..."}
                transcript = data.get("text", "").strip()
                if not transcript:
                    logger.warning({"event": "whisper_empty", "event_id": filename})
                    return None
                logger.info({"event": "transcribed", "chars": len(transcript)})
                return transcript
    except Exception as exc:  # noqa: BLE001
        logger.warning({"event": "whisper_unavailable", "error": str(exc)})
        return None


# ---------------------------------------------------------------------------
# LLM summarization (llama.cpp on flinker:8080)
# ---------------------------------------------------------------------------

SUMMARIZE_SYSTEM_PROMPT = (
    "You are a concise assistant. Summarize the following voice message transcript "
    "in 1-3 sentences. Preserve proper nouns, dates, and key action items. "
    "Reply only with the summary — no preamble."
)


async def summarize(transcript: str) -> str | None:
    """
    Send transcript to llama.cpp (OpenAI-compatible /v1/chat/completions)
    and return the summary, or None on failure.
    """
    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": SUMMARIZE_SYSTEM_PROMPT},
            {"role": "user", "content": transcript},
        ],
        # Qwen3 is a reasoning/thinking model — it needs tokens to think before
        # emitting content. 200 is too few. 1000 gives enough budget for thinking
        # AND the actual summary sentence. Increase if responses are cut off.
        "max_tokens": 1000,
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {LLM_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{LLM_URL}/chat/completions",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    logger.warning(
                        {"event": "llm_error", "status": resp.status, "body": await resp.text()}
                    )
                    return None
                data = await resp.json()
                msg = data["choices"][0]["message"]
                # Qwen3 / reasoning models: actual answer is in "content";
                # "reasoning_content" is the internal chain-of-thought scratchpad.
                summary = (msg.get("content") or "").strip()
                if not summary:
                    # Model ran out of tokens mid-think — no usable output
                    logger.warning({"event": "llm_empty", "finish": data["choices"][0].get("finish_reason")})
                    return None
                logger.info({"event": "summarized", "chars": len(summary)})
                return summary
    except Exception as exc:  # noqa: BLE001
        logger.warning({"event": "llm_unavailable", "error": str(exc)})
        return None


# ---------------------------------------------------------------------------
# Reply formatting
# ---------------------------------------------------------------------------

def build_reply_body(transcript: str, summary: str | None) -> tuple[str, str]:
    """Return (plain_text_body, formatted_html_body) for the reply."""
    if summary:
        plain = f"📝 **Summary:** {summary}\n\n📄 **Transcript:** {transcript}"
        html = (
            f"<p><strong>📝 Summary:</strong> {summary}</p>"
            f"<p><strong>📄 Transcript:</strong> {transcript}</p>"
        )
    else:
        plain = f"📄 **Transcript:** {transcript}"
        html = f"<p><strong>📄 Transcript:</strong> {transcript}</p>"
    return plain, html


# ---------------------------------------------------------------------------
# Invite handler — auto-join any room the bot is invited to
# ---------------------------------------------------------------------------

async def handle_invite(room: MatrixRoom, event: InviteEvent, client: AsyncClient) -> None:
    """Automatically accept room invitations so the bot can receive audio events."""
    logger.info({"event": "invite_received", "room_id": room.room_id, "inviter": event.sender})
    try:
        await client.join(room.room_id)
        logger.info({"event": "room_joined", "room_id": room.room_id})
    except Exception as exc:  # noqa: BLE001
        logger.warning({"event": "join_failed", "room_id": room.room_id, "error": str(exc)})


async def handle_space_child(room: MatrixRoom, event: Any, client: AsyncClient) -> None:
    """Join new bridge portal rooms when they appear as children of a bridge space."""
    # m.space.child state_key is the child room ID
    child_room_id = getattr(event, "state_key", None)
    if not child_room_id or not child_room_id.startswith("!"):
        return

    # Skip if bot already joined this room
    if child_room_id in client.rooms:
        return

    logger.info({"event": "space_child_detected", "space_id": room.room_id, "child_room_id": child_room_id})
    try:
        resp = await client.join(child_room_id)
        if hasattr(resp, "room_id"):
            logger.info({"event": "space_child_joined", "room_id": child_room_id})
        else:
            logger.warning({"event": "space_child_join_failed", "room_id": child_room_id, "resp": str(resp)})
    except Exception as exc:  # noqa: BLE001
        logger.warning({"event": "space_child_join_exception", "room_id": child_room_id, "error": str(exc)})


# ---------------------------------------------------------------------------
# Event handler
# ---------------------------------------------------------------------------

async def handle_audio_event(
    room: MatrixRoom,
    event: RoomMessageAudio,
    client: AsyncClient,
) -> None:
    """Process a single m.audio event: download → transcribe → summarize → reply."""
    event_id = event.event_id

    # Dedup: skip events we've already processed (e.g. from sync backfill on reconnect)
    if event_id in _processed_event_ids:
        logger.info({"event": "skipped_duplicate", "event_id": event_id})
        return
    _processed_event_ids.add(event_id)

    logger.info({
        "event": "audio_received",
        "room_id": room.room_id,
        "event_id": event_id,
        "sender": event.sender,
        "duration_ms": event.body,
    })

    # Don't process our own messages
    if event.sender == BOT_USER_ID:
        return

    # Step 1: Download audio — use /_matrix/client/v1/media/download (MSC3916 authenticated).
    # Conduit v0.10+ rejects the old unauthenticated /_matrix/media/v3/download with 404.
    audio_bytes: bytes | None = None
    try:
        mxc_url = event.url  # e.g. mxc://matrix.no-panic.org/XXXX
        if not mxc_url or not mxc_url.startswith("mxc://"):
            raise ValueError(f"Invalid MXC URL: {mxc_url!r}")
        mxc_path = mxc_url[len("mxc://"):]  # "matrix.no-panic.org/XXXX"
        dl_url = f"{HOMESERVER_URL}/_matrix/client/v1/media/download/{mxc_path}"
        access_token = client.access_token
        async with aiohttp.ClientSession() as session:
            async with session.get(
                dl_url,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status == 200:
                    audio_bytes = await resp.read()
                    logger.info({"event": "download_ok", "event_id": event_id, "bytes": len(audio_bytes)})
                else:
                    body = await resp.text()
                    logger.warning({"event": "download_failed", "event_id": event_id, "status": resp.status, "body": body[:200]})
    except Exception as exc:  # noqa: BLE001
        logger.warning({"event": "download_exception", "event_id": event_id, "error": str(exc)})

    if not audio_bytes:
        await _send_error_reply(client, room, event, "⚠️ Could not download audio file.")
        return

    # Step 2: Transcribe via Whisper (local, CPU-bound — sequential)
    transcript = await transcribe(audio_bytes, filename=event.body or "audio.ogg")
    if not transcript:
        await _send_error_reply(client, room, event, "⚠️ Transcription unavailable — Whisper service may be starting up.")
        return

    # Step 3: Summarize via llama.cpp (local LLM on flinker:8080)
    summary = await summarize(transcript)
    # summary=None is acceptable — we'll reply with transcript only (error tier: continue)

    # Step 4: Post threaded reply
    plain, html = build_reply_body(transcript, summary)
    await _send_reply(client, room, event, plain, html)


async def _send_reply(
    client: AsyncClient,
    room: MatrixRoom,
    event: RoomMessageAudio,
    plain: str,
    html: str,
) -> None:
    """Send a threaded reply to the original audio event."""
    content: dict[str, Any] = {
        "msgtype": "m.text",
        "body": plain,
        "format": "org.matrix.custom.html",
        "formatted_body": html,
        "m.relates_to": {
            "rel_type": "m.thread",
            "event_id": event.event_id,
            "is_falling_back": True,
            "m.in_reply_to": {"event_id": event.event_id},
        },
    }
    try:
        await client.room_send(room.room_id, "m.room.message", content)
        logger.info({"event": "reply_sent", "room_id": room.room_id, "event_id": event.event_id})
    except Exception as exc:  # noqa: BLE001
        # Matrix send failure: log and continue — do not crash (design.md §4)
        logger.error({"event": "reply_failed", "room_id": room.room_id, "error": str(exc)})


async def _send_error_reply(
    client: AsyncClient,
    room: MatrixRoom,
    event: RoomMessageAudio,
    message: str,
) -> None:
    """Send a plain error reply for user-visible failures."""
    content: dict[str, Any] = {
        "msgtype": "m.notice",
        "body": message,
        "m.relates_to": {
            "rel_type": "m.thread",
            "event_id": event.event_id,
            "is_falling_back": True,
            "m.in_reply_to": {"event_id": event.event_id},
        },
    }
    try:
        await client.room_send(room.room_id, "m.room.message", content)
    except Exception as exc:  # noqa: BLE001
        logger.error({"event": "error_reply_failed", "error": str(exc)})


# ---------------------------------------------------------------------------
# Main event loop
# ---------------------------------------------------------------------------

async def run() -> None:
    """Main loop: login → sync → handle audio events."""
    # Wait until BOT_ACCESS_TOKEN is available — the secret is provisioned after
    # Conduit is running. The pod keeps running and retries every 30 s so k8s
    # doesn't enter CrashLoopBackOff from a hard exit.
    bot_access_token = os.environ.get("BOT_ACCESS_TOKEN")
    while not bot_access_token:
        logger.info({"event": "waiting_for_token",
                     "reason": "BOT_ACCESS_TOKEN not set — waiting for secret to be provisioned"})
        await asyncio.sleep(30)
        bot_access_token = os.environ.get("BOT_ACCESS_TOKEN")

    Path(STORE_PATH).mkdir(parents=True, exist_ok=True)

    client = AsyncClient(
        homeserver=HOMESERVER_URL,
        user=BOT_USER_ID,
        store_path=STORE_PATH,
    )

    # Set the access token directly — bot user is pre-registered, no login required
    client.access_token = bot_access_token
    client.user_id = BOT_USER_ID

    # Validate the token immediately — if invalid, crash so k8s will restart with backoff
    try:
        whoami = await client.whoami()
        if hasattr(whoami, "statuscode"):
            # M_UNKNOWN_TOKEN → auth failure → crash immediately (design.md §4)
            logger.error({"event": "auth_failed", "response": str(whoami)})
            sys.exit(1)
        logger.info({"event": "authenticated", "user_id": whoami.user_id})
    except Exception as exc:
        logger.error({"event": "auth_exception", "error": str(exc)})
        sys.exit(1)

    # Register callbacks — matrix-nio calls callbacks with (room, event);
    # inject `client` via closure for both handlers.
    client.add_event_callback(  # type: ignore[arg-type]
        lambda room, event: handle_audio_event(room, event, client),
        RoomMessageAudio,
    )
    # Auto-join: accept any room invite so the bot is present in bridged rooms
    client.add_event_callback(  # type: ignore[arg-type]
        lambda room, event: handle_invite(room, event, client),
        InviteEvent,
    )
    # Space child watcher: when a bridge space gains a new child portal room, join it.
    # This fires for m.space.child state events in any room the bot is already in.
    client.add_event_callback(  # type: ignore[arg-type]
        lambda room, event: handle_space_child(room, event, client),
        RoomSpaceChildEvent,
    )

    logger.info({"event": "starting_sync", "homeserver": HOMESERVER_URL})

    # 30 s long-poll — Conduit holds the connection until new events arrive.
    # full_state is intentionally omitted (defaults False): incremental deltas only.
    # full_state=True dumps all room state on every cycle → 100% CPU spin.
    while True:
        try:
            sync_response = await client.sync(timeout=30000)
            if isinstance(sync_response, SyncResponse):
                logger.debug({"event": "sync_ok", "next_batch": sync_response.next_batch})
            else:
                logger.warning({"event": "sync_failed", "response": str(sync_response)})
                await asyncio.sleep(5)
        except Exception as exc:  # noqa: BLE001
            logger.warning({"event": "sync_exception", "error": str(exc)})
            await asyncio.sleep(5)


def main() -> None:
    setup_logging()
    logger.info({"event": "bot_starting", "user_id": BOT_USER_ID, "homeserver": HOMESERVER_URL})
    asyncio.run(run())


if __name__ == "__main__":
    main()
