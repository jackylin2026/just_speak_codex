import { describe, expect, it, vi } from 'vitest';

import type { Api } from '../src/api';
import type { Recorder } from '../src/audio';
import type { InsertResult, Shell } from '../src/shell/types';
import { Session, type SessionOutcome, type SessionState } from '../src/session';
import type { LocalModel, StreamEvent } from '../shared/types';

/** Stands in for the socket: the test decides what the transcriber answers, and when. */
function fakeSocket() {
  const sent: (string | ArrayBufferView)[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: string | ArrayBufferView) => void sent.push(data),
    close: () => {
      socket.readyState = 3;
      for (const listener of listeners.close ?? []) listener({});
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
    emit(type: string, event: unknown = {}) {
      for (const listener of listeners[type] ?? []) listener(event);
    },
    say(event: StreamEvent) {
      socket.emit('message', { data: JSON.stringify(event) });
    },
    get messages() {
      return sent.map((item) => (typeof item === 'string' ? JSON.parse(item) : item));
    },
  };
  return socket;
}

function harness(
  overrides: {
    polish?: (text: string) => Promise<string>;
    audioCoaching?: boolean;
    speaking?: () => Promise<string>;
    /** What the microphone produced, in samples: the recording's length comes from here. */
    samples?: number;
  } = {},
) {
  const socket = fakeSocket();
  const insertText = vi.fn(
    async (): Promise<InsertResult> => ({ ok: true, detail: 'typed where you were typing' }),
  );
  const api: Api = {
    readiness: vi.fn(),
    polish: vi.fn(overrides.polish ?? (async (text: string) => `polished: ${text}`)),
    prepare: vi.fn(),
    history: vi.fn(),
    appendEntry: vi.fn(),
    rewriteHistory: vi.fn(),
    entries: vi.fn(async () => []),
    checkGrammar: vi.fn(),
    speaking: vi.fn(overrides.speaking ?? (async () => 'What works: clear vowels.')),
    streamUrl: () => 'ws://127.0.0.1:3000/api/stream',
  };
  let onFrame: (frame: Int16Array) => void = () => {};
  let onLevel: (level: number) => void = () => {};
  let onLimit: () => void = () => {};
  const recorder: Recorder = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onFrame: (handler) => (onFrame = handler),
    onLevel: (handler) => (onLevel = handler),
    onLimit: (handler) => (onLimit = handler),
    stats: () => ({
      frames: 0,
      samples: overrides.samples ?? 0,
      contextState: 'running',
      trackLabel: 'test',
      trackMuted: false,
      sourcePeak: 0,
      workletPeak: 0,
    }),
  };
  const shell: Shell = {
    info: vi.fn(),
    onRecordToggle: vi.fn(),
    showRecBar: vi.fn(async () => '820x112'),
    showDetail: vi.fn(async () => '1040x680'),
    openDetail: vi.fn(),
    quit: vi.fn(),
    insertText,
    report: vi.fn(),
    postNotice: vi.fn(),
    onNotice: vi.fn(),
    onShown: vi.fn(),
    postHistoryChanged: vi.fn(),
    onHistoryChanged: vi.fn(),
  };
  const states: SessionState[] = [];
  const outcomes: SessionOutcome[] = [];
  const previews: string[] = [];
  const segments: string[] = [];
  const session = new Session({
    api,
    recorder,
    shell,
    preferences: () => ({
      localModel: 'base.en' as LocalModel,
      audioCoaching: overrides.audioCoaching ?? false,
    }),
    connect: () => socket as unknown as WebSocket,
    handlers: {
      onState: (state) => void states.push(state),
      onSegment: (segment) => void segments.push(segment.text),
      onPreview: (text) => void previews.push(text),
      onLevel: (level) => void onLevel(level),
      onFinished: (outcome) => void outcomes.push(outcome),
    },
  });
  return {
    session,
    socket,
    api,
    recorder,
    shell,
    insertText,
    states,
    outcomes,
    previews,
    segments,
    frame: (frame = new Int16Array([1, 2, 3])) => onFrame(frame),
    limit: () => onLimit(),
    /** Open a socket and get to the point where the transcriber is listening. */
    async listening() {
      const toggle = session.toggle();
      socket.emit('open');
      await toggle;
      socket.say({ type: 'ready', model: 'base.en' });
      await vi.waitFor(() => expect(states).toContain('listening'));
    },
  };
}

