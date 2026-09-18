"""Segmenter tests. Standard library only: no model, no audio files, no numpy."""
import importlib.util
import math
import random
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "segmenter", Path(__file__).with_name("segmenter.py")
)
segmenter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(segmenter)

RATE = 24000


def tone(ms, amplitude=0.2, frequency=220.0):
    count = int(RATE * ms / 1000)
    return b"".join(
        struct.pack("<h", int(32767 * amplitude * math.sin(2 * math.pi * frequency * i / RATE)))
        for i in range(count)
    )


def silence(ms):
    return b"\x00\x00" * int(RATE * ms / 1000)


def noise(ms, amplitude=0.002, seed=1):
    """Well below the threshold floor: room tone, not speech."""
    generator = random.Random(seed)
    return b"".join(
        struct.pack("<h", int(32767 * amplitude * generator.uniform(-1, 1)))
        for _ in range(int(RATE * ms / 1000))
    )


def feed(seg, audio, chunk_ms=100):
    """Push audio the way the server does, in small frames."""
    size = int(RATE * chunk_ms / 1000) * 2
    segments = []
    for start in range(0, len(audio), size):
        segments.extend(seg.push(audio[start : start + size]))
    return segments


class SegmenterTests(unittest.TestCase):
    def test_one_utterance_between_pauses(self):
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, noise(300) + tone(1200) + silence(800))
        self.assertEqual(len(segments), 1)
        only = segments[0]
        self.assertEqual(only.index, 0)
        self.assertAlmostEqual(only.duration_ms, 1200 + segmenter.TAIL_MS, delta=60)
        self.assertAlmostEqual(only.start_ms, 300, delta=60)
        self.assertGreater(only.end_ms, 1400)
        self.assertLess(only.end_ms, 1750)

    def test_three_utterances_are_numbered_without_gaps(self):
        seg = segmenter.Segmenter(RATE)
        audio = noise(300)
        for _ in range(3):
            audio += tone(900) + silence(700)
        segments = feed(seg, audio)
        self.assertEqual([item.index for item in segments], [0, 1, 2])
        self.assertTrue(all(item.start_ms < item.end_ms for item in segments))

    def test_a_cough_is_not_a_segment_but_a_short_word_is(self):
        # The length guard counts speech, not the silence that follows it, or a cough
        # plus a breath would pass for an utterance.
        cough = feed(segmenter.Segmenter(RATE), noise(300) + tone(120) + silence(800))
        self.assertEqual(len(cough), 0)
        word = feed(segmenter.Segmenter(RATE), noise(300) + tone(500) + silence(800))
        self.assertEqual([item.index for item in word], [0])

    def test_long_speech_is_cut_so_text_keeps_flowing(self):
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, noise(300) + tone(34000))
        self.assertGreaterEqual(len(segments), 2)
        for item in segments[:-1]:
            self.assertLessEqual(item.duration_ms, segmenter.MAX_SEGMENT_MS + 60)
        self.assertEqual([item.index for item in segments], list(range(len(segments))))

    def test_a_room_louder_than_the_floor_sets_the_gate_above_it(self):
        # Room tone well above the absolute floor, and still far below speech: the opening
        # window is what keeps the gate above it.
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, noise(400, amplitude=0.01, seed=7) + noise(3000, amplitude=0.01, seed=7) + silence(500))
        self.assertEqual(len(segments), 0)
        self.assertGreater(seg.threshold, 0.012)

    def test_a_long_sentence_is_cut_by_length_and_not_by_the_gate(self):
        # Only quiet frames teach the gate the room, so a sustained sentence cannot lift
        # the threshold until it cuts itself off.
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, noise(300) + tone(17000))
        self.assertEqual([item.index for item in segments], [0])
        self.assertAlmostEqual(
            segments[0].duration_ms, segmenter.MAX_SEGMENT_MS, delta=60
        )
        self.assertLess(seg.threshold, 0.05)

    def test_speech_immediately_after_the_tone_is_still_heard(self):
        # Dictation often starts at once: calibration on the speaker's own voice must not
        # raise the threshold above it.
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, tone(1500) + silence(700))
        self.assertEqual(len(segments), 1)
        self.assertGreater(segments[0].duration_ms, 1400)

    def test_flush_closes_the_last_utterance(self):
        seg = segmenter.Segmenter(RATE)
        self.assertEqual(feed(seg, noise(300) + tone(900)), [])
        segments = seg.flush()
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0].index, 0)

    def test_frame_boundaries_do_not_change_the_result(self):
        audio = noise(300) + tone(1000) + silence(700) + tone(800) + silence(700)
        aligned = feed(segmenter.Segmenter(RATE), audio, chunk_ms=100)
        awkward = feed(segmenter.Segmenter(RATE), audio, chunk_ms=17)
        self.assertEqual(
            [(item.index, item.start_ms, item.end_ms, len(item.audio)) for item in aligned],
            [(item.index, item.start_ms, item.end_ms, len(item.audio)) for item in awkward],
        )

    def test_audio_is_the_format_whisper_is_given(self):
        seg = segmenter.Segmenter(RATE)
        segments = feed(seg, noise(300) + tone(1000) + silence(700))
        self.assertEqual(len(segments[0].audio) % 2, 0)
        self.assertEqual(len(segments[0].audio) / 2 / RATE * 1000, segments[0].duration_ms)


if __name__ == "__main__":
    unittest.main()
