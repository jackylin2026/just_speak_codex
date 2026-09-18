/**
 * A stand-in for the recorder's encoder until `src/audio.ts` is ported with the rec bar.
 * It produces exactly the format the recorder produces — 24 kHz, 16-bit, mono PCM —
 * because the server's validation is written against those bytes.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return buffer;
}

export function wav(seconds = 1, rate = 24000) {
  const samples = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < samples.length; i++)
    samples[i] = Math.sin((i / rate) * 440 * Math.PI * 2) * 0.1;
  return Buffer.from(encodeWav(samples, rate));
}
