#!/usr/bin/env python3
"""
End-to-end test for the voice-transcription-bot pipeline.

Fetches the most recent m.audio event from the Signal bridge room via the
Matrix Client-Server API, downloads the audio file, runs it through:
  1. whisper.cpp  (flinker:8081) — audio → transcript
  2. llama.cpp    (flinker:8080) — transcript → summary (auto-discovered model)

This validates the full pipeline that runs inside the bot pod against real data.

Usage (run locally — needs access to flinker:8080/8081 and Conduit):
  # In-cluster (from inside the bot pod):
  kubectl exec -n matrix deployment/transcription-bot -- python3 /app/e2e_test.py

  # Locally (if flinker ports are reachable from your machine):
  BOT_ACCESS_TOKEN=<token> MATRIX_HOMESERVER_URL=https://matrix.no-panic.org python3 e2e_test.py

  # Override which room to search for audio:
  MATRIX_ROOM_ID='!YzHiVT_wL8BH1SPuDYwJy8_vjPRE2zDcPizvQWDf1i0' python3 e2e_test.py

Requirements: only stdlib (no aiohttp/requests needed — uses urllib)
"""

import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HOMESERVER_URL = os.environ.get("MATRIX_HOMESERVER_URL", "http://conduit.matrix.svc.cluster.local")
BOT_ACCESS_TOKEN = os.environ.get("BOT_ACCESS_TOKEN", "")
# The Signal bridge room we know contains voice messages from the user
MATRIX_ROOM_ID = os.environ.get(
    "MATRIX_ROOM_ID",
    "!YzHiVT_wL8BH1SPuDYwJy8_vjPRE2zDcPizvQWDf1i0",
)
WHISPER_URL = os.environ.get("WHISPER_URL", "http://flinker:8081")
LLM_URL = os.environ.get("LLM_URL", "http://flinker:8080/v1")
WHISPER_NO_SPEECH_THOLD = os.environ.get("WHISPER_NO_SPEECH_THOLD", "0.6")

SEP = "=" * 65


def _matrix_get(path: str) -> dict:
    url = f"{HOMESERVER_URL}{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {BOT_ACCESS_TOKEN}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def _post_json(url: str, body: dict, headers: dict | None = None, timeout: int = 30) -> dict:
    data = json.dumps(body).encode()
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ---------------------------------------------------------------------------
# Step 0: Find latest audio event
# ---------------------------------------------------------------------------

def find_latest_audio_event(room_id: str) -> dict | None:
    print(f"\n{SEP}")
    print("STEP 0: Finding latest m.audio event")
    print(f"  Homeserver: {HOMESERVER_URL}")
    print(f"  Room:       {room_id}")
    print(SEP)

    encoded_room = urllib.parse.quote(room_id, safe="")
    filt = urllib.parse.quote(json.dumps({"types": ["m.room.message"]}))
    path = f"/_matrix/client/v3/rooms/{encoded_room}/messages?dir=b&limit=50&filter={filt}"
    try:
        data = _matrix_get(path)
    except Exception as e:
        print(f"  ❌ Matrix API error: {e}")
        return None

    for ev in data.get("chunk", []):
        c = ev.get("content", {})
        if c.get("msgtype") == "m.audio":
            result = {
                "event_id": ev.get("event_id"),
                "sender": ev.get("sender"),
                "body": c.get("body"),
                "url": c.get("url"),
                "ts": ev.get("origin_server_ts"),
            }
            print(f"  ✅ Found audio event:")
            print(f"     event_id: {result['event_id']}")
            print(f"     sender:   {result['sender']}")
            print(f"     body:     {result['body']}")
            print(f"     mxc_url:  {result['url']}")
            return result

    print(f"  ❌ No m.audio events found in last 50 messages")
    return None


# ---------------------------------------------------------------------------
# Step 1: Download audio from Matrix homeserver
# ---------------------------------------------------------------------------

