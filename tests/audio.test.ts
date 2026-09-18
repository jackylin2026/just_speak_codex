import { describe, expect, it } from 'vitest';
import { validateAudio } from '../server/audio';
import { encodeWav, wav } from './wav';

describe('recording format', () => {
  it('encodes a real PCM header and clips samples without overflow', () => {
    const result = Buffer.from(encodeWav(new Float32Array([-2, 0, 2]), 24000));
    expect(result.readUInt32LE(4)).toBe(result.length - 8);
    expect(result.readInt16LE(44)).toBe(-32768);
    expect(result.readInt16LE(46)).toBe(0);
    expect(result.readInt16LE(48)).toBe(32767);
  });
  it('accepts the recorder format through the two-minute boundary', () => {
    expect(validateAudio(wav())).toBe(1);
    expect(validateAudio(wav(120))).toBe(120);
  });
  it('rejects silence, truncation, invalid format, and long recordings', () => {
    expect(() => validateAudio(Buffer.from(encodeWav(new Float32Array(24000), 24000)))).toThrow(
      'No audible sound',
    );
    expect(() => validateAudio(wav().subarray(0, 100))).toThrow('PCM WAV');
    expect(() => validateAudio(Buffer.from('not a recording'))).toThrow('PCM WAV');
    const stereo = wav();
    stereo.writeUInt16LE(2, 22);
    expect(() => validateAudio(stereo)).toThrow('mono');
    expect(() => validateAudio(wav(120.1))).toThrow('two minutes');
  });
});
