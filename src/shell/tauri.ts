import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';

import type { InsertResult, Notice, Shell, ShellInfo } from './types';

const DETAIL = 'detail';
/** The rec bar's messages, and the detail box being asked for again, both leave the pages. */
const NOTICE = 'detail-notice';
const SHOWN = 'detail-shown';
/** A recording is on disk: the list the detail box is holding is now older than the file. */
const HISTORY = 'history-changed';

/** The only file in the app that knows Tauri exists. */
export const tauriShell: Shell = {
  info: () => invoke<ShellInfo>('shell_info'),

  async onRecordToggle(handler) {
    // The listener is registered by the shell, so the hotkey works whether or not this
    // page has finished loading — it simply has nowhere to deliver until it has.
    return listen('record-toggle', () => handler());
  },

  showRecBar: () => invoke<string>('show_window', { label: 'rec-bar', width: 820, height: 112 }),

  showDetail: () => invoke<string>('show_window', { label: 'detail', width: 1040, height: 680 }),

  openDetail: async () => {
    await invoke('open_detail_window');
  },

  // The promise is deliberately not waited on: the process is already leaving.
  quit: () => invoke<void>('quit'),

  insertText: (text) => invoke<InsertResult>('insert_text', { text }),

  report: async (line) => {
    try {
      await invoke('report', { line });
    } catch {
      // Nothing is listening yet, or the page is running outside the app.
    }
  },

  postNotice: async (notice) => {
    try {
      // `null` rather than nothing: the detail box has to be able to tell "said nothing" from
      // "not called at all", because a wordless post is a message clearing itself.
      await emitTo(DETAIL, NOTICE, notice ?? null);
    } catch {
      // The detail box has never been opened, so there is no one to tell. Not an error.
    }
  },

  onNotice: (handler) =>
    listen<Notice | null>(NOTICE, (event) => handler(event.payload ?? undefined)),

  onShown: (handler) => listen(SHOWN, () => handler()),

  postHistoryChanged: async () => {
    try {
      await emitTo(DETAIL, HISTORY, null);
    } catch {
      // A detail box that has never been opened is holding no list to make stale. Not an error.
    }
  },

  onHistoryChanged: (handler) => listen(HISTORY, () => handler()),
};
