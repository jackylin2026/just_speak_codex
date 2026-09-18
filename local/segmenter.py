"""Splits a continuous stream of speech into segments, between pauses.

The browser sends audio and never decides where a sentence ends; this decides. It is
deliberately dependency-free — standard library only — so the boundary logic can be
tested without a model or a sound card, and so a change here cannot break inference.

Input is 16-bit mono PCM at the samplerate given to the constructor. A segment closes
when the level has stayed below the speech threshold for HANG_MS, or when the segment
reaches MAX_SEGMENT_MS, whichever comes first. The tail of the closing silence is kept,
because Whisper mishears a word cut off at its final phoneme.

The threshold sits a factor above the ambient level measured over the opening NOISE_MS.
Two details are deliberate. The opening measurement starts from the floor, not from
whatever the first frames happen to contain, so dictation that begins immediately is heard
instead of being calibrated away against the speaker's own voice. And only frames that are
*not* speech teach it the room, so calibration cannot complete on a sentence and then gate
that sentence out.

This is a gate on pauses, not a voice detector. If the room becomes much louder
mid-recording the gate opens on it, because by level alone that is indistinguishable from
someone talking — which is what the worker's no-speech guard is for: a segment Whisper
reports as speechless is dropped rather than transcribed into "Thank you."
"""
from dataclasses import dataclass

FRAME_MS = 20
NOISE_MS = 300
HANG_MS = 400
MAX_SEGMENT_MS = 15000
MIN_SEGMENT_MS = 300
TAIL_MS = 200

NOISE_FACTOR = 3.0
FLOOR = 0.004
CEILING = 0.04


@dataclass
class Segment:
    index: int
    start_ms: int
    end_ms: int
    audio: bytes

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


def _rms(frame: bytes) -> float:
    """Root mean square of little-endian 16-bit samples, normalised to 0..1."""
    total = 0
    count = len(frame) // 2
    for index in range(count):
        sample = int.from_bytes(frame[index * 2 : index * 2 + 2], "little", signed=True)
        total += sample * sample
    if not count:
        return 0.0
    return (total / count) ** 0.5 / 32768.0


class Segmenter:
    def __init__(self, sample_rate: int = 24000):
        self.sample_rate = sample_rate
        self.frame_bytes = max(2, int(sample_rate * FRAME_MS / 1000) * 2)
        self._residual = b""
        self._samples = 0
        self._index = 0
        self._noise = FLOOR
        self._threshold = FLOOR * NOISE_FACTOR
        self._calibrating = True
        self._calibration_ms = 0
        self._calibration: list[float] = []
        self._open: list[bytes] | None = None
        self._open_start = 0
        self._open_samples = 0
        self._spoken_samples = 0
        self._silence = 0

    @property
    def threshold(self) -> float:
        """The level a frame must reach to count as speech."""
        return self._threshold

    def _observe(self, level: float) -> None:
        """Learn the room from a frame that is not speech, until the window closes."""
        if not self._calibrating:
            return
        self._calibration.append(level)
        self._calibration_ms += FRAME_MS
        if self._calibration_ms >= NOISE_MS:
            # Mean of the opening window: every frame in it was quiet, by definition.
            self._noise = sum(self._calibration) / len(self._calibration)
            self._calibrating = False
            self._threshold = min(CEILING, max(FLOOR, self._noise * NOISE_FACTOR))

    def push(self, pcm: bytes) -> list[Segment]:
        """Feed audio; returns whichever segments closed as a result."""
        self._residual += pcm
        closed: list[Segment] = []
        while len(self._residual) >= self.frame_bytes:
            frame, self._residual = (
                self._residual[: self.frame_bytes],
                self._residual[self.frame_bytes :],
            )
            closed.extend(self._consume(frame))
        return closed

    def flush(self) -> list[Segment]:
        """Close whatever is open, including a short trailing fragment."""
        closed: list[Segment] = []
        if self._residual:
            frame, self._residual = self._residual, b""
            closed.extend(self._consume(frame))
        if self._open is not None:
            closed.extend(self._close(trimmed=False))
        return closed

    def _consume(self, frame: bytes) -> list[Segment]:
        level = _rms(frame)
        spoken = level >= self._threshold

        if not spoken:
            self._observe(level)
            self._samples += len(frame)
            if self._open is None:
                return []
            # Below threshold while speaking: this silence stays in the segment for now
            # and is trimmed to TAIL_MS when the segment closes.
            self._open.append(frame)
            self._open_samples += len(frame)
            self._silence += len(frame)
            if self._silence * 1000 / (self.sample_rate * 2) >= HANG_MS:
                return self._close(trimmed=True)
            return []

        if self._open is None:
            self._open = []
            self._open_start = self._samples
            self._open_samples = 0
            self._spoken_samples = 0
        self._silence = 0
        self._open.append(frame)
        self._open_samples += len(frame)
        self._spoken_samples += len(frame)
        self._samples += len(frame)
        if self._open_samples * 1000 / (self.sample_rate * 2) >= MAX_SEGMENT_MS:
            return self._close(trimmed=False)
        return []

    def _close(self, trimmed: bool) -> list[Segment]:
        assert self._open is not None
        frames = self._open
        samples = self._open_samples
        spoken_ms = self._spoken_samples * 1000 / (self.sample_rate * 2)
        start_ms = round(self._open_start * 1000 / (self.sample_rate * 2))
        self._open = None
        self._silence = 0
        self._spoken_samples = 0

        audio = b"".join(frames)
        if trimmed:
            keep = max(0, samples - int(self.sample_rate * (HANG_MS - TAIL_MS) / 1000) * 2)
            audio = audio[:keep]

        if spoken_ms < MIN_SEGMENT_MS:
            # Not enough speech to be an utterance: a cough, a door, or the near-silence
            # Whisper answers with "Thank you." The trailing silence does not count
            # towards this, or a cough followed by a breath would qualify.
            return []
        end_ms = start_ms + round(len(audio) / 2 * 1000 / self.sample_rate)
        segment = Segment(index=self._index, start_ms=start_ms, end_ms=end_ms, audio=audio)
        self._index += 1
        return [segment]
