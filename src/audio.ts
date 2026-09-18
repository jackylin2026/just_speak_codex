/**
 * The microphone, from permission to PCM.
 *
 * The recorder runs in an AudioWorklet and hands over 16-bit mono samples at 24 kHz in
 * ~100 ms blocks, which is what the streaming endpoint expects: the browser never decides
 * where a sentence ends, and never holds more than a block of audio.
 */

export const SAMPLE_RATE = 24000;
export const BLOCK_MS = 100;
export const MAX_SECONDS = 600;

export interface Recorder {
  start(): Promise<void>;
  /** Stop capturing and release the microphone. Resolves when the worklet has stopped. */
  stop(): Promise<void>;
  onFrame(handler: (frame: Int16Array) => void): void;
  /** The recording hit its length limit and stopped by itself. */
  onLimit(handler: () => void): void;
  /** Level of the most recent block, 0..1, for a meter that reflects the room. */
  onLevel(handler: (level: number) => void): void;
  /**
   * What the microphone actually did. A recording of silence and a recording where the
   * audio thread never ran look identical from the outside, and the difference matters.
   */
  stats(): RecorderStats;
}

export interface RecorderStats {
  frames: number;
  samples: number;
  contextState: string;
  trackLabel: string;
  trackMuted: boolean;
  /** Peak seen at the source node, bypassing the worklet entirely. */
  sourcePeak: number;
  /** Peak the worklet measured in the blocks it posted. */
  workletPeak: number;
}

export function createRecorder(
  options: { maxSeconds?: number; workletUrl?: string } = {},
): Recorder {
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let stream: MediaStream | undefined;
  let analyser: AnalyserNode | undefined;
  let sourcePeak = 0;
  let workletPeak = 0;
  // Resolved by the worklet's own 'stopped' message, so stopping waits for the last block
  // rather than for a guessed duration.
  let ended: Promise<void> | undefined;
  let resolveStopped: (() => void) | undefined;
  let frameHandler: (frame: Int16Array) => void = () => {};
  let limitHandler: () => void = () => {};
  let levelHandler: (level: number) => void = () => {};
  let frames = 0;
  let samples = 0;
  let track: MediaStreamTrack | undefined;

  return {
    async start() {
      context = new AudioContext({ sampleRate: SAMPLE_RATE });
      // A global hotkey is not a user gesture, so whether this can start on its own was a
      // real question once: it can, and this await is what proves it on every platform.
      await context.resume();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        // WebKit throws where Chrome degrades: ask again with everything unconstrained.
        if ((error as DOMException)?.name !== 'OverconstrainedError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      track = stream.getAudioTracks()[0];
      frames = 0;
      samples = 0;
      await context.audioWorklet.addModule(options.workletUrl ?? '/recorder-worklet.js');

      node = new AudioWorkletNode(context, 'just-speak-recorder', {
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        processorOptions: { maxSeconds: options.maxSeconds ?? MAX_SECONDS, blockMs: BLOCK_MS },
      });
      source = context.createMediaStreamSource(stream);
      // A second opinion on the same stream, read straight off the source node: a recording
      // of silence and a recording where the audio thread never ran look identical from the
      // outside, and one of them is a broken microphone.
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      source.connect(node);
      // The worklet has to reach the destination, or the graph is never pulled and no
      // samples are produced at all — measured, the old spike already did this. What must
      // not happen is the microphone being played back through the speakers, so the
      // recording is stopped, not the graph.
      node.connect(context.destination);
      ended = new Promise<void>((resolve) => (resolveStopped = resolve));
      node.port.onmessage = ({ data }) => {
        if (data.type === 'samples') {
          // Already 16-bit PCM, converted on the audio thread: see the worklet's header.
          const pcm = data.pcm as Int16Array;
          frames += 1;
          samples += pcm.length;
          workletPeak = Math.max(workletPeak, Number(data.peak ?? 0));
          levelHandler(Number(data.level ?? 0));
          frameHandler(pcm);
        }
        if (data.type === 'limit') limitHandler();
        if (data.type === 'stopped') resolveStopped?.();
      };
    },

    async stop() {
      node?.port.postMessage('stop');
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 1000))]);
      source?.disconnect();
      analyser?.disconnect();
      node?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      const closing = context;
      context = undefined;
      node = undefined;
      source = undefined;
      stream = undefined;
      await closing?.close();
    },

    onFrame(handler) {
      frameHandler = handler;
    },
    onLimit(handler) {
      limitHandler = handler;
    },
    onLevel(handler) {
      levelHandler = handler;
    },

    stats() {
      const probe = analyser ? new Float32Array(analyser.fftSize) : undefined;
      if (analyser && probe) {
        analyser.getFloatTimeDomainData(probe);
        for (const value of probe) sourcePeak = Math.max(sourcePeak, Math.abs(value));
      }
      return {
        frames,
        samples,
        contextState: context?.state ?? 'closed',
        trackLabel: track?.label ?? 'none',
        trackMuted: track?.muted ?? true,
        sourcePeak,
        workletPeak,
      };
    },
  };
}

/** 16-bit mono PCM at 24 kHz, with the header the API's audio endpoints validate. */
export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index));
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
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (const sample of pcm) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  return buffer;
}
