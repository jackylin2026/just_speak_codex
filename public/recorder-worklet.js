// Records into memory and hands the audio over in blocks.
//
// Runs on the audio thread, so it does the conversion too: the samples are turned into the
// 16-bit integers the recogniser wants here, where they are known good, rather than being
// copied across as floats and converted on the main thread. Measured on this platform, a
// Float32Array that came across the port arrived full of NaN — which becomes silence as
// soon as it is written into an Int16Array.
//
// The cap is passed in, because the length of a recording is a product decision, not a
// property of the audio thread.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const limits = options?.processorOptions ?? {};
    this.maxSamples = Math.max(1, Math.round((limits.maxSeconds ?? 600) * sampleRate));
    this.blockSamples = Math.max(1, Math.round(((limits.blockMs ?? 100) * sampleRate) / 1000));
    this.pending = [];
    this.length = 0;
    this.total = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') this.finish();
    };
  }
  flush() {
    if (!this.length) return;
    const pcm = new Int16Array(this.length);
    let offset = 0;
    let energy = 0;
    for (const part of this.pending) {
      for (let index = 0; index < part.length; index++) {
        const value = Math.max(-1, Math.min(1, part[index]));
        const sample = value < 0 ? value * 32768 : value * 32767;
        pcm[offset + index] = sample;
        energy += value * value;
      }
      offset += part.length;
    }
    this.pending = [];
    const level = Math.min(1, Math.sqrt(energy / Math.max(1, pcm.length)) * 8);
    this.length = 0;
    this.port.postMessage({ type: 'samples', pcm, level, peak: this.peak(pcm) });
  }
  peak(pcm) {
    let peak = 0;
    for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
    return peak / 32768;
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ type: 'stopped' });
  }
  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0]?.[0];
    if (input) {
      const remaining = this.maxSamples - this.total;
      const part = input.slice(0, Math.max(0, remaining));
      if (part.length) {
        this.pending.push(part);
        this.length += part.length;
        this.total += part.length;
      }
      if (this.length >= this.blockSamples) this.flush();
      if (this.total >= this.maxSamples) {
        // Not silent: the recording is over, and the person speaking should be told why
        // it stopped rather than discovering a truncated transcript.
        this.port.postMessage({ type: 'limit' });
        this.finish();
      }
    }
    return true;
  }
}
registerProcessor('just-speak-recorder', RecorderProcessor);
