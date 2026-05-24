#!/usr/bin/env python3
"""
Smoke test for the voice-transcription-bot pipeline.

Tests the two local services end-to-end without Matrix or k8s:
  1. whisper.cpp  (flinker:8081) — audio → transcript
  2. llama.cpp    (flinker:8080) — transcript → summary

Usage:
  # Auto-generate a minimal test WAV and run both checks
  python smoke_test.py

  # Use a real audio file (any format whisper.cpp supports)
  python smoke_test.py /path/to/voice_note.ogg

Requirements: only stdlib + requests
  pip install requests
"""

import struct
import sys
import math
import tempfile
import os
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 'requests' is required. Run: pip install requests")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config — match defaults in main.py
# ---------------------------------------------------------------------------

WHISPER_URL = os.environ.get("WHISPER_URL", "http://flinker:8081")
LLM_URL = os.environ.get("LLM_URL", "http://flinker:8080/v1")


def discover_llm_model() -> str | None:
    """
    Query GET /v1/models and return the first loaded non-embeddings model id,
    or None if none available. Mirrors the logic in main.py _discover_llm_model().
    """
    try:
        resp = requests.get(f"{LLM_URL}/models", timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"  ⚠️  Could not reach {LLM_URL}/models: {e}")
        return None

    for model in data.get("data", []):
        model_id = model.get("id", "")
        status_value = (model.get("status") or {}).get("value", "")
        if status_value != "loaded":
            continue
        args = (model.get("status") or {}).get("args", [])
        if "--embeddings" in args:
            continue
        return model_id
    return None


# ---------------------------------------------------------------------------
# Generate a minimal test WAV (1-second 440 Hz sine wave)
# whisper.cpp will likely transcribe it as silence/noise — that's OK for smoke
# ---------------------------------------------------------------------------

def generate_test_wav(path: str, duration_secs: float = 2.0, sample_rate: int = 16000) -> None:
    """Write a minimal PCM WAV file — just enough for whisper.cpp to accept."""
    n_samples = int(sample_rate * duration_secs)
    # 440 Hz sine wave
    samples = [int(32767 * math.sin(2 * math.pi * 440 * i / sample_rate)) for i in range(n_samples)]

    with open(path, "wb") as f:
        # RIFF header
        data_size = n_samples * 2  # 16-bit = 2 bytes per sample
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_size))
        f.write(b"WAVE")
        # fmt chunk
        f.write(b"fmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
        # data chunk
        f.write(b"data")
        f.write(struct.pack("<I", data_size))
        for s in samples:
            f.write(struct.pack("<h", s))


# ---------------------------------------------------------------------------
# Step 1: whisper.cpp transcription
# ---------------------------------------------------------------------------

def test_whisper(audio_path: str) -> str | None:
    print(f"\n{'='*60}")
    print("STEP 1: whisper.cpp transcription")
    print(f"  URL:   {WHISPER_URL}/inference")
    print(f"  File:  {audio_path}")
    print(f"{'='*60}")

    try:
        with open(audio_path, "rb") as f:
            audio_bytes = f.read()

        resp = requests.post(
            f"{WHISPER_URL}/inference",
            files={"file": (Path(audio_path).name, audio_bytes, "audio/wav")},
            data={
                "temperature": "0.0",
                "temperature_inc": "0.2",
                "no_speech_thold": "0.6",
                "response_format": "json",
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        transcript = data.get("text", "").strip()

        print(f"  ✅ Status:     {resp.status_code}")
        print(f"  ✅ Transcript: {transcript!r}")
        return transcript or "(empty — whisper detected no speech)"

    except requests.ConnectionError:
        print(f"  ❌ Connection refused — is whisper.cpp running at {WHISPER_URL}?")
        return None
    except requests.HTTPError as e:
        print(f"  ❌ HTTP {e.response.status_code}: {e.response.text[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return None


# ---------------------------------------------------------------------------
# Step 2: llama.cpp summarization
# ---------------------------------------------------------------------------

def test_llm(transcript: str) -> str | None:
    print(f"\n{'='*60}")
    print("STEP 2: llama.cpp summarization")
    print(f"  URL:    {LLM_URL}/chat/completions")
    print(f"  Discovering model from {LLM_URL}/models ...")
    llm_model = discover_llm_model()
    if llm_model is None:
        print(f"  ❌ No loaded chat model found at {LLM_URL}/models — skipping LLM test")
        return None
    print(f"  Model:  {llm_model} (auto-discovered)")
    print(f"  Input:  {transcript!r}")
    print(f"{'='*60}")

    try:
        resp = requests.post(
            f"{LLM_URL}/chat/completions",
            json={
                "model": llm_model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a concise assistant. Summarize the following voice message transcript "
                            "in 1-3 sentences. Reply only with the summary."
                        ),
                    },
                    {"role": "user", "content": transcript},
                ],
                "max_tokens": 1000,  # Qwen3 needs budget to think + answer
                "temperature": 0.3,
            },
            headers={"Authorization": "Bearer not-needed", "Content-Type": "application/json"},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        msg = data["choices"][0]["message"]
        summary = (msg.get("content") or "").strip()
        reasoning = (msg.get("reasoning_content") or "")

        print(f"  ✅ Status:   {resp.status_code}")
        print(f"  ✅ Summary:  {summary!r}")
        if reasoning:
            print(f"  ℹ️  Thinking: {len(reasoning)} chars (reasoning model)")
        return summary

    except requests.ConnectionError:
        print(f"  ❌ Connection refused — is llama.cpp running at {LLM_URL}?")
        return None
    except requests.HTTPError as e:
        print(f"  ❌ HTTP {e.response.status_code}: {e.response.text[:200]}")
        return None
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("voice-transcription-bot smoke test")
    print(f"whisper.cpp: {WHISPER_URL}")
    print(f"llama.cpp:   {LLM_URL}  (model auto-discovered from /v1/models)")

    # Determine audio file
    if len(sys.argv) > 1:
        audio_path = sys.argv[1]
        if not Path(audio_path).exists():
            print(f"ERROR: file not found: {audio_path}")
            sys.exit(1)
        generated = False
        print(f"\nUsing provided audio: {audio_path}")
    else:
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        audio_path = tmp.name
        tmp.close()
        generate_test_wav(audio_path)
        generated = True
        print(f"\nGenerated test WAV: {audio_path} (2s 440Hz sine)")

    passed = 0
    failed = 0

    # Step 1: whisper.cpp
    transcript = test_whisper(audio_path)
    if transcript is not None:
        passed += 1
    else:
        failed += 1

    # Step 2: llama.cpp (use a fixed text if whisper failed)
    test_text = transcript if transcript else "Please call me back when you get a chance."
    summary = test_llm(test_text)
    if summary is not None:
        passed += 1
    else:
        failed += 1

    # Cleanup
    if generated:
        os.unlink(audio_path)

    # Summary
    print(f"\n{'='*60}")
    print(f"RESULT: {passed}/2 steps passed")
    if failed == 0:
        print("✅ All smoke tests passed — pipeline is healthy")
    elif passed == 0:
        print("❌ Both services unreachable — check flinker connectivity")
    else:
        print("⚠️  Partial failure — check the service that failed above")
    print(f"{'='*60}\n")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
