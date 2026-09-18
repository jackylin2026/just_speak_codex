export interface ShellInfo {
  /** The port the API is on. The shell chooses it; nothing else may assume one. */
  port: number;
  dataDir: string;
  version: string;
  /** Set when the API could not be started: usually Node is missing. */
  problem?: string;
}

export interface InsertResult {
  ok: boolean;
  detail: string;
}

/** A line for the detail box's status strip: what the tool is doing, or what went wrong. */
export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

/**
 * Everything the app needs from the desktop it lives in: where the API is, when the
 * recording hotkey fired, where the rec bar goes, and putting text into another application.
 *
 * Nothing outside this directory imports a desktop API. That keeps the rec bar, the session
 * and their tests free of the platform, and it is what made the shell decision cheap to
 * make in the first place.
 *
 * There is no `requestMicAccess` method: the microphone is requested by the page through
 * `getUserMedia`, and the shell's part — approving it for our own origin — happens in
 * Rust, where the webview's permission handler lives.
 */
export interface Shell {
  info(): Promise<ShellInfo>;
  /** Fires when the global hotkey is pressed, whatever has focus. Returns an unsubscribe. */
  onRecordToggle(handler: () => void): Promise<() => void>;
  /**
   * Place the rec bar and show it. Called once the page has laid out.
   * Resolves with the size it ended up at, because GTK can take a resize back.
   */
  showRecBar(): Promise<string>;
  /** Place the detail box and show it, for the detail box's own page to call on load. */
  showDetail(): Promise<string>;
  /** Open the detail box from the rec bar, creating it if this is the first time. */
  openDetail(): Promise<void>;
  /**
   * End the app. The rec bar has no window frame and is never focused, so there is no title
   * bar to close: this is the one way out that does not need the terminal it was started
   * from. Shutting down is the shell's whole job here — the process going away is what
   * releases the port and stops the server.
   */
  quit(): Promise<void>;
  insertText(text: string): Promise<InsertResult>;
  /** A line for the terminal that runs the app, since a never-focused window has no console. */
  report(line: string): Promise<void>;
  /**
   * Tell the detail box what just happened, for its status strip.
   *
   * The rec bar is the window that speaks, so it is the window that reports: a paste that did
   * not land, a microphone that was not there, a polish that failed. The detail box is built
   * once and then hidden rather than destroyed, so it is still listening — including while
   * nobody can see it, which is exactly when the rec bar is doing its work. Nothing here is
   * stored: a notice posted before the detail box has ever been opened is not heard.
   */
  postNotice(notice?: Notice): Promise<void>;
  /** The detail box's half of `postNotice`. Returns an unsubscribe. */
  onNotice(handler: (notice?: Notice) => void): Promise<() => void>;
  /**
   * Fires when the detail box has been asked for again while it is already running — it is
   * hidden, not reloaded, so what it is showing is as old as the last time it was looked
   * at. Anything read from disk has to be read again.
   */
  onShown(handler: () => void): Promise<() => void>;
  /**
   * Tell the detail box that a recording has been written into the history.
   *
   * `onShown` covers the way this usually goes — record, then go and look — and misses the
   * way it goes when both windows are on screen at once: the box is open, a recording lands,
   * and nobody asks for the box again, so it goes on showing the list it read before. This
   * is the missing signal. It is posted once the entry is on disk, never before, because the
   * file is what the detail box reads and the file is what has to have changed.
   *
   * The reverse of `postNotice`, and as little of a promise: a box that has never been
   * opened has nothing to refresh.
   */
  postHistoryChanged(): Promise<void>;
  /** The detail box's half of `postHistoryChanged`. Returns an unsubscribe. */
  onHistoryChanged(handler: () => void): Promise<() => void>;
}
