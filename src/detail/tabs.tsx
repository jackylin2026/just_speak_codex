import { useEffect, useState } from 'react';

import type { Api } from '../api';
import { prepareAndFollow, prepareControl, prepareNotice } from '../model-preparation';
import type { HistoryEntry, LanguageFeedback, Readiness } from '../../shared/types';
import { loadPreferences, savePreferences } from '../preferences';
import type { Notice } from '../shell/types';

/**
 * Newest first, which is the order this window looks at recordings in: the one you just
 * made is the one you came to see. The file itself is still written oldest first — it reads
 * as a chronicle, and this is a picker.
 */
export function newestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * One recording, chosen from the list on the left — which is also the only place one is
 * deleted from. Deleting takes two clicks, because it rewrites the file and there is
 * nothing to undo it with: the first click arms the row, the second one deletes, and
 * leaving the row takes the offer back.
 */
function EntryList({
  entries,
  selected,
  onSelect,
  onDelete,
}: {
  entries: HistoryEntry[];
  selected?: HistoryEntry;
  onSelect(entry: HistoryEntry): void;
  onDelete(entry: HistoryEntry): Promise<void>;
}) {
  /** The one row offering to be deleted, if any. */
  const [armed, setArmed] = useState<string>();

  if (!entries.length) return null;
  return (
    <ul className="entries">
      {newestFirst(entries).map((entry) => {
        const ready = armed === entry.id;
        return (
          <li
            key={entry.id}
            className={ready ? 'armed' : ''}
            // Pointing away, or tabbing away, is the way out of the confirmation: the
            // offer only stands while the row is under the pointer or the keyboard.
            onMouseLeave={() => setArmed((current) => (current === entry.id ? undefined : current))}
          >
            <button
              type="button"
              className={entry.id === selected?.id ? 'on' : ''}
              onClick={() => onSelect(entry)}
            >
              <span className="when">
                {when(entry.createdAt)}
                {/* Recordings made before the length was counted straight from the
                    microphone have nothing here, and "0s" is not a length. */}
                {entry.duration ? ` · ${Math.round(entry.duration)}s` : ''}
              </span>
              <span className="what">{firstLine(entry.polished)}</span>
            </button>
            <button
              type="button"
              className={`delete${ready ? ' armed' : ''}`}
              aria-label={ready ? 'Delete this recording now' : 'Delete this recording'}
              onBlur={() => setArmed(undefined)}
              onClick={() => {
                if (!ready) return setArmed(entry.id);
                setArmed(undefined);
                void onDelete(entry);
              }}
            >
              {ready ? 'Delete?' : '✕'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** What you said, and what it became — the difference is the point of the app. */
export function Compare({
  entries,
  selected,
  onSelect,
  onDelete,
}: {
  entries: HistoryEntry[];
  selected: HistoryEntry;
  onSelect(entry: HistoryEntry): void;
  onDelete(entry: HistoryEntry): Promise<void>;
}) {
  return (
    <div className="split">
      <EntryList entries={entries} selected={selected} onSelect={onSelect} onDelete={onDelete} />
      <div className="columns">
        <section>
          <h2>What you said</h2>
          <p className="transcript">{selected.originalTranscript}</p>
        </section>
        <section>
          <h2>What it became</h2>
          <p className="transcript polished">{selected.polished}</p>
        </section>
      </div>
    </div>
  );
}

/** Language coaching: asked for when it is wanted, then kept in the history. */
export function Grammar({
  entry,
  check,
  onChecked,
  onNotice,
}: {
  entry: HistoryEntry;
  check(entry: HistoryEntry): Promise<HistoryEntry>;
  onChecked(entry: HistoryEntry): void;
  onNotice(notice?: Notice): void;
}) {
  const [busy, setBusy] = useState(false);

  // The failure goes to the strip at the foot of the window, like every other message the
  // tool has to give: this is a thing that happened, not a property of the tab you happen
  // to be looking at when it happens.
  const run = () => {
    setBusy(true);
    onNotice(undefined);
    void check(entry)
      .then((checked) => {
        onChecked(checked);
        onNotice(undefined);
      })
      .catch((error) => onNotice({ text: (error as Error).message, tone: 'error' }))
      .finally(() => setBusy(false));
  };

  if (!entry.language)
    return (
      <div className="centred">
        <p>
          This recording has not been checked yet. The check reads the original transcript and
          is kept in your history, so it only has to run once.
        </p>
        <button type="button" disabled={busy} onClick={run}>
          {busy ? 'Checking…' : 'Check this recording'}
        </button>
      </div>
    );

  const feedback: LanguageFeedback = entry.language;
  return (
    <article className="feedback">
      <h2>Summary</h2>
      <p>{feedback.summary}</p>
      {feedback.corrections.length > 0 && (
        <>
          <h2>Corrections</h2>
          <ul className="corrections">
            {feedback.corrections.map((correction, index) => (
              <li key={index}>
                <p className="change">
                  <s>{correction.original}</s> → <strong>{correction.suggestion}</strong>
                  <span className={`kind ${correction.kind}`}>{correction.kind}</span>
                </p>
                <p className="why">{correction.explanation}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Practice</h2>
      <p>{feedback.practice}</p>
    </article>
  );
}

/** Pronunciation and delivery, which can only be judged while the audio still exists. */
export function Speak({ entry }: { entry: HistoryEntry }) {
  if (entry.speaking)
    return (
      <article className="feedback">
        <h2>How it sounded</h2>
        {entry.speaking.split('\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </article>
    );
  return (
    <div className="centred">
      <p>
        Speaking coaching listens to the recording itself, and recordings are held in memory
        only — they are never written to disk. So it can only happen while the audio is still
        there: turn it on in Settings, and the next recording will arrive here with it.
      </p>
    </div>
  );
}

/** Transcription, coaching, and how much audio the app is holding. */
export function Settings({
  readiness,
  onReadiness,
  api,
  onNotice,
}: {
  readiness?: Readiness;
  onReadiness(readiness: Readiness): void;
  api?: Api;
  onNotice(notice?: Notice): void;
}) {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [busy, setBusy] = useState(false);
  /** A prepare that was refused outright, which never becomes a status of its own. */
  const [refused, setRefused] = useState<string>();
  const local = readiness?.local;
  const model = preferences.localModel;
  const control = prepareControl(local, model);
  const problem = refused ?? prepareNotice(local, model);

  // The strip at the foot of the window answers for this tab while it is open, and holds
  // the last thing it said after you leave — a message outliving its tab is the point of
  // putting it there. Deriving it from the status keeps it honest: it empties itself when
  // there is nothing to report.
  useEffect(() => {
    const tone = refused || local?.status === 'error' ? 'error' : 'info';
    onNotice(problem ? { text: problem, tone } : undefined);
  }, [problem, refused, local?.status, onNotice]);

  // Following a preparation rather than photographing it: it reads as ready only after the
  // status is asked for again, so the view keeps asking while one is running. A first
  // prepare downloads the model, which is minutes and hundreds of megabytes, and a frozen
  // "loading" is indistinguishable from a wedged download.
  useEffect(() => {
    if (!api || local?.status !== 'loading') return;
    const timer = window.setInterval(() => {
      void api
        .readiness()
        .then(onReadiness)
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [api, local?.status, onReadiness]);

  const update = (change: Partial<typeof preferences>) => {
    const next = { ...preferences, ...change };
    setPreferences(next);
    savePreferences(next);
  };

  const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="settings">
      <section>
        <h2>Transcription</h2>
        <p className="hint">
          Recognition runs on this computer, always. A recording is never uploaded to be
          transcribed.
        </p>
        <label>
          Model
          <select
            value={preferences.localModel}
            onChange={(event) => update({ localModel: event.target.value as 'base.en' | 'small.en' })}
          >
            <option value="base.en">base.en — quicker</option>
            <option value="small.en">small.en — more accurate</option>
          </select>
        </label>
        {local?.status === 'not-installed' && (
          <p className="hint">
            Recognition needs a Python environment on this machine, which this app does not
            install for you. With <code>uv</code> available, run:
            <br />
            <code>
              JUST_SPEAK_DATA_DIR="{readiness?.setup?.dataDir ?? '~/.local/share/just-speak'}" node "
              {readiness?.setup?.script ?? 'scripts/setup-local.mjs'}"
            </code>
          </p>
        )}
        {/* The button is the state of the model, and it is pressable only when pressing it
            would change something: a model already on this computer has nothing to fetch. */}
        <button
          type="button"
          disabled={busy || !control.enabled}
          onClick={() => {
            setBusy(true);
            setRefused(undefined);
            void (async () => {
              if (!api) return;
              try {
                await prepareAndFollow(api, model, onReadiness);
              } catch (error) {
                setRefused((error as Error).message);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? 'Downloading…' : control.label}
        </button>
      </section>

      <section>
        <h2>Speaking coaching</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={preferences.audioCoaching}
            onChange={(event) => update({ audioCoaching: event.target.checked })}
          />
          Send each recording to the audio model for pronunciation and delivery advice
        </label>
        <p className="hint">
          This is the one thing that leaves your computer: a copy of the recording goes to
          OpenAI, only when this is on. The transcript still goes to Cerebras for polishing
          and grammar either way.
        </p>
      </section>

      <section>
        <h2>Audio in memory</h2>
        <p>
          A recording is held in memory while it is being made and never written to disk.
          At most {Math.round((readiness?.audio?.capSeconds ?? 600) / 60)} minutes, which is{' '}
          {megabytes(readiness?.audio?.capBytes ?? 600 * 24000 * 2)}
          {readiness?.audio?.heldBytes ? ` — now holding ${megabytes(readiness.audio.heldBytes)}.` : '.'}
        </p>
      </section>
    </div>
  );
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function firstLine(text: string): string {
  const [first = ''] = text.split('\n');
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
}