def download_audio(mxc_url: str, event_id: str) -> bytes | None:
    print(f"\n{SEP}")
    print("STEP 1: Downloading audio from Matrix")
    print(f"  MXC:  {mxc_url}")
    print(SEP)

    if not mxc_url.startswith("mxc://"):
        print(f"  ❌ Invalid MXC URL: {mxc_url!r}")
        return None

    mxc_path = mxc_url[len("mxc://"):]
    dl_url = f"{HOMESERVER_URL}/_matrix/client/v1/media/download/{mxc_path}"
    print(f"  URL: {dl_url}")

    req = urllib.request.Request(
        dl_url,
        headers={"Authorization": f"Bearer {BOT_ACCESS_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            audio_bytes = r.read()
        print(f"  ✅ Downloaded {len(audio_bytes):,} bytes")
        return audio_bytes
    except Exception as e:
        print(f"  ❌ Download failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Step 2: Transcribe via whisper.cpp
# ---------------------------------------------------------------------------

def transcribe(audio_bytes: bytes, filename: str = "audio.ogg") -> str | None:
    print(f"\n{SEP}")
    print("STEP 2: whisper.cpp transcription")
    print(f"  URL:  {WHISPER_URL}/inference")
    print(f"  File: {filename}  ({len(audio_bytes):,} bytes)")
    print(SEP)

    # Write to temp file and use multipart via urllib (no requests dependency)
    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".ogg", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        # Build multipart/form-data manually
        boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
        body_parts = []

        def field(name: str, value: str) -> bytes:
            return (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()

        body_parts.append(field("temperature", "0.0"))
        body_parts.append(field("temperature_inc", "0.2"))
        body_parts.append(field("no_speech_thold", WHISPER_NO_SPEECH_THOLD))
        body_parts.append(field("response_format", "json"))

        file_header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: audio/ogg\r\n\r\n"
        ).encode()
        body_parts.append(file_header + audio_bytes + b"\r\n")
        body_parts.append(f"--{boundary}--\r\n".encode())

        body = b"".join(body_parts)

        req = urllib.request.Request(
            f"{WHISPER_URL}/inference",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())

        transcript = data.get("text", "").strip()
        if transcript:
            print(f"  ✅ Transcript ({len(transcript)} chars):")
            print(f"     {transcript[:300]}{'...' if len(transcript) > 300 else ''}")
            return transcript
        else:
            print(f"  ⚠️  Whisper returned empty transcript (no speech detected)")
            return "(no speech detected)"

    except Exception as e:
        print(f"  ❌ Whisper error: {type(e).__name__}: {e}")
        return None
    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Step 3: Discover loaded LLM model
# ---------------------------------------------------------------------------

def discover_llm_model() -> str | None:
    print(f"\n{SEP}")
    print("STEP 3: Discovering loaded LLM model")
    print(f"  URL: {LLM_URL}/models")
    print(SEP)

    try:
        req = urllib.request.Request(f"{LLM_URL}/models")
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"  ❌ Cannot reach {LLM_URL}/models: {e}")
        return None

    for model in data.get("data", []):
        model_id = model.get("id", "")
        status_value = (model.get("status") or {}).get("value", "")
        if status_value != "loaded":
            continue
        args = (model.get("status") or {}).get("args", [])
        if "--embeddings" in args:
            print(f"  ⏭  Skipping embeddings model: {model_id}")
            continue
        print(f"  ✅ Found loaded chat model: {model_id}")
        return model_id

    print(f"  ❌ No loaded non-embeddings model found")
    return None


# ---------------------------------------------------------------------------
# Step 4: Summarize via llama.cpp
# ---------------------------------------------------------------------------

def summarize(transcript: str, model_id: str) -> str | None:
    print(f"\n{SEP}")
    print("STEP 4: llama.cpp summarization")
    print(f"  URL:   {LLM_URL}/chat/completions")
    print(f"  Model: {model_id}")
    print(f"  Input: {transcript[:100]}{'...' if len(transcript) > 100 else ''}")
    print(SEP)

    system_prompt = """\
You are a voice message assistant. Detect the language of the transcript and \
respond entirely in that language — including all section headings.

Your response must follow this exact structure (translate the headings):

**TL;DR:** <one sentence summary>

**<translated "Actions">:**
- <action 1>
- <action 2>

**<translated "Key points">:**
- <aspect 1>
- <aspect 2>

Rules:
- Every word in the response — headings, content, punctuation style — must be \
in the detected language.
- The actions section must only be included if there are explicit \
call-to-actions, requests, or tasks in the transcript. Omit it entirely if \
there are none — do not write the heading with an empty list or "none".
- The key points section lists one bullet per distinct topic or aspect covered \
in the transcript.
- Preserve proper nouns, dates, and numbers exactly as they appear.
- Reply with only the structured response above — no preamble, no explanation, \
no closing remarks.\
"""

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": transcript},
        ],
        "max_tokens": 2000,
        "temperature": 0.3,
    }
    try:
        data = _post_json(
            f"{LLM_URL}/chat/completions",
            payload,
            headers={"Authorization": "Bearer not-needed"},
            timeout=120,
        )
        msg = data["choices"][0]["message"]
        summary = (msg.get("content") or "").strip()
        reasoning = msg.get("reasoning_content") or ""

        if summary:
            print(f"  ✅ Structured summary ({len(summary)} chars):")
            print()
            for line in summary.splitlines():
                print(f"     {line}")
            print()
            if reasoning:
                print(f"  ℹ️  Model reasoning: {len(reasoning)} chars (chain-of-thought, not shown)")
            return summary
        else:
            finish = data["choices"][0].get("finish_reason")
            print(f"  ⚠️  LLM returned empty content (finish_reason={finish!r})")
            return None

    except Exception as e:
        print(f"  ❌ LLM error: {type(e).__name__}: {e}")
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("\nvoice-transcription-bot  —  end-to-end pipeline test")
    print(f"Homeserver:  {HOMESERVER_URL}")
    print(f"Whisper:     {WHISPER_URL}")
    print(f"llama.cpp:   {LLM_URL}")

    if not BOT_ACCESS_TOKEN:
        print("\n❌ BOT_ACCESS_TOKEN not set — cannot authenticate with Matrix")
        sys.exit(1)

    passed = 0
    failed = 0

    # Step 0: find audio event
    audio_event = find_latest_audio_event(MATRIX_ROOM_ID)
    if not audio_event:
        print("\n❌ Cannot proceed without an audio event")
        sys.exit(1)

    # Step 1: download
    audio_bytes = download_audio(audio_event["url"], audio_event["event_id"])
    if audio_bytes:
        passed += 1
    else:
        failed += 1

    # Step 2: transcribe
    transcript = None
    if audio_bytes:
        transcript = transcribe(audio_bytes, filename=audio_event["body"] or "audio.ogg")
        if transcript is not None:
            passed += 1
        else:
            failed += 1

    # Step 3 + 4: discover model and summarize
    model_id = discover_llm_model()
    if model_id and transcript:
        summary = summarize(transcript, model_id)
        if summary:
            passed += 1
        else:
            failed += 1
    else:
        if not model_id:
            print(f"\n  ⚠️  Skipping summarization — no loaded chat model found")
            failed += 1
        elif not transcript:
            print(f"\n  ⚠️  Skipping summarization — no transcript available")

    # Result
    total = passed + failed
    print(f"\n{SEP}")
    print(f"RESULT: {passed}/{total} steps passed")
    if failed == 0:
        print("✅ Full pipeline healthy — transcription + summarization working")
    elif passed == 0:
        print("❌ All steps failed — check service connectivity")
    else:
        print("⚠️  Partial success — check failed steps above")
    print(SEP + "\n")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
