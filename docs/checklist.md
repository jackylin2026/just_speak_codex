# Manual checklist

The tests cover what can be tested from a process. These are the things that cannot:
whether the window manager really leaves focus alone, whether the words really arrive in
another application, and whether a hotkey really works when something else has focus. They
are checked by hand before a milestone is called done, and this file is the check.

Have ready: a text editor (gedit does the job), the terminal running the app so its log is
visible, and something to play through the speakers — a recording of speech that is longer
than a few seconds.

Build and start first:

```bash
npm run build
npm run tauri dev        # or: ./src-tauri/target/release/just_speak_codex, for a packaged build
```

1. **The rec bar appears and behaves.** A strip sits at the bottom centre, 820x112, with no
   window frame, and it is not in the taskbar. It is never focused: click it, and whatever
   had focus still has it.
2. **The button records.** With the editor focused, click the rec bar's circle. The editor
   keeps focus, the rec bar reads `LISTENING` with a timer, and the level meter moves when you
   speak. Click again; the text arrives in the editor.
3. **The hotkey works from anywhere.** Focus the editor and press `Ctrl+Shift+Space`; the
   terminal logs `record-toggle`. Press it again. Repeat with a terminal or a file manager
   focused — the shortcut is global, not window-scoped.
4. **Segments arrive while you speak.** Speak a few sentences with pauses, or play the
   speech clip at the speakers. Text appears in the rec bar a piece at a time, each piece
   landing shortly after the pause that ended it, not all at once at the end.
4a. **Long text scrolls.** Keep going past the two lines the bar shows: a small `▲` `▼`
    appears beside the words, `▲` greyed out while you are at the top. Each click moves the
    text a line, and the ends grey the button that has nowhere left to go. A short
    transcript has no scroller at all. The wheel works too, when the pointer is over the
    words.
5. **The text lands where you were typing.** Focus the editor, record, stop. The polished
   text appears in the editor, the editor still has focus, and the clipboard holds whatever
   it held before.
6. **Nowhere to type is handled.** Click the desktop so it has focus, then record. The text
   is on your clipboard, and the detail box's strip says so. Paste it somewhere and confirm
   it is there. The words are never lost.
7. **The detail box opens without blocking.** Press `Ctrl+Shift+S`. The window appears,
   focused, and the terminal logs a dispatch and a window-ready time measured in tens of
   milliseconds — not seconds, and not a hang.
8. **The detail box's tabs work.** Compare opens on the recording you just made, at the top
   of a list that runs newest first. Each row is its sentence, with the date and the length
   on the line above it, invisible until you point at the row (or tab to it) — and nothing
   shifts when it appears. Grammar offers to check it; checking shows corrections and the
   practice line. Speak shows the coaching if speaking coaching is on. Settings shows the
   model, the coaching switch, and how much audio is in memory.
8a. **Settings is reachable with nothing to show.** With no recordings at all, open the
    detail box and press Settings. It shows rather than saying "Nothing here yet" — that is
    where a model is downloaded, so it cannot sit behind having spoken once already.
8b. **The model button says what it would do.** In Settings with the model already
    downloaded, it reads `Downloaded` and cannot be pressed. Clear the model's cache
    directory and switch models: it reads `Start Download`. Press it: `Downloading…` with
    the size in the status strip at the foot of the window, then `Downloaded` again. Take
    the network away and press it: `Restart Download`, with the reason in the strip.
8c. **The strip carries what the rec bar could not do.** Record with the model not
    downloaded: the recording fails, and the reason is in the strip. Record into a window
    with no field to paste into, so insertion falls back to the clipboard — "the text is on
    your clipboard instead" is in the strip. Record successfully, and the strip is empty
    again. The rec bar itself shows neither: it carries the text and the buttons only.
8d. **The strip carries the detail box's own failures.** On the Grammar tab, check a recording
    with the network down. The refusal appears in the strip, not under the button, and a
    later check that works clears it.
8e. **Deleting takes two clicks.** In the Compare list, point at a row: a `✕` appears at the
    end of the date line. One click turns it into `Delete?` and the date moves aside rather
    than being covered; pointing away or tabbing away takes the offer back, and the second
    click is the one that rewrites the history file — the row goes, and so does the entry in
    `history/entries.md`. Deleting the recording you are looking at moves the view to the
    newest one left.
9. **It survives being put away.** Close the detail box and open it again from the rec bar
    or with `Ctrl+Shift+S`. It comes back on the tab and the recording you left it on,
    without a reload — and it shows the recording you made in between, because being shown
    again re-reads what it shows.
9a. **It keeps up while it is open.** Leave the detail box open on screen and record without
    touching it. The recording reaches the top of the list on its own, a moment after the
    words land in the rec bar — no click, no hotkey, nothing asked for. A window already in
    front of someone is the one window that never gets asked for again.
10. **It survives a restart.** Quit it with the rec bar's `Exit` button — the window has no
    frame, so this is the only way out that does not need the terminal it was started from,
    and the process really goes away, detail box and all. Start it again. The history is
    still there — it was never in memory — and the detail box reads it back. The model
    button still reads `Downloaded`: the disk answers that question, not the session, which
    has loaded nothing yet.
11. **It cleans up after itself.** `pkill -f '(^|/)just_speak_codex($| )'` (or quit it), then check the port:
    `ss -ltn | grep 3000` prints nothing. A server left holding the port makes the next
    launch reuse a build that may no longer exist.
