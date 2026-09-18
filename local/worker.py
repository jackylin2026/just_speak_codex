"""Persistent CPU worker. JSON lines on stdio; recordings only exist in memory.

Two ways in. `transcribe` takes one clip and answers with its text, which is what the
one-shot endpoint uses. A *session* is the streaming path: `start` opens it, `audio`
carries the recording as it arrives, and segments close on their own as the speaker
pauses, each answered with an event as it is transcribed. `stop` flushes the last one and
answers with the whole transcript; `cancel` throws the session away.

A cancel is honoured at the next read boundary, which is to say after the segment being
transcribed finishes: there is no way to interrupt native inference mid-call, and killing
the process to stop one segment would cost a model reload on the next recording. Killing
is the caller's last resort for a worker that has stopped reading altogether.
"""
import base64
import gc
import io
import json
import os
import struct
import sys
import traceback

# The worker imports its neighbour by name, which normally works because Python puts the
# script's own directory on the path. It does not when the module is loaded by path
# instead — by a test harness, or by anything that treats worker.py as a library — so say
# where to look rather than depending on how this file was started.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from segmenter import Segmenter

ALLOWED_MODELS = ("base.en", "small.en")
# What the recorder produces, and therefore what a segment's samples are.
SAMPLE_RATE = 24000
# Whisper answers near-silence with confident inventions ("Thank you."). A segment it
# reports as speechless is dropped rather than shown.
NO_SPEECH_LIMIT = 0.6
# Context handed to the next segment so it keeps names and numbers straight across a pause.
PROMPT_CHARS = 200

model = None
model_name = None
session = None


def load_model(name, allow_download):
    global model, model_name
    if name not in ALLOWED_MODELS:
        raise ValueError("unsupported_model")
    if model is not None and model_name == name:
        return model
    from faster_whisper import WhisperModel

    # Keep at most one model in memory, including when switching to the larger one.
    model = None
    model_name = None
    gc.collect()
    model = WhisperModel(
        name,
        device="cpu",
        compute_type="int8",
        cpu_threads=int(os.environ.get("LOCAL_WHISPER_THREADS", "6")),
        num_workers=1,
        download_root=os.environ["LOCAL_WHISPER_CACHE"],
        local_files_only=not allow_download,
    )
    model_name = name
    return model


def engine_for(name, allow_download):
    return load_model(name, allow_download=allow_download)


def as_wav(pcm, sample_rate=SAMPLE_RATE):
    """Wrap raw samples in a WAV header.

    Segments are bare PCM, and the decoder reads containers — it will not take 24 kHz
    samples and resample them to the 16 kHz the model wants unless they arrive wrapped in
    something it can decode.
    """
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        len(pcm),
    ) + pcm


def transcribe_clip(engine, audio, prompt=None):
    """Text of one clip, or None when it holds nothing worth showing."""
    segments, _ = engine.transcribe(
        io.BytesIO(audio),
        language="en",
        task="transcribe",
        beam_size=1,
        temperature=0,
        condition_on_previous_text=False,
        initial_prompt=prompt,
    )
    # Consuming the generator is required: otherwise inference has not actually run.
    parts = []
    speechless = 0.0
    for segment in segments:
        parts.append(segment.text)
        speechless = max(speechless, getattr(segment, "no_speech_prob", 0.0))
    text = "".join(parts).strip()
    if not text or speechless > NO_SPEECH_LIMIT:
        return None
    return text


def prompt_for(texts):
    return " ".join(texts)[-PROMPT_CHARS:] or None


def emit_closed(closed):
    """Transcribe each closed segment in order and return its events."""
    events = []
    for segment in closed:
        text = transcribe_clip(model, as_wav(segment.audio), prompt_for(session["texts"]))
        if not text:
            continue
        session["texts"].append(text)
        events.append(
            {
                "id": session["id"],
                "event": "segment",
                "index": segment.index,
                "text": text,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
            }
        )
    return events


def begin(name, session_id):
    global session
    engine_for(name, allow_download=False)
    session = {
        "id": session_id,
        "model": name,
        "segmenter": Segmenter(SAMPLE_RATE),
        "texts": [],
    }
    return [{"id": session_id, "started": True}]


def handle(request):
    """Returns the objects to write back, in the order they should be sent."""
    global session
    operation = request.get("operation")
    if operation == "prepare":
        engine_for(request["model"], allow_download=True)
        return [{"id": request.get("id"), "ready": True}]

    if operation == "transcribe":
        raw = base64.b64decode(request["audio"], validate=True)
        if len(raw) > 12 * 1024 * 1024:
            raise ValueError("invalid_audio")
        text = transcribe_clip(engine_for(request["model"], False), raw)
        return [{"id": request.get("id"), "text": text or ""}]

    if operation == "start":
        if session is not None:
            raise ValueError("session_open")
        return begin(request["model"], request["id"])

    if session is None or request.get("id") != session["id"]:
        raise ValueError("no_session")

    if operation == "audio":
        raw = base64.b64decode(request["audio"], validate=True)
        return emit_closed(session["segmenter"].push(raw))

    if operation == "stop":
        events = emit_closed(session["segmenter"].flush())
        text = " ".join(session["texts"])
        events.append({"id": session["id"], "done": True, "text": text})
        session = None
        return events

    if operation == "cancel":
        session = None
        return [{"id": request.get("id"), "cancelled": True}]

    raise ValueError("unsupported_operation")


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            responses = handle(request)
        except ImportError:
            responses = [{"error": "dependencies"}]
        except Exception:
            # Never echo decoder exceptions, input audio, filesystem paths, or transcripts.
            # They go to stderr, which the server discards, and only when asked for.
            if os.environ.get("JUST_SPEAK_DEBUG"):
                traceback.print_exc()
            responses = [
                {
                    "error": "prepare_failed"
                    if request.get("operation") == "prepare"
                    else "transcribe_failed"
                }
            ]
        for response in responses:
            print(json.dumps({"id": request.get("id"), **response}), flush=True)


if __name__ == "__main__":
    main()