describe('a recording', () => {
  it('streams audio, previews each segment, and inserts the polish of the whole', async () => {
    const test = harness();
    await test.listening();

    expect(test.socket.messages[0]).toEqual({ type: 'start', model: 'base.en' });
    test.frame(new Int16Array([5, 6]));
    expect(test.socket.messages[1]).toBeInstanceOf(Int16Array);

    test.socket.say({ type: 'segment', index: 0, text: 'and so my fellow', startMs: 0, endMs: 900 });
    await vi.waitFor(() => expect(test.previews).toEqual(['polished: and so my fellow']));
    expect(test.segments).toEqual(['and so my fellow']);

    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    expect(test.recorder.stop).toHaveBeenCalled();
    test.socket.say({ type: 'done', text: 'and so my fellow Americans' });
    await stopping;

    // The whole transcript is polished once, and that is what lands.
    expect(test.api.polish).toHaveBeenLastCalledWith('and so my fellow Americans');
    expect(test.insertText).toHaveBeenCalledWith('polished: and so my fellow Americans');
    expect(test.outcomes[0]).toMatchObject({
      original: 'and so my fellow Americans',
      polished: 'polished: and so my fellow Americans',
    });
    expect(test.states.at(-1)).toBe('done');
  });

  it('keeps the transcript when polishing fails, and says so', async () => {
    let calls = 0;
    const test = harness({
      polish: async (text) => {
        calls += 1;
        // The preview may succeed; the final polish is what fails.
        if (calls === 1) return `preview: ${text}`;
        throw new Error('Cerebras is unavailable.');
      },
    });
    await test.listening();
    test.socket.say({ type: 'segment', index: 0, text: 'hello', startMs: 0, endMs: 400 });
    await vi.waitFor(() => expect(test.previews).toHaveLength(1));

    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;

    // Never lose the words: the recognised text is what gets inserted.
    expect(test.insertText).toHaveBeenCalledWith('hello there');
    expect(test.outcomes[0].error).toContain('Cerebras is unavailable');
  });

  it('ignores a late answer from a recording that is already over', async () => {
    const test = harness();
    await test.listening();
    const firstSocket = test.socket;

    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(firstSocket.messages).toContainEqual({ type: 'stop' }));
    firstSocket.say({ type: 'done', text: 'first recording' });
    await stopping;
    expect(test.insertText).toHaveBeenCalledTimes(1);

    // A second recording, while the first socket is still delivering.
    await test.listening();
    firstSocket.say({ type: 'done', text: 'a late answer from the old socket' });
    expect(test.insertText).toHaveBeenCalledTimes(1);
    expect(test.outcomes).toHaveLength(1);
  });

  it('stops itself at the limit rather than running for ever', async () => {
    const test = harness();
    await test.listening();
    test.limit();
    await vi.waitFor(() => expect(test.recorder.stop).toHaveBeenCalled());
    expect(test.states).toContain('polishing');
  });
});

