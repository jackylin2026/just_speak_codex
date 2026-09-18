# just_speak_codex — Build Plan

The app was renamed from Just Speak to `just_speak_codex` on 2026-09-19. Earlier
verification notes below retain the names and paths used at the time. See the README
for current install commands; existing data paths, preferences, and environment variables
keep their original names for compatibility.

Vocabulary is defined in [CONTEXT.md](../CONTEXT.md). This document is the build order and the shape of the code. It is not a spec for users; the user-facing README gets rewritten at the end.

## What we are building

A native Ubuntu app that turns speech into text in whatever application you are already typing in, and — when you open the studio — teaches you about the English you just spoke. Dictation first; the coach is the second role, not the first.

## Decisions this plan is built on

| Decision | Why, in one line |
| --- | --- |
| Native Tauri shell, Electron as fallback | Insertion into other applications is the product; only a native shell can do it. |
| Local Whisper, VAD-segmented, never cloud transcription | Privacy, no upload latency, and WebKitGTK compiles out `RTCPeerConnection` anyway, so browser-direct cloud streaming was never on the table. |
| Never-focusable bar; text inserted on stop | Keeps focus in the target app, at the cost of editing before insertion — accepted deliberately. |
| Two windows: bar + studio | A never-focusable window that must also flip focusability per mode is where cross-WM bugs live. |
| Text-only markdown history with the original nested | The diff between said and said-better is the learning value; audio is held in memory only. |
| Cloud audio uploaded for pronunciation feedback only | One capability, not a general-purpose pipe. |
| Delivery from the OpenAI audio call, not measured locally | Cheaper; accepted weaker precision ("you paused noticeably" not "2.1 s"). |
| Linux/X11 only | The global shortcut plugin is X11-only by upstream design, and window positioning is a no-op on Wayland. |

## Verified platform facts

These were checked against upstream source and docs rather than assumed. They are the load-bearing ones.

**Non-focusability is achievable, with one gap.** Tauri 2.8+ exposes `set_focusable(false)` / the build-time `focusable: false` option, which maps to `gtk_window_set_accept_focus`. That is a *hint* to the window manager, so whether it is honoured is WM-dependent and unverified on this desktop. The piece that stops a window grabbing focus *when it first appears* is `gtk_window_set_focus_on_map`, which Tauri does **not** expose — reach it through the Linux-gated `Window::gtk_window()` inside `app.run_on_main_thread(...)`. Prefer setting focusability at build time; the setter on an already-mapped window is less reliable.

