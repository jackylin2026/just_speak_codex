"""Worker tests. Standard library only: faster-whisper is faked, so nothing is downloaded."""
import base64
import importlib.util
import io
import json
import math
import os
import struct
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

LOCAL = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, LOCAL / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


worker = load("worker")
RATE = 24000


def tone(ms, amplitude=0.2):
    count = int(RATE * ms / 1000)
    return b"".join(
        struct.pack("<h", int(32767 * amplitude * math.sin(2 * math.pi * 220 * i / RATE)))
        for i in range(count)
    )


def silence(ms):
    return b"\x00\x00" * int(RATE * ms / 1000)


def frames(audio, chunk_ms=100):
    """The recording as the server sends it: several audio operations, not one blob."""
    size = int(RATE * chunk_ms / 1000) * 2
    return [audio[start : start + size] for start in range(0, len(audio), size)]


class FakeEngine:
    def __init__(self, texts=None, speechless=None):
        self.texts = list(texts or [" one", " two", " three", " four", " five"])
        self.speechless = list(speechless or [])
        self.calls = []
        self.sources = []

    def transcribe(self, source, **options):
        self.calls.append(options)
        self.sources.append(source)
        text = self.texts.pop(0) if self.texts else " more"
        probability = self.speechless.pop(0) if self.speechless else 0.1
        return iter([SimpleNamespace(text=text, no_speech_prob=probability)]), None


