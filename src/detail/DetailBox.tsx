import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApi, type Api } from '../api';
import type { HistoryEntry, Readiness } from '../../shared/types';
import { createShell } from '../shell';
import type { Notice } from '../shell/types';
import { nextNotice, type Spoken, type Voice } from './notice';
import { Compare, Grammar, Settings, Speak, newestFirst } from './tabs';

export type Tab = 'compare' | 'grammar' | 'speak' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'compare', label: 'Compare' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'speak', label: 'Speak' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The detail box: what you said, what it became, and what to learn from it.
 *
 * It is an ordinary focusable window — the opposite of the rec bar — because this is where
 * you read and edit, and because the rec bar must never take focus away from what you are
 * typing in. The history on disk is what the two windows share: the rec bar writes a
 * recording, the detail box reads it back, and the only other thing that crosses between
 * them is the rec bar saying what just happened, for the strip at the foot of this window.
 *
 * It is built once and then hidden rather than closed, so a strip that has been told about
 * a failed paste is still holding it when you come to look — which costs the detail box its
 * freshness, and is why being asked for again re-reads everything it shows.
 */
export function DetailBox() {
  const shell = useMemo(() => createShell(), []);
  const [api, setApi] = useState<Api>();
  const [readiness, setReadiness] = useState<Readiness>();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<Tab>('compare');
  const [notice, setNotice] = useState<Spoken>();

  // Three voices share the strip, and `nextNotice` is the rule between them: the newest
  // message wins, silence clears only the voice that went quiet, and a voice repeating
  // itself changes nothing.
  const speak = useCallback((from: Voice, message?: Notice) => {
    setNotice((current) => nextNotice(current, from, message));
  }, []);
  const speakForModel = useCallback((model?: Notice) => speak('model', model), [speak]);
  const speakForDetail = useCallback((notice?: Notice) => speak('detail', notice), [speak]);
  const speakForRecBar = useCallback((message?: Notice) => speak('recBar', message), [speak]);
  /** The detail box's own failures, which are always failures: errors it ran into itself. */
  const complain = useCallback(
    (text?: string) => speakForDetail(text ? { text, tone: 'error' } : undefined),
    [speakForDetail],
  );

  const selected = entries.find((entry) => entry.id === selectedId) ?? newestFirst(entries)[0];

  const reload = useCallback(async (client: Api) => {
    const loaded = await client.entries();
    setEntries(loaded);
    // The selection survives a reload that still contains it: this window is no longer
    // rebuilt between looks, so moving it out from under the person reading would be a
    // jump they did not ask for. A first look, though, opens on the newest recording —
    // the one the list puts at the top, and the one this window is usually opened for.
    setSelectedId((current) =>
      current && loaded.some((entry) => entry.id === current)
        ? current
        : newestFirst(loaded)[0]?.id,
    );
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const info = await shell.info();
        if (info.problem) complain(info.problem);
        const client = createApi(info.port);
        setApi(client);
        setReadiness(await client.readiness());
        await reload(client);
      } catch (error) {
        complain((error as Error).message);
      }
      // The window is created hidden and shown once the page has settled, like the rec bar.
      // The shell keeps its geometry asserted from here on, so this is asked for once.
      await shell.showDetail();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  useEffect(() => {
    if (!api) return;
    const offs: Array<() => void> = [];
    let live = true;
    const keep = (off: () => void) => (live ? offs.push(off) : off());
    void shell.onNotice(speakForRecBar).then(keep);
    // The half of the same fact that `onShown` cannot cover: a recording can land while this
    // window is open and being looked at, and nobody asks again for a window already in front
    // of them. The rec bar says so once the entry is written, and the list is read back.
    void shell
      .onHistoryChanged(() => void reload(api).catch((error) => complain((error as Error).message)))
      .then(keep);
    // Hidden is not closed: this page has been sitting here since the last look, and the
    // rec bar has been recording in the meantime.
    void shell
      .onShown(() =>
        void (async () => {
          try {
            setReadiness(await api.readiness());
            await reload(api);
          } catch (error) {
            complain((error as Error).message);
          }
        })(),
      )
      .then(keep);
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [api, reload, shell, speakForRecBar, complain]);

  const replaceEntry = (entry: HistoryEntry) =>
    setEntries((current) => current.map((item) => (item.id === entry.id ? entry : item)));

  /**
   * Delete one recording. The markdown is the history, so the rewrite is the whole of it —
   * there is nothing else to keep in step. The list is never drawn ahead of the file: it is
   * re-read once the file is written, and a rewrite that fails leaves it as it was.
   */
  const remove = async (entry: HistoryEntry) => {
    if (!api) return;
    try {
      const markdown = await api.history();
      const without = markdown
        .split(/(?=<!-- entry: )/)
        .filter((block) => !block.includes(entry.id))
        .join('');
      await api.rewriteHistory(without);
      await reload(api);
      complain();
    } catch (error) {
      complain((error as Error).message);
    }
  };

  return (
    <main className="detail">
      <header>
        <h1>just_speak_codex</h1>
        <nav>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === tab ? 'on' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <section className="body">
        {tab === 'settings' ? (
          // Before the "nothing here yet" branch, deliberately: Settings holds the only
          // control that downloads a model, and a first run has no recording to show — a
          // gate in front of it is a gate in front of being able to speak at all.
          <Settings
            readiness={readiness}
            onReadiness={setReadiness}
            api={api}
            onNotice={speakForModel}
          />
        ) : !selected ? (
          <p className="empty">
            Nothing here yet. Press Ctrl+Shift+Space and speak — the words land where you were
            typing, and the recording turns up here.
          </p>
        ) : tab === 'compare' ? (
          <Compare
            entries={entries}
            selected={selected}
            onSelect={(entry) => setSelectedId(entry.id)}
            onDelete={remove}
          />
        ) : tab === 'grammar' ? (
          <Grammar
            entry={selected}
            onChecked={replaceEntry}
            onNotice={speakForDetail}
            check={async (entry) => {
              if (!api) throw new Error('The app is not connected yet.');
              return api.checkGrammar(entry.id);
            }}
          />
        ) : (
          <Speak entry={selected} />
        )}
      </section>

      {/* The tool's one voice: what is running, and what went wrong. Silent most of the time,
          and a sibling of the tabs so a message outlives the tab it came from. */}
      <footer className={`notice ${notice?.tone ?? ''}`}>{notice?.text}</footer>
    </main>
  );
}