**The risk to this design is real and has precedent.** [Handy](https://github.com/cjpais/Handy), a shipping Tauri dictation app, ships its Linux recording overlay **disabled by default** because some compositors treat the overlay as the active window, which steals focus and prevents pasting back into the target app. That is exactly our design, so Phase 0 exists to find out whether this desktop is one of the bad ones.

**Sidecars cannot be JavaScript.** Tauri's `externalBin` mechanism execs the file directly with no interpreter step, so `node server.js` cannot be a sidecar. Spawn it with plain `std::process::Command`. Consequence: **Node must be installed** on the machine — acceptable for a personal app, and worth stating in the README rather than discovering at runtime.

**Child-process cleanup is ours to write.** There is no `kill_on_drop`, and `RunEvent::Exit` does not fire on a crash — the Node child is reparented to init and **keeps holding the port**, so the next launch fails to bind. Spawn in its own process group and kill the group; keep a port-based fallback. (`local/worker.py` reads stdin in a loop, so the Python grandchild exits on EOF when Node dies — that half takes care of itself.)

**Two environment traps.** `dotenv` resolves `.env` against the *current working directory*, so a server launched from the wrong cwd silently loses the API keys — pin `DOTENV_CONFIG_PATH` or control the cwd. And `dist/server.js` locates `.venv` and `.local-models` relative to itself via `import.meta.url`, with the model cache path **not overridable by environment**; that must become configurable for packaging to work at all.

**Clipboard reading must never run on the main thread** — the plugin can deadlock and freeze the whole app on Linux. And the global-shortcut plugin holds a mutex while a handler runs, so **a handler that creates a window can deadlock** — the studio hotkey is exactly that shape and must dispatch rather than build UI inline.

**Verified fine:** `setAlwaysOnTop` (→ `_NET_WM_STATE_ABOVE`), `setSkipTaskbar`, `setDecorations`, and `setPosition`/`setSize` all work on X11. `setIgnoreCursorEvents` works via XSHAPE. `enigo` 0.6.1 drives input through XTEST — pure Rust, no root, no `xdotool` dependency — and XTEST is present on this display. The global-shortcut plugin grabs the X11 root window and fires while another application has focus.

**Verified NOT available, and they fail silently:** `set_shadow`, `set_effects`, `set_cursor_grab`, `set_maximizable`, `set_minimizable` all return `Ok(())` on Linux and do nothing. Transparency *does* work here — the bar's rounded corners show the desktop through — see the EGL correction and step 4 results below; the earlier "no compositor" reading came from asking for `_NET_WM_CM_S0`, which is not a valid test on this desktop.

## Phase 0 — The spike (before any UI work)

Everything downstream is gated on this. Do it first, in a throwaway Tauri app.

1. `with_webview()` → `settings.set_enable_media_stream(true)`, then `connect_permission_request` **allowlisting only our own origin** — never a blanket `request.allow()`. WebKitGTK has no permission UI at all and default-denies silently, so a missing handler looks like a broken microphone.
2. `getUserMedia` with v1's real constraints (`channelCount: 1, echoCancellation, noiseSuppression, autoGainControl`), **plus a catch-and-retry with `{audio: true}`** on `OverconstrainedError`. WebKit throws where Chrome degrades.
3. Load the real `recorder-worklet.js`, record five seconds, confirm sample buffers transfer.
4. A frameless, always-on-top, skip-taskbar window built with `focusable: false`, *plus* `gtk_window_set_focus_on_map(false)` through `gtk_window()` on the main thread. Then the actual test: **focus a text editor, trigger the hotkey, speak, and confirm the text lands in the editor** — the Handy problem, tested directly rather than inferred.
5. Confirm a global shortcut fires while another application has focus, and confirm the studio can be opened from a shortcut without deadlocking.

**Kill criterion:** if (2), (3), or (4) cannot be made to work, switch to Electron. The `Shell` interface exists so that this costs an implementation, not a rewrite. Note what the fallback buys: Electron's Chromium approves media permission requests by default, so the entire permission-handler problem disappears, and that code path is already proven on this machine in Chrome 149 — 24 kHz `AudioContext`, AudioWorklet, and `getUserMedia` with all constraints honoured. What it costs is ~282 MiB unpacked instead of a few, plus folding the Node server into the main process as an ordinary child process.

## Phase 0 — results so far (2026-09-17, evening)

The spike lives in `spike/` (gitignored, throwaway). **Steps 1–3 now pass.** Recording, constraint handling, and worklet transfer all work inside the Tauri webview:

```
PASS isSecureContext: true
PASS navigator.mediaDevices present: true
PASS getUserMedia present: true
PASS AudioWorkletNode present: function
PASS crypto.randomUUID present: function
PASS AudioContext requested 24000, actual 24000
PASS AudioContext.state after resume(): running
permission request from 'http://localhost:1420/' -> allow
PASS getUserMedia(v1 constraints): granted
PASS audioWorklet.addModule('/recorder-worklet.js'): ok
PASS AudioWorkletNode constructed from 'just-speak-recorder'
PASS captured 120576 samples over ~5s = 5.02s of audio, peak amplitude 1.0803
PASS encoded WAV: 241196 bytes
```

Three results worth keeping:

- **The AudioContext starts running with no user gesture.** A global hotkey will not be the first interaction, so this was a real question; it is answered yes.
- **v1's constraints are honoured, no `OverconstrainedError`** — the `{audio: true}` retry never fired on WebKit. `track.getSettings()` reports `echoCancellation: true` and a bare `sampleRate: 0`; WebKit simply does not report the rest.
- **The permission handler is load-bearing and correctly scoped.** It fired for `http://localhost:1420/` and allowed it. A real `<img src>`-style probe from another origin was not tested; the allowlist logic is the only guard.

Observation, not a result: peak amplitude came back **above full scale (1.08)**. Either the mic is hot, AGC is over-driving it, or something clipped. Worth a look before tuning VAD thresholds, since clipping feeds Whisper worse input.

### The EGL blocker, and why the earlier diagnosis was wrong

The previous entry blamed the GPU and the boot order. That was incorrect. The real cause is a **stale third-party EGL vendor entry**:

```
/usr/share/glvnd/egl_vendor.d/00_musa.json  ->  "library_path": "libEGL_musa.so.0"
```

That file belongs to `musa 2.7.1-rc3-0822` — a Moore Threads GPU driver (see `/usr/lib/x86_64-linux-gnu/musa/`, `/etc/ld.so.conf.d/00-mtgpu.conf`). glvnd enumerates vendors in order and `00_musa` wins the default-display slot, but this machine has no Moore Threads card, so the display never initialises and **every** EGL client dies. It is not AMD, not `simpledrm`, not the boot order. Evidence:

```bash
eglinfo -B                                    # eglInitialize failed, empty client extensions
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json eglinfo -B
                                              # X11 platform: EGL 1.5, Mesa Project  ← works
LIBGL_ALWAYS_SOFTWARE=1 eglinfo -B            # still fails — the pin is the only variable
```

**Workaround, no root:** export the pin for the app's process tree.

```bash
npm run dev                                  # debug binary loads devUrl, not dist/ —
                                             # without the Vite server it shows "Connection refused"
__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json \
  ./src-tauri/target/debug/spike
```

**The env pin is now obsolete**: with the stale MUSA entry gone, the binary starts without
it. The dev server is still what a debug binary loads, so use `npm run dev` for iteration
and `npm run build && npx vite preview --port 1420 --strictPort` when what you want to look
at is the bundle that would ship. Neither changes the geometry story below — that was
tested against both and behaved the same.

**Real fix, needs root and an X restart:** disable the stale entry (`sudo mv .../00_musa.json .../00_musa.json.disabled`) — or purge `musa` if no Moore Threads card is wanted. Xorg's own boot-time `eglGetDisplay() failed` is almost certainly the same cause, since glamor `dlopen`s `libEGL.so.1`, which is glvnd. **If that holds, DRI3 comes back, mutter can composite, and the "transparency is off the table" conclusion reopens** — it was a symptom of this bug, not independent evidence. That is a hypothesis until the X server is restarted with the entry gone; check `xprop -root _NET_WM_CM_S0` and `/var/log/Xorg.0.log` afterwards.

Meanwhile WebKit renders in software here (`libEGL warning: DRI2: failed to authenticate`), which is fine for correctness but says nothing yet about the bar's frame cost.

### Steps 4 and 5: the crux, and it holds (2026-09-17, late evening)

The spike now has the bar, both hotkeys, insertion, and a focus probe that asks X — not our
own process — which window is active. It also has `examples/sendkeys.rs`, a throwaway XTEST
key-and-mouse driver, so the whole loop could be exercised without a human hand on the
keyboard.

**Result: Tauri can do this on this desktop.** The evidence, in the order it happened, with
gedit focused (window `0x2e000f8`) and the bar mapped at the bottom of the screen:

```
[spike] hotkey shift+control+Space pressed                      ← another app had focus
[spike] record-toggle delivered to the bar in 80.071µs
[spike] permission request from 'http://localhost:1420/' -> allow
[spike] PASS captured 4.61s, 221228 bytes, peak 1.080
[spike] PASS record stop — active window: 0x2e000f8 WM_CLASS = "gedit", "Gedit"
[spike] insert: 88 chars -> [0x2e000f8 "gedit"] in 346 ms, clipboard restored
[spike] PASS target after insert: 0x2e000f8 WM_CLASS = "gedit", "Gedit" (unchanged)
```

The text that landed in the editor was:

```
Just Speak spike — insertion test ✓ “curly quotes”, café, 3:15 — 中文测试 にほんご
```

Em dashes, a check mark, curly quotes, an accent, CJK and kana all survived, which is the
argument for clipboard-paste over simulated typing stated as evidence rather than as a
plan. gedit's title gained its modified marker at the same moment, which is the independent
proof that the paste arrived rather than merely that a key was sent. The same run driven by
*clicking* the bar's record button behaved identically: the click was delivered, the
recording ran, the text landed, and `_NET_ACTIVE_WINDOW` never left gedit. The Handy
failure mode does not reproduce here for an always-mapped bar.

The studio hotkey is safe with the dispatch pattern:

```
[spike] hotkey shift+control+KeyS pressed
[spike] studio[hotkey]: dispatched after 33.666µs
[spike] studio: is_focused after build: Ok(false)
[spike] studio[hotkey]: window ready 23.539287ms after the trigger, no deadlock
```

Three things worth keeping:

- **`set_focus()` after building the studio is required.** Without it the window opens
  with `is_focused() == false` and mutter leaves focus on the previous application; with
  it, focus moves. Tauri's `focused: true` default did not do this on this desktop.
- **The bar's own hints are what we want**: `WM_HINTS: Client accepts input or input
  focus: False`, `_NET_WM_STATE = SKIP_PAGER, SKIP_TASKBAR, ABOVE`. Clicks still reach its
  buttons — a non-focusable window is not a non-interactive one.
- **Transparency works**, so the bar's rounded pill is not a gamble. The earlier
  "transparency is off the table" conclusion was a symptom of the EGL bug after all:
  glamor and DRI3 came back with the MUSA entry gone. **`xprop -root _NET_WM_CM_S0` is not
  a valid test for a compositor here** — it reports nothing, and GNOME Shell is compositing
  anyway. Judge by rendering a translucent window, not by that property.

### The window-sizing trap (read this before building the real bar)

Declaring `"width": 760, "height": 108` is a request, not a guarantee. GTK sizes a toplevel
to whatever its child asks for, and WebKitGTK's natural height is the document's — so with
`height: 100%` in the page the two feed each other, and the window settled at **237, 182, or
145 px** depending on the run. `resizable: false` makes it worse: it freezes the child's
answer as min == max, and no later resize can undo it.

What works:

1. **Create the window hidden** (`"visible": false`), and show it only after the page has
   laid out and the size has been set from Rust. Nothing then races.
2. **Give the page a height in a length, not a percentage** (`--bar-height: 108px`), or the
   document height is whatever the window height happens to be.
3. **Do not trust `outer_size()`.** Mutter reports `_NET_FRAME_EXTENTS = 0, 0, 37, 0` for
   this window and Tauri's outer size is client + 37 — the numbers 145, 152, 182 were all
   client + 37. Position from the size you asked for, and verify with `xwininfo` instead.
4. **An oversized transparent window still swallows clicks** in its invisible region. With
   transparency working this is a live hazard for a bottom-of-screen bar: either keep the
   window exactly its drawn size, or shape its input region.

The bar was also hidden and shown again with focus observed on both sides of each:

```
[spike] click at 624,66 on #toggle-bar
[spike] PASS bar hide: before [gedit] after [gedit]
[spike] PASS bar show: before [gedit] after [gedit]
```

A scare on the way there is worth recording as a lesson about the test harness rather than
about the toolkit: three clicks appeared to be swallowed, and the input region looked stale
after resizing a hidden window. Instrumenting the page to log every click with its page
coordinates showed all three arriving exactly where they were aimed — at `#actions` and
`#bar`, because they had landed in the 4 px gap between button rows. The buttons were fine;
the coordinates in the test script were guesses. Log where a click *arrives* before
believing a window is deaf.

### Still to do in Phase 0

- A window was hidden and shown by hand once; that is not a test of doing it on every
  recording.
- Clip amplitude came back above full scale again (1.08–1.09 over two runs). Still worth
  a look before VAD thresholds, since clipping feeds Whisper worse input.
- The unsafe shape — building a window *inside* the shortcut handler rather than
  dispatching — was not run. The dispatch is verified working, and the plugin's handler
  runs on its own X11 event-loop thread while holding a mutex, which is enough to keep the
  rule: never construct a window in the handler.

**Decision: Tauri.** The Electron fallback existed for two reasons — media permission
handling and insertion into another application — and both now work, with insertion proven
end to end into a real text editor. Track the click anomaly above; if it turns out to be a
toolkit limitation rather than a spike bug, it is small enough to work around (input shape)
and not a reason to change shells.

There is still no Node child process in the spike, so the packaging questions from the
platform-facts list — sidecar spawn, process-group cleanup, `DOTENV_CONFIG_PATH` — remain
unverified. They belong to milestone 2 (server reshape), not to the shell decision.

## Milestone 2 — server reshape (done 2026-09-17)

The repository had no source at all; it now has the server, reshaped from v1 and running
standalone. `server/{index,app,config,history,providers,local-transcriber,stream,audio,errors}.ts`,
`shared/{types,schemas}.ts`, `local/{worker.py,test_worker.py,requirements.txt}`,
`scripts/setup-local.mjs`, and seven test files. Express 5, Zod 4, ESM, vitest, `ws` added
for the socket — otherwise v1's stack, unchanged.

What changed from v1, and why:

- **The webview is a cross-origin caller.** v1's origin check accepted only
  `http://localhost:<port>`, which is a 403 for every call the app makes. The server now
  has an origin allowlist — `tauri://localhost`, `http://tauri.localhost` (Windows),
  `localhost`/`127.0.0.1` on the chosen port, and the Vite dev origin — echoes the matching
  `Access-Control-Allow-Origin`, varies on it, and answers preflights (`OPTIONS`, which
  JSON and custom headers both require) before any route runs. The host check stays: the
  API still binds `127.0.0.1` and refuses a request whose `Host` is not localhost.
- **Transcription is local, and only local.** The OpenAI transcription adapter,
  `OPENAI_TRANSCRIBE_MODEL`, and the `X-Transcription-Provider` header are gone;
  `X-Local-Model` remains for the model choice. A local failure is reported as itself —
  the tests assert the fetcher is never called, so a broken Whisper install cannot turn
  into a silent upload.
- **History is markdown on disk.** `GET /api/history` reads it, `POST /api/history`
  rewrites it (which is how an entry gets deleted), and `POST /api/history/entries`
  appends one recording. Each entry is preceded by `<!-- entry: <iso> <uuid> -->`, which
  renders as nothing and makes a block findable without parsing prose — that comment is
  the whole reason a studio delete is safe. The original transcript sits beside the
  polished text, which is the learning value; audio is never written. Writes are queued
  and land through a temporary file plus rename, so two recordings finishing at once
  cannot interleave and a crash cannot truncate the file.
- **`WS /api/stream` exists as a transport.** Origin is validated on the upgrade (a
  browser always sends one, so a missing Origin is not our frontend), the path is exact,
  frames and total bytes are capped, and every input gets a well-formed event back.
  `stop` answers with an explicit "not implemented yet" error: the scaffolding is real,
  recognition is milestone 3.
- **Configuration is packaging-safe.** `server/config.ts` resolves the data directory
  (`JUST_SPEAK_DATA_DIR`, default the repository root), the history directory, the model
  cache (`LOCAL_MODELS_DIR`), the interpreter (`LOCAL_WHISPER_PYTHON`), threads, the origin
  list, and — the trap from the platform facts — `.env` **by absolute path**, overridable
  with `DOTENV_CONFIG_PATH`. The server is API-only now: no Vite middleware, no static
  host, because the frontend is a webview loading the app bundle.

Verified rather than assumed:

- `npm test` — 43 tests in 7 files, including the two guarantees that must not lapse: no
  key material in `/api/config`, and no API keys or Hugging Face tokens in the worker's
  environment. `python3 -m unittest discover -s local` — 3 tests.
- A real server on :3111 with v1's `.env` loaded by absolute path and a throwaway data
  directory: `openai`/`cerebras` reported as booleans with no key material, `tauri://localhost`
  echoed in `Access-Control-Allow-Origin`, `https://evil.example` rejected 403, preflight
  204, an appended entry visible in `history/entries.md`.
- The socket by hand: foreign origin 403, no origin 403, our origin → `ready` → binary
  frame accepted → `stop` → the not-implemented error.
- Local recognition end to end, with `LOCAL_WHISPER_PYTHON` and `LOCAL_MODELS_DIR` pointed
  at v1's existing venv and model cache: `prepare` reached `ready` in about four seconds
  with no download, and a two-second tone came back as the 422 "No speech was recognized
  locally" — which is the right answer for a tone, and it means the request went through
  the real Python worker and back.

Deliberately not in this milestone: the worker's streaming rewrite (segmentation,
cancel-without-kill, queueing) is milestone 3, so `local/worker.py` is v1's one-shot
version; v1's client-side tests (session, worklet, IndexedDB history) are not ported
because those modules do not exist yet — `tests/wav.ts` stands in for `src/audio.ts`; the
recording cap is still v1's two minutes and 12 MB, since the recorder's ten-minute cap
belongs with the recorder work; and Playwright was not ported at all, as decided.

