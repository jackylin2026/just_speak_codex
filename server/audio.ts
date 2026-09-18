import { MAX_AUDIO_BYTES, MAX_SECONDS } from '../shared/types';
import { AppError } from './errors';

/** Only accept the PCM WAV format produced by our recorder; inspect bytes, not MIME alone. */
export function validateAudio(buffer: Buffer): number {
  const invalid = () => new AppError(400, 'Please record mono, 16-bit PCM WAV audio.');
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw invalid();
  if (buffer.length > MAX_AUDIO_BYTES)
    throw new AppError(413, 'The recording is too large. Maximum size is 12 MB.');
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  )
    throw invalid();
  let rate = 0;
  let samples: Buffer | undefined;
  let hasFormat = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw invalid();
    if (name === 'fmt ') {
      if (
        hasFormat ||
        size < 16 ||
        buffer.readUInt16LE(start) !== 1 ||
        buffer.readUInt16LE(start + 2) !== 1 ||
        buffer.readUInt16LE(start + 14) !== 16
      )
        throw invalid();
      rate = buffer.readUInt32LE(start + 4);
      if (
        rate < 16000 ||
        rate > 48000 ||
        buffer.readUInt32LE(start + 8) !== rate * 2 ||
        buffer.readUInt16LE(start + 12) !== 2
      )
        throw invalid();
      hasFormat = true;
    }
    if (name === 'data') {
      if (samples) throw invalid();
      samples = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!hasFormat || !samples || samples.length % 2 !== 0) throw invalid();
  const duration = samples.length / (rate * 2);
  if (duration < 0.4)
    throw new AppError(400, 'That recording is too short. Speak for at least a second.');
  if (duration > MAX_SECONDS + 0.05) throw new AppError(413, 'Keep recordings under two minutes.');
  let energy = 0;
  for (let i = 0; i < samples.length; i += 2) energy += (samples.readInt16LE(i) / 32768) ** 2;
  if (Math.sqrt(energy / (samples.length / 2)) < 0.00015)
    throw new AppError(422, 'No audible sound detected. Check your microphone and try again.');
  return duration;
}
