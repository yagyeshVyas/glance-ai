#!/usr/bin/env python3
"""Local Whisper worker for server/glance-api.js.

Reads one JSON request per line on stdin, answers one JSON line on stdout, so the
model is loaded once and stays warm between 4-second chunks — reloading it per
request would cost seconds every chunk and the transcript would always trail the
conversation.

    {"id": 1, "path": "C:/.../chunk.webm", "lang": "en", "cleanup": true}
    {"id": 1, "text": "what was said", "ms": 640}

Decoding goes through ffmpeg to 16 kHz mono PCM rather than through PyAV, because
faster-whisper's file path calls `av.open(..., metadata_errors=...)` and that
keyword moved between PyAV releases — with ffmpeg on PATH the worker does not
depend on which PyAV wheel happens to be installed. If ffmpeg is missing the
model's own decoder is used instead, and the failure is reported rather than
swallowed.

Environment:
    STT_MODEL    faster-whisper model name or path   (default base.en)
    STT_DEVICE   cpu | cuda                          (default cpu)
    STT_COMPUTE  int8 | float16 | float32            (default int8 on cpu)
    STT_LANG     language code, or empty for auto    (default en)
    FFMPEG       path to ffmpeg, if it is not on PATH

Nothing is downloaded until the first run; then the model is cached under
%USERPROFILE%\\.cache\\huggingface and reused.
"""
import json
import os
import shutil
import subprocess
import sys
import time

SAMPLING_RATE = 16000


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_audio(path):
    """Decode anything ffmpeg understands into float32 mono 16 kHz, or None."""
    ffmpeg = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path,
         "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", str(SAMPLING_RATE), "-"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg: " + (detail[-1] if detail else "no audio decoded"))
    import numpy as np
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    model_name = os.environ.get("STT_MODEL", "base.en") or "base.en"
    device = os.environ.get("STT_DEVICE", "cpu") or "cpu"
    compute = os.environ.get("STT_COMPUTE", "int8" if device == "cpu" else "float16")
    default_lang = os.environ.get("STT_LANG", "en")

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # reported to the server, not raised into the void
        emit({"ready": False, "error": "faster-whisper is not installed: %s" % e})
        return 1

    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute)
    emit({"ready": True, "model": model_name, "device": device, "compute": compute,
          "ffmpeg": bool(os.environ.get("FFMPEG") or shutil.which("ffmpeg")),
          "load_ms": int((time.time() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        path = req.get("path")
        started = time.time()
        try:
            audio = load_audio(path)
            segments, info = model.transcribe(
                audio if audio is not None else path,
                language=req.get("lang") or default_lang or None,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            emit({"id": req.get("id"), "text": text, "ms": int((time.time() - started) * 1000),
                  "lang": getattr(info, "language", None)})
        except Exception as e:
            emit({"id": req.get("id"), "error": str(e)})
        finally:
            if req.get("cleanup") and path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