## Milestone 3 — worker streaming (done 2026-09-18)

Recognition now happens while you are still speaking. `local/segmenter.py` decides where
sentences end, `local/worker.py` runs a session rather than one-shot requests,
`server/local-transcriber.ts` owns the session and the queue, and `/api/stream` relays
what comes back.

**The gate is pure standard library.** It measures the room over the opening 300 ms, closes
a segment after 400 ms below that threshold or at 15 s, drops anything under 300 ms of
speech, and hands the previous segment's text to the next one as its prompt. Two things
about it were learned rather than assumed:

- **The minimum-length guard counts speech, not silence.** Counting the whole segment let a
  120 ms cough followed by a breath pass the 300 ms bar, because the trailing silence was
  in the measurement. It is the *spoken* samples that have to clear it.
- **The gate does not chase a room that gets louder.** That was tried and removed: by level
  alone, a fan switching on is indistinguishable from someone talking, so the honest answer
  is to open and let the no-speech guard judge. The gate's job is pauses.
  Calibration starts at the floor and only ever learns from frames that are *not* speech,
  so dictation that begins immediately is heard instead of being calibrated away against
  the speaker's own voice.

**A cancel no longer kills anything.** The worker keeps reading stdin and honours `cancel`
at the next read boundary, at the cost of waiting for the segment in flight to finish —
there is no interrupting native inference mid-call, and killing the process to stop one
segment costs a model reload on the next recording. `SIGKILL` remains for the one-shot
`/api/transcribe` path, where a reload is an acceptable price, and for a wedged process.
The server's single-slot "busy, retry" is now a queue: a recording that has already been
spoken cannot be retried, so it waits its turn with its audio buffered instead.