class WorkerTests(unittest.TestCase):
    def setUp(self):
        worker.model = None
        worker.model_name = None
        worker.session = None
        self.engine = FakeEngine()
        self.factory = Mock(return_value=self.engine)
        self.fake = patch.dict("sys.modules", {"faster_whisper": SimpleNamespace(WhisperModel=self.factory)})
        self.fake.start()
        self.environment = patch.dict(os.environ, {"LOCAL_WHISPER_CACHE": "/tmp/models", "LOCAL_WHISPER_THREADS": "6"})
        self.environment.start()

    def tearDown(self):
        self.fake.stop()
        self.environment.stop()

    def start(self, model="base.en", session_id="s1"):
        return worker.handle({"id": session_id, "operation": "start", "model": model})

    def audio(self, request_id, audio):
        """Feed a recording and collect the events it produced."""
        events = []
        for frame in frames(audio):
            events.extend(
                worker.handle(
                    {"id": request_id, "operation": "audio", "audio": base64.b64encode(frame).decode()}
                )
            )
        return events

    # --- one-shot, as before -----------------------------------------------------

    def test_prepare_reuses_the_loaded_model(self):
        worker.handle({"id": "1", "operation": "prepare", "model": "base.en"})
        worker.handle({"id": "2", "operation": "prepare", "model": "base.en"})
        self.factory.assert_called_once()
        self.assertEqual(self.factory.call_args.kwargs["device"], "cpu")
        self.assertEqual(self.factory.call_args.kwargs["compute_type"], "int8")

    def test_one_shot_transcription_never_downloads_and_consumes_segments(self):
        responses = worker.handle(
            {
                "id": "1",
                "operation": "transcribe",
                "model": "base.en",
                "audio": base64.b64encode(b"wav").decode(),
            }
        )
        self.assertEqual(responses[0]["text"], "one")
        self.assertTrue(self.factory.call_args.kwargs["local_files_only"])
        self.assertEqual(self.engine.calls[0]["task"], "transcribe")
        self.assertEqual(self.engine.calls[0]["language"], "en")

    def test_model_changes_load_a_new_model_and_arbitrary_paths_are_rejected(self):
        worker.handle({"id": "1", "operation": "prepare", "model": "base.en"})
        worker.handle({"id": "2", "operation": "prepare", "model": "small.en"})
        self.assertEqual(self.factory.call_count, 2)
        with self.assertRaises(ValueError):
            worker.handle({"id": "3", "operation": "prepare", "model": "../../untrusted"})

    # --- streaming ---------------------------------------------------------------

    def test_segments_close_as_they_are_spoken_and_stop_answers_with_the_whole_text(self):
        self.assertEqual(self.start(), [{"id": "s1", "started": True}])
        events = self.audio("s1", tone(900) + silence(700) + tone(900) + silence(700))
        # Both utterances had paused long enough to close while the recording continued.
        self.assertEqual([event["event"] for event in events], ["segment", "segment"])
        self.assertEqual([event["index"] for event in events], [0, 1])
        self.assertEqual([event["text"] for event in events], ["one", "two"])
        self.assertLess(events[0]["startMs"], events[1]["startMs"])
        self.assertTrue(all(event["endMs"] > event["startMs"] for event in events))

        # A third utterance is still open when the speaker stops.
        events = self.audio("s1", tone(600))
        self.assertEqual(events, [])
        responses = worker.handle({"id": "s1", "operation": "stop"})
        self.assertEqual([item["event"] for item in responses[:-1]], ["segment"])
        self.assertEqual(responses[-1], {"id": "s1", "done": True, "text": "one two three"})
        self.assertIsNone(worker.session)

    def test_segments_reach_the_model_as_something_it_can_decode(self):
        # A segment is bare PCM, and the decoder reads containers: handing it samples
        # directly is an InvalidDataError, which is how this was found.
        self.start()
        self.audio("s1", tone(900) + silence(700))
        container = self.engine.sources[0].read()
        self.assertTrue(container.startswith(b"RIFF"))
        self.assertEqual(container[8:12], b"WAVE")
        rate = struct.unpack("<I", container[24:28])[0]
        self.assertEqual(rate, worker.SAMPLE_RATE)
        self.assertEqual(struct.unpack("<H", container[22:24])[0], 1)  # mono
        samples = container[44:]
        self.assertGreater(len(samples), RATE)  # the utterance is in there
        self.assertEqual(len(samples) % 2, 0)

    def test_the_previous_segment_is_context_for_the_next_one(self):
        self.start()
        self.audio("s1", tone(900) + silence(700))
        self.audio("s1", tone(900) + silence(700))
        prompts = [call.get("initial_prompt") for call in self.engine.calls]
        self.assertIsNone(prompts[0])
        self.assertEqual(prompts[1], "one")

    def test_a_segment_the_model_calls_speechless_is_dropped(self):
        self.engine = FakeEngine(speechless=[0.95, 0.1])
        self.factory.return_value = self.engine
        self.start()
        events = self.audio("s1", tone(900) + silence(700) + tone(900) + silence(700))
        self.assertEqual([event["text"] for event in events], ["two"])
        self.assertEqual([event["index"] for event in events], [1])
        responses = worker.handle({"id": "s1", "operation": "stop"})
        self.assertEqual(responses[-1]["text"], "two")

    def test_audio_that_is_too_short_to_be_speech_is_never_sent_to_the_model(self):
        self.start()
        events = self.audio("s1", tone(120) + silence(800))
        self.assertEqual(events, [])
        self.assertEqual(self.engine.calls, [])

    def test_cancel_throws_the_session_away_without_taking_the_worker_with_it(self):
        self.start()
        self.audio("s1", tone(600))
        self.assertEqual(
            worker.handle({"id": "s1", "operation": "cancel"}), [{"id": "s1", "cancelled": True}]
        )
        self.assertIsNone(worker.session)
        # The same process keeps working, which is the point: no model reload, no kill.
        self.assertEqual(self.factory.call_count, 1)
        self.start(session_id="s2")
        self.audio("s2", tone(900) + silence(700))
        responses = worker.handle({"id": "s2", "operation": "stop"})
        self.assertEqual(responses[-1]["text"], "one")
        self.assertEqual(self.factory.call_count, 1)

    def test_audio_without_a_session_is_refused(self):
        with self.assertRaises(ValueError):
            worker.handle({"id": "s1", "operation": "audio", "audio": base64.b64encode(b"x").decode()})
        with self.assertRaises(ValueError):
            worker.handle({"id": "s1", "operation": "stop"})
        self.start()
        with self.assertRaises(ValueError):
            worker.handle({"id": "other", "operation": "audio", "audio": base64.b64encode(b"x").decode()})

    def test_a_second_session_cannot_open_on_top_of_one(self):
        self.start()
        with self.assertRaises(ValueError):
            self.start(session_id="s2")

    def test_lines_on_stdout_stay_one_object_per_line_and_leak_nothing(self):
        captured = io.StringIO()
        lines = [
            json.dumps({"id": "1", "operation": "start", "model": "base.en"}),
            json.dumps({"id": "1", "operation": "audio", "audio": base64.b64encode(tone(900) + silence(700)).decode()}),
            json.dumps({"id": "1", "operation": "stop"}),
            json.dumps({"id": "2", "operation": "audio", "audio": base64.b64encode(b"x").decode()}),
        ]
        with patch.object(sys, "stdin", io.StringIO("\n".join(lines) + "\n")), patch.object(
            sys, "stdout", captured
        ):
            worker.main()
        parsed = [json.loads(line) for line in captured.getvalue().splitlines()]
        self.assertEqual(
            [item.get("event") or item.get("done") or item.get("error") or item.get("started") for item in parsed],
            [True, "segment", True, "transcribe_failed"],
        )
        self.assertEqual(parsed[0]["id"], "1")
        self.assertEqual(parsed[-1]["id"], "2")
        # Failures are reported as codes: no audio, no paths, no exception text.
        self.assertNotIn("x", captured.getvalue().splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
