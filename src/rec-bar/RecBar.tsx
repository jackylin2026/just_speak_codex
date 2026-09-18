import { useEffect, useMemo, useRef, useState } from 'react';

import { createApi, type Api } from '../api';
import { createRecorder, type Recorder } from '../audio';
import { loadPreferences } from '../preferences';
import { createShell } from '../shell';
import type { Shell, ShellInfo } from '../shell/types';
import { Session, type SessionOutcome, type SessionState } from '../session';

/**
 * The rec bar: the whole product surface while you are speaking.
 *
 * It is never focusable — that is what keeps your typing going where it was — so it can
 * only offer buttons, and everything it shows has to be readable without any interaction:
 * what is being heard and what it became. What it *says* is another window's job: the
 * detail box's status strip is where a paste that did not land is written down, and this
 * window only borrows the room to say it.
 *
 * Two lines of text is all the room there is, and a long recording is longer than that, so
 * the text scrolls — under buttons, because a window that cannot be focused cannot be
 * scrolled with a keyboard, and the pointer is not guaranteed to be over it either.
 */
export function RecBar() {
  const shell = useMemo<Shell>(() => createShell(), []);
  const [info, setInfo] = useState<ShellInfo>();
  const api = useMemo<Api | undefined>(() => (info ? createApi(info.port) : undefined), [info]);
  const recorder = useMemo<Recorder>(() => createRecorder(), []);

  const [status, setStatus] = useState<SessionState>('idle');
  const [preview, setPreview] = useState('');
  const [transcript, setTranscript] = useState('');
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | undefined>(undefined);
  const peakRef = useRef(0);
  /** Set while the text is longer than the two lines that fit, and where it is in them. */
  const [scrolled, setScrolled] = useState({ hidden: true, up: false, down: false });
  const textBox = useRef<HTMLDivElement>(null);

  /**
   * What this window has to say, said where it can be read.
   *
   * There is no line for it here: this window has room for what you said and what it
   * became, and the detail box has a status strip for everything else. A complaint is the
   * reason to speak at all — a paste that did not land, a microphone that was not there —
   * and a recording that went through is worth telling it only that the last one is over.
   */
  const complain = (text: string) => void shell.postNotice({ text, tone: 'error' });
  const settle = () => void shell.postNotice(undefined);

  // The session gets its handlers once, at construction; they reach React through a ref so
  // that a re-render cannot swap them out mid-recording.
  const handlerRef = useRef({
    onState(state: SessionState, why?: string) {
      setStatus(state);
      if (why) complain(why);
      if (state === 'connecting') {
        startedAt.current = Date.now();
        setPreview('');
        setTranscript('');
        setLevel(0);
        setElapsed(0);
        peakRef.current = 0;
      }
    },
    onSegment(segment: { text: string }) {
      setTranscript((current) => (current ? `${current} ${segment.text}` : segment.text));
    },
    onPreview(text: string) {
      setPreview(text);
    },
    onLevel(value: number) {
      setLevel(value);
      // Remembered so that a recording of pure silence can be recognised as one: the
      // microphone hearing nothing is otherwise indistinguishable from a bad transcript.
      if (value > peakRef.current) peakRef.current = value;
    },
    onFinished(outcome: SessionOutcome) {
      setPreview(outcome.polished || outcome.original);
      setTranscript(outcome.original);
      const complaint =
        outcome.error ??
        (peakRef.current < 0.01 ? 'The microphone heard nothing.' : undefined) ??
        (outcome.insert?.ok ? undefined : outcome.insert?.detail);
      // A recording that went through is not news, but it is the end of the last
      // complaint: nothing else clears the strip while you are speaking.
      if (complaint) complain(complaint);
      else settle();
      const stats = recorder.stats();
      void shell.report(
        `${outcome.insert?.ok ? 'inserted' : 'not inserted'}: ${outcome.insert?.detail ?? outcome.error ?? ''} · ` +
          `${(stats.samples / 24000).toFixed(1)}s recorded, level peak ${stats.workletPeak.toFixed(3)}`,
      );
    },
  });

  const session = useMemo(
    () =>
      api
        ? new Session({
            api,
            recorder,
            shell,
            handlers: handlerRef.current,
            preferences: loadPreferences,
          })
        : undefined,
    [api, recorder, shell],
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let unsubscribe = () => {};
    // A window that is never focused cannot be opened in a browser and inspected, so
    // anything that goes wrong in here has to be said out loud, in the terminal.
    const onError = (event: ErrorEvent) =>
      void shell.report(`JS ERROR: ${event.message} @ ${event.filename}:${event.lineno}`);
    window.addEventListener('error', onError);
    void (async () => {
      try {
        const shellInfo = await shell.info();
        setInfo(shellInfo);
        if (shellInfo.problem) complain(shellInfo.problem);
        await shell.report(`rec-bar loaded, api port ${shellInfo.port}`);
        if (shellInfo.problem) await shell.report(`shell problem: ${shellInfo.problem}`);
        unsubscribe = await shell.onRecordToggle(() => void sessionRef.current?.toggle());
        // Not requestAnimationFrame: this window is created hidden, and a page that is not
        // visible never gets a frame callback — the rec bar simply never appeared.
        // Asking once is enough: the shell keeps asserting the geometry until the window
        // actually measures right.
        await shell.showRecBar();
        setTimeout(
          () =>
            void shell.report(
              `page ${window.innerWidth}x${window.innerHeight} in a ${window.outerWidth}x${window.outerHeight} window, ` +
                `document ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}, ` +
                `body ${document.body.offsetHeight}`,
            ),
          700,
        );
        const readiness = await createApi(shellInfo.port).readiness();
        await shell.report(
          `api ready · local ${readiness.local?.status ?? 'unknown'} · keys openai ${readiness.openai} cerebras ${readiness.cerebras}`,
        );
        // Nothing warns in this window any more, so the one thing it used to say about a
        // model that cannot transcribe goes where the rest of the messages go.
        const warning = readinessMessage(readiness.local?.status);
        if (warning) complain(warning);
      } catch (error) {
        await shell.report(`rec-bar failed to start: ${(error as Error).message}`);
      }
    })();
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  useEffect(() => {
    if (status !== 'listening' && status !== 'connecting') return;
    const ticker = window.setInterval(() => {
      if (startedAt.current) setElapsed((Date.now() - startedAt.current) / 1000);
    }, 250);
    return () => window.clearInterval(ticker);
  }, [status]);

  const listening = status === 'listening' || status === 'connecting';
  const text = preview || transcript;

  /**
   * What the box is showing, so the buttons can offer the directions that exist.
   *
   * Measured, never tracked: the browser is the only thing that knows how wide the words
   * wrapped, and it knows it only once the box has been laid out. Two things are worth
   * asking again after — the text changing, and the box's own size changing, both below.
   * Scroll position is never reset here: the browser clamps it when the text shrinks, which
   * is what a new recording does, and keeping it is what stops a segment arriving mid-read
   * from yanking the words out from under someone halfway down a long sentence.
   */
  const measure = () => {
    const box = textBox.current;
    if (!box) return;
    // Before the window has been laid out the box has no width, and every word in it takes
    // a line of its own: the one-line placeholder measured 126 pixels tall that way, which
    // reads as overflow and put a scroller over it before a word had been spoken. Nothing
    // measured there is true, so wait for a width.
    if (!box.clientWidth) return;
    setScrolled({
      hidden: box.scrollHeight <= box.clientHeight + 1,
      up: box.scrollTop > 0,
      down: box.scrollTop + box.clientHeight < box.scrollHeight - 1,
    });
  };

  // A new recording clears the text; a segment, or the polish, replaces it. The layout is
  // current by the time this runs, which is the first moment the height means anything.
  useEffect(measure, [text]);

  useEffect(() => {
    const box = textBox.current;
    if (!box) return;
    // The other half, and the half that was missing: the box's own size. The window is
    // created hidden, so its first real layout arrives as a resize — and so does every
    // later one, including the width this box gives up when the scroller appears beside it.
    // Text getting longer moves none of that.
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const scrollBy = (lines: 1 | -1) => {
    const box = textBox.current;
    if (!box) return;
    box.scrollTop += lines * LINE_PX;
    measure();
  };

  return (
    <main className="rec-bar">
      <button
        type="button"
        className={`record${listening ? ' on' : ''}`}
        onClick={() => void sessionRef.current?.toggle()}
        title="Record (Ctrl+Shift+Space)"
        aria-label={listening ? 'Stop recording' : 'Start recording'}
      >
        {listening ? '■' : '●'}
      </button>

      <div className="middle">
        <div className="headline">
          <span className={`state ${status}`}>{label(status)}</span>
          {listening && <span className="timer">{clock(elapsed)}</span>}
          {listening && (
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${Math.round(level * 100)}%` }} />
            </span>
          )}
        </div>
        <div className="readout">
          {/* Scrollable, and wheel-scrollable where the pointer happens to be, but the
              buttons are the control: they are the only part of this that can be aimed at. */}
          <div className={`text${text ? '' : ' empty'}`} ref={textBox} onScroll={measure}>
            {text || placeholder(status)}
          </div>
          {!scrolled.hidden && (
            <div className="scroller">
              <button
                type="button"
                onClick={() => scrollBy(-1)}
                disabled={!scrolled.up}
                title="Earlier words"
                aria-label="Scroll the transcript up"
              >
                ▲
              </button>
              <button
                type="button"
                onClick={() => scrollBy(1)}
                disabled={!scrolled.down}
                title="Later words"
                aria-label="Scroll the transcript down"
              >
                ▼
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="actions">
        <button type="button" onClick={() => void shell.openDetail()}>
          Details
        </button>
        {/* The only way out: this window has no frame to close. Allowed mid-recording —
            asking to leave is reason enough to stop whatever is going on. */}
        <button type="button" onClick={() => void shell.quit()} title="Quit just_speak_codex">
          Exit
        </button>
      </div>
    </main>
  );
}

/**
 * How far one click of the scroller moves the text: one line of it, matching `.text`'s
 * line-height so a click lands the next line where the last one was and never skips one.
 */
const LINE_PX = 18;

function label(state: SessionState): string {
  switch (state) {
    case 'connecting':
      return 'listening';
    case 'listening':
      return 'listening';
    case 'polishing':
      return 'polishing';
    case 'done':
      return 'done';
    case 'error':
      return 'problem';
    default:
      return 'ready';
  }
}

function placeholder(state: SessionState): string {
  if (state === 'connecting' || state === 'listening')
    return 'Speak — the words appear here as you pause.';
  return 'Press Ctrl+Shift+Space, or the button, and speak.';
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function readinessMessage(status?: string): string | undefined {
  if (!status || status === 'ready') return undefined;
  if (status === 'not-installed') return 'Local transcription is not installed: run npm run setup:local.';
  if (status === 'error') return 'The local model is not usable. Check Settings.';
  return undefined;
}