**Backpressure is real.** `push()` returns false when the worker's input is full and the
socket reading pauses until it drains, so a slow model slows the recording down instead of
dropping words. Audio is base64 JSON lines — 33% overhead on ~64 kB/s over a local pipe,
paid for a protocol that stays one JSON object per line in both directions, in the same
shape the tests and the worker already spoke.

Two bugs worth remembering, because both were invisible from the outside:

- **The decoder does not take bare samples.** Segments are headerless 24 kHz PCM, and
  faster-whisper's PyAV path answered `InvalidDataError` on every one — reported to the
  client as a generic failure. Segments are wrapped in a 44-byte WAV header now, which also
  gets PyAV's own resampling to 16 kHz. A regression test asserts the container.
- **Cancelling before the worker acknowledged left a session open on it**, and the next
  recording was refused. The worker has to be told to close whenever it has been told to
  start, whether or not it has answered yet; messages are processed in order, so a cancel
  written now still lands after its own start.

Verified rather than assumed:

- 22 Python tests (segmenter, worker protocol) and 50 TypeScript tests (session queue,
  backpressure, cancel, segment relay, handshake) pass.
- `scripts/stream-check.mjs` streams a WAV through the real endpoint at real-time pace.
  Eleven seconds of public-domain speech (Whisper's own JFK test clip) produced `ready`
  immediately, then segments at **2.9 s, 5.0 s and 8.2 s** — while the audio was still
  being sent — and the assembled `done` at 11.5 s:

  ```
  0.0s {"type":"ready","model":"base.en"}
  2.9s {"type":"segment","index":0,"text":"And so my fellow Americans!","startMs":0,"endMs":2320}
  5.0s {"type":"segment","index":1,"text":"Ask not!","startMs":3280,"endMs":4520}
  8.2s {"type":"segment","index":2,"text":"What your country can do for you!","startMs":5400,"endMs":7800}
  11.5s {"type":"segment","index":3,"text":"Ask what you can do for your country!","startMs":8180,"endMs":11001}
  11.5s {"type":"done","text":"And so my fellow Americans! Ask not! What your country can do for you! Ask what you can do for your country!"}
  ```

  The first segment's text arrives about 0.6 s after the pause that closed it: that is the
  live-preview latency, measured.
- Cancelling two seconds into a recording and starting another immediately gave `ready` in
  **0.00 s**, which is only possible if the model was never reloaded.
- The segmentation is visible in the result: the fragments read "Ask not!" and "What your
  country can do for you!", while the same clip through the one-shot endpoint returns the
  sentence whole. That is exactly the trade the design accepts — a fragment is a preview,
  and the whole recording is what gets polished and inserted.

Still to do: nothing here is polished yet. Per-segment polish for the live preview and the
final polish on stop are milestone 4, which also brings the bar that shows them.

## Milestone 4 — the bar (done 2026-09-18)

The app is now a thing you can use: a strip at the bottom of the screen, a hotkey, and
your words arriving in whatever you were typing in. `src-tauri/` is the shell, `src/` is
the bar, the session and the recorder, and milestone 3's streaming is wired to both.

**The shape of the frontend.** `src/shell/` is the only place that knows Tauri exists —
`insertText`, the hotkey, placing the window — so the session and the bar talk to an
interface, and their tests talk to a fake. `src/session.ts` is the recording, as a stream
of events rather than a request: audio leaves continuously, segments come back as they
close, each is polished for the preview, and the whole transcript is polished once more on
stop — that last polish is what gets inserted. `src/audio.ts` is the microphone: v1's
constraints, the `{audio: true}` retry, 16-bit PCM in ~100 ms blocks at 24 kHz.

**What the live runs proved**, with gedit focused and the JFK clip played into the room
microphone:

```
[shell] record-toggle
[shell] insert: 80 characters where you were typing, in 345 ms, clipboard restored
[bar] inserted: 80 characters where you were typing, in 345 ms, clipboard restored · 10.7s recorded, level peak 1.000
```

and the editor received *"So, my fellow Americans, ask not what your country can do for
you; ask what you…"* — which is the polish doing its job, since the raw segments read "And
so my fellow Americans!" and "Ask not!". The failure path was exercised the same way, with
the desktop focused instead of a text field:

```
[shell] insert: The desktop has focus. The text is on your clipboard instead.
```

— and a manual paste afterwards retrieved the words, which is the point of it.

**What went wrong, and what it taught.** This milestone was mostly debugging, and the
lessons are worth more than the code:

- **A hidden window never gets a frame callback.** The bar was created hidden and called
  `requestAnimationFrame` to place itself once laid out; a page that is not visible never
  runs the callback, so the bar simply never appeared. Show it from the effect.
- **The worklet's output has to reach the destination**, and WebKit then re-sizes the
  window to the webview's natural height whenever the page's layout changes — so a
  `set_resizable(false)` immediately after `set_size` freezes whatever size the window had
  at that instant. Measured: a 200-pixel-tall window stayed 200 for ever. Lock it only
  once it measures right, and ask again until it does.
- **Samples posted from the worklet arrived as NaN.** The worklet's own peak said 1.19
  while the page received blocks of the right length with nothing in them — and NaN written
  into an `Int16Array` becomes silence, which is exactly what the recogniser was given.
  Fixed by converting to 16-bit on the audio thread, where the data is known good, and
  posting integers; whether the transfer list was also implicated was not isolated.
- **Hot module replacement does not re-run a long-lived effect.** Several rounds of
  measurements were taken against stale code — the component updated, the effect did not —
  which made a working pipeline look broken. The dev build now reloads the page on update.
- **The desktop's window class is `gjs`**, not `gnome-shell`, so "nowhere to type" was not
  recognised until that was in the check.
- **A killed app leaves its server holding the port**, because no exit handler runs. The
  child now asks the kernel to signal it when its parent dies (`PR_SET_PDEATHSIG`), which
  covers every way the app can end, and the shell still stops it politely on the way out.
- **A socket closing after a deliberate finish was read as a failure**, so every recording
  reported one: the session now knows the difference between "over" and "broken".

Verified rather than assumed: 57 TypeScript tests (including the session's revision guard,
the polish fallback that keeps recognised text, and the microphone-refused path) and 22
Python tests. The streaming half was verified against real speech in milestone 3 and this
milestone drove it end to end through the real app.

Known gaps: a segment of near-silence can still be hallucinated into a confident sentence —
the no-speech guard is not enough when the audio is a loudspeaker in a room, and a real
microphone used properly is cleaner than this test was; and the per-segment preview polish
is unit-tested but was not seen live.

## Milestone 5 — the studio (done 2026-09-18)

A window you can focus, with five tabs, opened by `Ctrl+Shift+S` from anywhere or from the
bar: Compare, Grammar, Speak, History, Settings. It is the opposite of the bar in every
way, which is the point — the bar must never take focus, and this is where you read.

**The two windows share nothing but the history.** There is no in-memory channel between
them; the bar appends a recording to the markdown when it ends, and the studio reads,
edits and deletes from the same document. That is what lets either window be closed
without the other noticing, and it is why the studio needed no state of its own. *(The
studio's status strip added one channel back — see "The status strip, and a studio that
stays built" below.)*

**The markdown is the database.** Entries are addressable by their marker comment, and
`renderEntry` and `parseEntries` round-trip exactly — a test writes an entry, reads it
back, and compares. That is what makes "cache this coaching into that recording" a rewrite
of one block rather than a schema change. The duration moved into the marker to make the
round trip lossless, with the heading as a fallback: entries written before it existed
still read, which is not hypothetical — the first real entry in this checkout was one.

**Coaching is split by what can be recomputed.** Grammar is text into text, so it is lazy:
the Grammar tab asks for it, the server writes the answer into the document, and the next
look is free. Speaking feedback needs the audio, and the audio is memory-only, so it can
only happen while the recording exists — the bar uploads it when the recording ends, and
only if coaching is switched on. The recording is kept in memory at all *only* for that:
nothing else needs it once it has been transcribed.

**Settings shows the figure that makes the privacy claim concrete**: "A recording is held
in memory while it is being made and never written to disk. At most 10 minutes, which is
27.5 MB." The server reports both the cap and what it is holding right now. Preferences —
the model and the coaching switch — live in this browser's storage, and the bar reads them
when a recording *starts*, so changing the model in the studio reaches the next recording
rather than the next launch.

Verified rather than assumed: the hotkey dispatched, built the window and focused it in
22 ms with no deadlock, and the bar's Studio button reopened it after the window was
closed; Compare showed the original beside the polished text; "Check this recording"
produced real coaching which was written into `entries.md` and read back through the API;
History listed the recording and deleting it rewrote the document to nothing; Settings
reported the model, the coaching switch and the memory figure. 65 TypeScript and 22 Python
tests pass.

Known gaps: the studio loads when it opens, so a recording made while it is on screen does
not appear until it is reopened; the transcripts in these runs are poor because the test
audio is a loudspeaker heard through a room microphone — the microphone, worklet, model and
delivery are what were being tested, not recognition quality.

## Milestone 6 — package and document (done 2026-09-18)

The app builds into a `.deb` that works the way a personal app should: installed to
`/usr/bin/just-speak`, with everything it needs beside it and everything it owns in the
user's data directory.

**One file instead of a tree.** The server is bundled — dependencies included — into a
single `dist/server.js` (2 MB) with esbuild. That needs one non-obvious flag: bundling
CommonJS dependencies into ESM output otherwise dies with "Dynamic require of 'tty' is not
supported", so the build injects a `createRequire` shim. The result is that the installed
app carries no `node_modules` at all.

**Resources, and where they come from.** The shell resolves the server and the Python
worker from the bundle's resource directory when it is installed, and from the repository
when it is being developed, with `JUST_SPEAK_ROOT` overriding both. The deb lays down
`/usr/lib/Just Speak/{dist/server.js, local/, scripts/}` — the product name has a space in
it, which is why the README and the Settings hint quote those paths.

**User data belongs in user data.** The environment, models and history live in
`~/.local/share/just-speak` (the repository in development), `.env` is read from there once
installed rather than from beside the binary, and the setup script targets the same place.
The plan called this out for AppImage's read-only mount; it is now true for every install
shape.

**When something is missing, the app says so.** The shell reports why there is no API —
almost always "Node is not installed" — and the pages show it instead of looking ready.
Settings names the exact command that installs local transcription, with the paths this
install actually uses.

Verified by building the deb and running the staged binary the way an installed app runs:
it found its resources (`/usr/lib/Just Speak`), read its keys from the data directory,
found the Python environment, recorded ten seconds through the microphone, polished it,
typed it into the editor, and wrote the entry into the packaged data directory — with the
bar at its intended 820x132 and the server dying with the app. 65 TypeScript and 22 Python
tests pass, and the README is now written for someone using the app rather than for someone
who has been building it.

Known gaps: the `.deb` is unsigned and built locally; the app is X11 and Linux only; and
the Python environment is installed by a script rather than by the app itself, because
`uv` is the right tool for it and the app is not going to reimplement one.

## Bugs found by using it (2026-09-18)

The build order finished, the app was set up to stand on its own — its own Python
environment, models and keys under the repository — and then it was used. Five bugs, none
of which any test would have caught, because tests do not press buttons:

- **The studio said "loading" for ever.** The server was ready the whole time; the view read
  the status once, immediately after asking, which is by definition the moment it says
  loading, and never asked again. The lesson is general: a status that changes over minutes
  is followed, not photographed. The follow lives in `src/model-preparation.ts` with tests,
  rather than as a line inside a component.
- **The studio window could collapse to a 1040x68 sliver.** A reload unmounts the document,
  and GTK sizes the toplevel to the webview's natural size — which, for a blank page, is
  nothing. The shell now settles geometry itself, asserting until the window measures right.
  The first attempt at that fix did the asserting from a background thread, calling
  `inner_size`, which dispatches to the main thread and waits: it wedged the app so
  completely that the hotkey fired and nothing opened. Main-thread work has to run on the
  main thread, including the checks that decide whether to do more main-thread work.
- **A development build preferred a stale server.** It found a copy of `dist/server.js` beside
  the debug binary and ran that, with its own idea of the data directory — so the app had no
  keys and no Python and looked broken. Development reads the source tree first now.
- **`npm run setup:local` was broken on its first ever run.** It passed an interpreter path to
  `uv venv`, which takes a directory, so the environment was created one level too deep and
  the script exited non-zero. The script had been written two milestones earlier and never
  executed, which is exactly the gap that was flagged at the time.
- **The rec bar's scroller appeared over an empty bar, and vanished when it was pressed.**
  Whether the text needs scrolling is measured from the box itself, and the first measurement
  ran before the window had been laid out — with a width of zero, where every word takes a
  line of its own and the one-line placeholder measured 126 pixels tall. So a live down-arrow
  sat under a bar with nothing in it; pressing it measured again, this time with a real width,
  found one line, and took both buttons away. Two rules came out of it: a measurement taken
  with no width is never true, and the box's *size* is its own reason to measure again, which
  is `ResizeObserver` — text getting longer moves the words, not the box, and the box also
  narrows the moment the scroller appears beside it.

Two of these are worth more than the code that fixes them: a view that reads a slow status
once, and assertion work done from the wrong thread. The last one is that same lesson twice
removed — a measurement read once, at the one moment it could not be true.

## The status strip, and a detail box that stays built (2026-09-18)

The model control was the thing that started this. Settings offered a button that could be
pressed when there was nothing to do — if the weights were already in the cache, "Prepare
model" only re-loaded them — and it reported itself in a paragraph *above* the button:
`Ready (small.en, 6 threads)`, or a loading line, or a raw `Status: …`. State and control
were two things that could disagree, and did in two of the four cases a person can be in.

**The button is the state now**: `Start Download` → `Downloading…` → `Downloaded` →
`Restart Download`, disabled exactly when pressing it would change nothing. Answering it
needs a fact the status could not give. `status` describes what is *loaded*, which resets
at every launch; a model that has been on this computer for a week would offer to fetch
itself again. So the server answers the disk question instead — `LocalStatus.downloaded`,
from `server/model-cache.ts`, which counts a model only when a snapshot holds every file
the worker loads, present and non-empty. The hub links each file into a snapshot only once
it has finished, so an interrupted download is not mistaken for a finished one. The rules
between state and button live in `src/model-preparation.ts` with tests.

**One line for everything else.** Settings' paragraph is gone, along with Grammar's
under-the-button `.problem`, and the failures that used to have nowhere to go — a delete
that did not rewrite the markdown, a check that could not run — now go to a strip at the
foot of the detail box. Three voices share it: Settings reporting the model, the detail
box reporting itself, and the rec bar reporting what a recording did. The rule between them is
`nextNotice` in `src/studio/notice.ts`, with tests: the newest message wins, silence clears
only the voice that went silent, and a voice repeating itself changes nothing. That last
clause is load-bearing — the model's message is re-derived on every status poll, and
without it the poll would keep erasing the bar's account of a paste that never landed.

**The rec bar speaks into that strip**, which is why the detail box is now built once and
hidden rather than closed. A window that has to be rebuilt is a window that never hears the
message, and the message is most worth having precisely when nobody is looking at the
detail box: the rec bar is where a paste fails, and the detail box is where you go to read
about it. Complaints cross as a Tauri event (`detail-notice`), and being asked for again
fires `detail-shown` — which the page answers by re-reading everything it shows, because a
resident window is a window that can be out of date. That is the cost, and the re-read is
the whole fix for it: opening the detail box after a recording shows the recording.

**Being asked for again was not the whole of it** (found by using it, 2026-09-19). The
re-read happens when someone asks for the box, and the two windows are small enough to sit
on the same screen: record with the detail box already open and in front of you, and nobody
asks for anything — the rec bar's own line updates, and the box goes on showing the list it
read before the recording existed. So the rec bar says so. Once the entry is on disk it
posts `history-changed` down the same channel, and the detail box answers it exactly as it
answers `detail-shown`. It is deliberately not guarded by the revision, and it is posted
after the write rather than after the recording ends: what changed is the file, and the box
is about to read the file back.

Two signals for one idea, then — a window that is being asked for, and a window that is
already being looked at — which is cheaper than the alternative that suggests itself: one
window instead of two. The rec bar is non-focusable because focus has to stay in the target
application while you speak, and that is the property the whole insertion design rests on;
a title bar and a tab strip in the same window as the record button is exactly the way to
lose it.

What this gives up: a notice posted before the detail box has *ever* been opened is not
heard — the rec bar has no line of its own to say it in, and that is the trade this made
(see below). And the claim in the studio milestone above — that the two windows share
nothing but the history — is now one thing less true. They share the history, and the rec
bar's last complaint.

Two smaller things came out of the same pass: Settings is reachable with no recordings at
all (it holds the only control that downloads a model, so it cannot sit behind having
spoken once already), and the detail box reopens on the tab and the recording you left it
on, because it is no longer rebuilt between looks.

**The rec bar stopped reporting, and both windows were renamed (2026-09-18).** The rec bar
used to carry a line under the text — the readiness warning, the telemetry of a good
insertion, or the reason a paste did not land. With a strip that exists to be read, that
line was a second place for the same words, and the worse of the two: a strip you can
scroll back through, in a window with room to explain, against an eleven-pixel line in a
strip that must never grow. It is gone, and everything the rec bar used to say there now
crosses to the strip — including the one message it said at startup, that local
transcription is not installed. What the rec bar keeps is what only it can show: what is
being heard, what it became, and the buttons. The telemetry that line also carried — how
many characters, how many milliseconds — is still printed to the terminal, where it was
always the more useful copy.

That makes the two windows' names wrong: one was never a bar with a line, and the other
was never a studio. They are the **rec bar** and the **detail box**, in the language file,
in the interface, and in the code — `src/rec-bar/` and `src/detail/`, `RecBar` and
`DetailBox`, the window labels `rec-bar` and `detail`, and the events `detail-notice` and
`detail-shown`. Milestones above are left as they were written; they describe what was
built when it was called something else.

**The bar's buttons are Details and Exit (2026-09-18).** Copy and Clear are gone, and Exit
takes their place. Copy answered "the paste did not land", but that case already leaves the
text on the clipboard and says so in the strip — the button was a second way to do what the
app had just done, and the one that needed the user to notice first. Clear was for a
recording you did not mean to start, and it was the only caller of `Session.cancel()`, so
the whole `cancel` path went with it: the client method, the request in `shared/types.ts`,
and the branch in `server/stream.ts`. A mistake is now ended by pressing stop, the same
button that started it. The worker-side cancel stays — the server still uses it when a
socket closes or a recording is stopped — but the browser can no longer ask for one.

Exit is the thing the window could not do at all. The rec bar has no frame and is never
focused, so there is no title bar to close, and the terminal that started it was the only
way out. The button invokes a `quit` command — `AppHandle::exit`, which is the same
`RunEvent::Exit` the window manager would have caused, and the same shutdown that stops the
server and gives the port back. It is deliberately not disabled while recording: asking to
leave is reason enough to stop.

**The text scrolls, under buttons (2026-09-18).** Two lines is what the bar is tall, and a
spoken paragraph is longer than two lines: the words used to be cut off mid-sentence with no
way to reach the rest. The box scrolls now, a line per click, under a small `▲` `▼` beside
the words — the sketch's scroller. Buttons rather than a scrollbar, for the reason the bar
has no keyboard: it can never be focused, so nothing here may depend on focus, and a
scrollbar in the corner is a target that appears and disappears. The scroller itself appears
only when the text is longer than the box, and greys each button at the end it has reached.

Two things were decided by what the window cannot do. The wheel works as well, but only as a
bonus — `overflow-y: auto` with the scrollbar hidden — because the pointer is not guaranteed
to be anywhere near the words; the buttons are the control and the wheel is not. And a new
segment does **not** yank the view back to the top: the text only ever grows, the browser
clamps the position when a new recording clears it, and someone reading the middle of a long
sentence while the next one arrives keeps their place.

Whether the text overflows at all is *measured*, never tracked — and the first version of
that measured too early, which is the fifth bug in the list above: an empty bar with a live
scroller on it.

**Compare reads newest first, and keeps its dates to itself (2026-09-18).** The history file
is written oldest first because it is a chronicle, and both lists were drawn in that order —
so the window opened on the *oldest* recording, with the one just made at the bottom, which
is not what anyone opens it for. Compare is a picker, not a chronicle: its list runs newest
first, and a first look now selects the newest. History is left reading as it happened.

The date sat on every row and was wanted on almost none: the sentence is how you find a
recording, and when it was said is what you check once you have found it. So the date is
invisible until the row is pointed at — or tabbed to, since this window has a keyboard in
front of it — and it keeps the line it always had, above the sentence.

The first version of that swap *replaced* the sentence with the date, which failed on use
for a reason worth remembering: the row you are pointing at is the row you are about to
click, and it was the one row that went blank. The date is now hidden with `opacity` rather
than removed, so its line stays reserved and revealing it moves nothing; the sentence is
never covered and never displaced. Point below rather than above the sentence was the other
option; above is where the date has always been, so that is where it stays.

**The History tab folded into Compare (2026-09-18).** Two lists of the same recordings, in
two orders, where one would do: Compare gets the delete, and History's tab goes. The list
was already a picker — newest first, the date on a line that only appears when the row is
under the pointer — and deleting belonged on the same row rather than in a second view of
it. The duration came across too, onto the date line, since that line is where a recording's
metadata lives and History was the only place the number was shown at all.

Deleting is two clicks, and that was the point of setting it apart: the `✕` appears exactly
where the pointer already is, beside a row someone is about to select, and a delete rewrites
the file with nothing to undo it. So `✕` becomes `Delete?`, the date moves aside to make
room rather than being covered, and pointing or tabbing away takes the offer back. The
delete itself is unchanged — the markdown is the history, so it is a rewrite without that
entry's block.

**A recording's length was zero whenever speaking coaching was off**, which the merge put on
screen: History had been printing `0s` for those recordings all along. The length was being
taken from the audio kept for coaching, and that copy only exists when the setting is on —
so the number measured a setting rather than a recording. It now comes from the recorder's
own sample count, which is what the rec bar has always printed to the terminal.

## Module map

### Ported from v1, approximately unchanged

Reference implementation: **`/home/lin/ai/openai/just_speak_codex`** — frozen. Read it freely, never edit it. It has its own git history, a populated `.env`, a working `.venv`, and both Whisper models already downloaded.

| v1 file | Change |
| --- | --- |
| `public/recorder-worklet.js` | Parametrize the recording cap (2 min → 10 min). |
| `src/audio.ts` | Add the `{audio: true}` retry; confirm the worklet URL resolves under `tauri://localhost`. |
| `server/audio.ts` | Unchanged — WAV validation still guards the final clip. |
| `server/errors.ts` | Unchanged. |
| `local/worker.py` | Substantially rewritten — see *Streaming protocol*. |
| `local/test_worker.py` | Kept and extended; the stdlib-only, fake-`faster_whisper` approach still works. |
| `server/providers.ts` | **Delete** the OpenAI transcription adapter and the `X-Transcription-Provider` header. Keep polish, language feedback, speaking feedback. |
| `shared/types.ts`, `shared/schemas.ts` | Extended for segments and the streaming session. |
| `scripts/setup-local.mjs` | Reconcile the Python 3.12 request with the 3.10 venv that actually exists; make the model cache location configurable. |

### Rewritten

- `src/App.tsx`, `src/Workspace.tsx`, `src/TranscriptionSettings.tsx` → the bar and the studio.
- `src/history.ts` → a client for server-side markdown, no IndexedDB.
- `src/session.ts` → a streaming session model. Keep its discipline (injected `Api`, no DOM, revision-guarded against stale responses); change its shape from request/response to event stream.

### New

- `src-tauri/` — the Rust shell: permission handler, window management, global shortcuts, insertion, server child process.
- `local/segmenter.py` — energy-gate segmentation (see below).
- `server/history.ts` — markdown read/write.
- `server/stream.ts` — the WebSocket endpoint.
- `src/shell/` — the `Shell` interface plus its Tauri and Electron implementations.

## Streaming protocol

**Browser ⇄ server: one WebSocket** at `/api/stream`. The browser captures continuously and sends 16-bit mono PCM at 24 kHz in ~100 ms frames. It never decides where sentences end.

Client → server: `start`, binary PCM frames, `stop`. (There was a `cancel`; a recording is
now ended by stopping it, and abandoned by the socket simply closing — the same thing the
server did on a cancel.)

Server → client: `ready`, `segment {index, text, startMs, endMs}`, `done {text}`, `error`.

**Segmentation happens in Python, not the browser.** The worker already has `faster-whisper` and numpy, and moving the decision there keeps the browser dumb and the logic unit-testable in pure Python. The gate:

- Measure ambient noise over the first ~300 ms of a recording and set the speech threshold above it.
- Close a segment after ~400 ms below threshold, or force-cut at ~15 s so text keeps flowing through long unbroken speech.
- Discard segments under ~300 ms, and discard transcripts whose `no_speech_prob` is high. This is the hallucination guard — Whisper invents "Thank you." on near-silence, and short isolated segments are exactly where it does it.
- Pass the previous segment's text as `initial_prompt` so the model keeps context.

**Polishing is two calls, not one.** Each segment is polished as it closes, giving the streaming preview; on stop, one final polish over the whole assembled transcript produces the text that actually gets inserted. Polishing a fragment is worse than polishing a whole — which is why the preview is a preview.

**Use `qwen-3.8-27b` with `reasoning_effort: none` for both.** `gpt-oss-120b` cannot disable reasoning at all, and reasoning tokens are pure latency on a call that must finish inside a pause.

**Cancellation must not kill the process.** v1 SIGKILLs the worker on cancel, which forces a model reload next time — tolerable for one-shot requests, fatal for a stream. The worker instead keeps reading stdin and honours `cancel` at the next read boundary; SIGKILL remains only for a genuinely wedged process. The server replaces its single-slot "one request at a time, else 409" design with a queue, and lets stdin backpressure propagate rather than dropping audio.

## Shell interface

```
startHotkey(which, handler)   insertText(text)   showBar(mode)   requestMicAccess()
```

Two implementations: `shell/tauri/` and `shell/electron/`. Nothing else in the app may import a shell API directly — the spike's kill criterion depends on that being true.

**Insertion is clipboard-paste, not simulated typing**: set clipboard → synthesize `Ctrl+V` → restore the previous clipboard once the paste has been consumed. Simulated typing cannot reliably produce arbitrary Unicode — both `enigo` and `xdotool` remap keysyms and have open bugs for non-ASCII — so typing is a last resort, not the default. This is the same stack shipping Tauri dictation apps use. Design for the documented failure modes: clobbering the clipboard, the target reading it *after* the restore (stale text), terminals wanting `Ctrl+Shift+V`, clipboard managers, and held modifier state.

The failure path is explicit — if no editable field has focus, leave the text in the bar, copy it, and say so. Never lose the words.

## Server changes

- Accept the `tauri://localhost` origin, and send the matching `Access-Control-Allow-Origin`. v1 rejects everything but `http://localhost:<port>`, so every API call 403s today.
- Add `GET`/`POST /api/history` for markdown read/append/rewrite.
- Add `WS /api/stream`; validate the `Origin` header on the handshake.
- Remove the OpenAI transcription route and its adapter.
- Make the model-cache path configurable, and pin `DOTENV_CONFIG_PATH`.
- Keep the "keys never reach the browser" and "worker gets no keys or HF tokens" guarantees — both are already asserted in v1's tests and should stay asserted.

## Packaging

`.venv` and `.local-models` (~150 MB, and ~600 MB with `small.en`) cannot live inside an AppImage: it mounts read-only and ephemerally, so the app would re-download the model on every launch. They move to a writable app-data directory (`~/.local/share/just-speak/`), which is the same change that makes the cache path configurable. A `.deb` avoids the read-only problem but not the "user data belongs in user data" problem, so do the relocation either way.

## Build order

Each milestone ends in something runnable and verifiable.

1. ~~**Spike** — Phase 0 above. Decide Tauri vs Electron and record why.~~ **Done
   2026-09-17: Tauri.** Electron would have cost ~282 MiB and bought nothing the spike
   still needed.
2. ~~**Server reshape** — origin/CORS, drop cloud transcription, markdown history
   endpoints, WebSocket skeleton, cache path, `DOTENV_CONFIG_PATH`, tests updated.~~ **Done
   2026-09-17** (see above); 43 TypeScript tests and 3 Python tests pass.
3. ~~**Worker streaming** — segmentation, per-segment events, cancel-without-kill,
   queueing. Pure-Python tests throughout.~~ **Done 2026-09-18** (see above); verified
   against real speech through the real endpoint.
4. ~~**Bar** — non-focusable window, record hotkey, live segments, per-segment polish,
   final polish on stop, insertion, failure fallback.~~ **Done 2026-09-18** (see above);
   driven end to end by hotkey into a real editor, and the fallback exercised live.
5. ~~**Studio** — five tabs, lazy coaching, Grammar recomputed for past entries and
   cached, Settings with a visible audio-memory figure. The studio hotkey dispatches to the
   main thread rather than building a window in the handler.~~ **Done 2026-09-18** (see
   above); opened by hotkey and by the bar, and walked through every tab.
6. ~~**Package and document** — relocate the venv and model cache, bundle, rewrite the
   README.~~ **Done 2026-09-18** (see above); verified by running the packaged binary the way
   an installed app does.

## Verification

v1's unit tests for WAV validation, the worklet, and provider routing survive and should be ported. v1's Playwright suite does **not** — four of its five tests fail today at a locator for a button that no longer exists, and it tests a UI that is being replaced.

New coverage: segmentation boundaries (pure Python), stale-segment handling, the streaming session's revision guard, markdown append/rewrite.

Shell behaviours — global hotkey, non-focusable bar, insertion into another application — cannot be tested cheaply by automation. They get a written manual checklist run before each milestone is called done, and that checklist lives in the repo rather than in someone's head. The checklist's first item is Phase 0 step 4, because that is the one that decides the shell.

## Deferred, deliberately

Wayland support · macOS and Windows · real phoneme-level pronunciation assessment (a dedicated API, not an LLM) · progress analytics over history · audio persistence · any UI for editing the original transcript of a past recording.