describe('what the recording leaves behind', () => {
  it('writes the recording into the history', async () => {
    // Three seconds of audio, and coaching off: the length is a fact about the recording,
    // not about what the app happened to keep of it.
    const test = harness({ samples: 24000 * 3 });
    await test.listening();
    test.frame();
    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;
    // Saving happens after the words have landed, so the insert is not waiting on disk.
    await vi.waitFor(() => expect(test.api.appendEntry).toHaveBeenCalled());

    const [entry] = vi.mocked(test.api.appendEntry).mock.calls[0];
    expect(entry).toMatchObject({
      originalTranscript: 'hello there',
      polished: 'polished: hello there',
      duration: 3,
    });
    expect(entry.speaking).toBeUndefined();
    expect(test.api.speaking).not.toHaveBeenCalled();
  });

  it('coaches the audio first when coaching is on, and saves what it said', async () => {
    const test = harness({ audioCoaching: true });
    await test.listening();
    // A tenth of a second of audio: exactly one frame, and enough to send.
    test.frame(new Int16Array(2400).fill(1000));
    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;
    await vi.waitFor(() => expect(test.api.appendEntry).toHaveBeenCalled());

    expect(test.api.speaking).toHaveBeenCalledTimes(1);
    // The upload is a WAV, because that is what the endpoint validates.
    const [wav] = vi.mocked(test.api.speaking).mock.calls[0];
    expect(new TextDecoder().decode(new Uint8Array(wav.slice(0, 4)))).toBe('RIFF');
    expect(vi.mocked(test.api.appendEntry).mock.calls[0][0].speaking).toBe(
      'What works: clear vowels.',
    );
  });

  it('still records the words when coaching fails', async () => {
    const test = harness({
      audioCoaching: true,
      speaking: async () => {
        throw new Error('OpenAI is unavailable.');
      },
    });
    await test.listening();
    test.frame(new Int16Array(2400).fill(1000));
    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;
    await vi.waitFor(() => expect(test.api.appendEntry).toHaveBeenCalled());

    const [entry] = vi.mocked(test.api.appendEntry).mock.calls[0];
    expect(entry.speaking).toBeUndefined();
    expect(entry.polished).toBe('polished: hello there');
  });

  it('tells the detail box that the history has moved on', async () => {
    const test = harness();
    await test.listening();
    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;
    await vi.waitFor(() => expect(test.shell.postHistoryChanged).toHaveBeenCalledTimes(1));

    // After the write, and the order is the point: the detail box answers this by reading the
    // file, so a call made before the entry was in it would have it read what it already had.
    const written = vi.mocked(test.api.appendEntry).mock.invocationCallOrder[0];
    const told = vi.mocked(test.shell.postHistoryChanged).mock.invocationCallOrder[0];
    expect(told).toBeGreaterThan(written);
  });

  it('says nothing of the kind when the recording never reached the file', async () => {
    const test = harness();
    vi.mocked(test.api.appendEntry).mockRejectedValue(new Error('The disk is full.'));
    await test.listening();
    const stopping = test.session.toggle();
    await vi.waitFor(() => expect(test.socket.messages).toContainEqual({ type: 'stop' }));
    test.socket.say({ type: 'done', text: 'hello there' });
    await stopping;
    await vi.waitFor(() =>
      expect(test.shell.report).toHaveBeenCalledWith(
        'could not save to history: The disk is full.',
      ),
    );

    expect(test.shell.postHistoryChanged).not.toHaveBeenCalled();
  });
});

describe('when it cannot record', () => {
  it('says the transcriber is not running', async () => {
    const test = harness();
    const toggle = test.session.toggle();
    test.socket.emit('error');
    await toggle;
    expect(test.states.at(-1)).toBe('error');
    expect(test.outcomes).toHaveLength(0);
  });

  it('says the microphone was refused', async () => {
    const test = harness();
    test.recorder.start = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const toggle = test.session.toggle();
    test.socket.emit('open');
    await toggle;
    test.socket.say({ type: 'ready', model: 'base.en' });
    await vi.waitFor(() => expect(test.states).toContain('error'));
    expect(test.outcomes[0].error).toContain('Microphone access was refused');
  });

  it('surfaces a transcriber error while still listening', async () => {
    const test = harness();
    await test.listening();
    test.socket.say({ type: 'error', message: 'Prepare this model in Settings, then retry.' });
    expect(test.states.at(-1)).toBe('listening');
    expect(test.outcomes).toHaveLength(0);
  });
});
