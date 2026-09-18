# just_speak_codex

Speak English, and the words you said — tidied up — are typed into whatever application you
were already typing in. Open the detail box afterwards and it will tell you what to work on.

It is a personal dictation and English-practice tool for one person on Ubuntu. There are no
accounts, no cloud history, and no analytics. Recognition runs on your computer; the
recording is never uploaded to be transcribed.

## What you need

- **Ubuntu on X11.** Not Wayland: the global shortcut this app is built around is X11-only,
  and window positioning is a no-op there.
- **Node.js 22.12 or newer.** The app runs its API as a Node process, so Node has to be
  installed even in a packaged build.
- **`uv`** for the Python environment that does recognition
  ([install](https://docs.astral.sh/uv/getting-started/installation/)).
- A microphone.

## Install

### From a package

```bash
npm run tauri build                     # produces target/release/bundle/deb/*.deb
sudo dpkg -i "src-tauri/target/release/bundle/deb/just_speak_codex_0.1.0_amd64.deb"
```

The package installs `/usr/bin/just_speak_codex`, and keeps its resources under
`/usr/lib/just_speak_codex/`.

Then give it a Python environment and your API keys. Nothing is downloaded during
recognition; preparing a model is the only time it reaches the network.

```bash
JUST_SPEAK_DATA_DIR=~/.local/share/just-speak \
  node "/usr/lib/just_speak_codex/scripts/setup-local.mjs"
cp .env.example ~/.local/share/just-speak/.env   # then fill in your keys
```

### From source

```bash
npm install
cp .env.example .env
npm run setup:local                    # creates .venv and installs faster-whisper
npm run tauri dev
```

The app starts the API server itself, unless one is already listening on the port — which
is what makes `npm run dev:server` useful while working on the server half.

## Using it

A strip sits at the bottom of the screen and never takes focus. That is the whole point:
whatever you were typing in keeps focus, and the text arrives there.

| Shortcut | What it does |
| --- | --- |
| `Ctrl+Shift+Space` | Start recording; press again to stop and insert |
| `Ctrl+Shift+S` | Open the detail box |

While you speak, the rec bar fills with the text as it is recognised, a segment at a time
— the pause is what ends a piece, and the rec bar shows each piece cleaned up as it lands.
When you stop, the whole thing is polished once more, and *that* is what gets typed.

Two lines is all the bar shows at once. Past that the text scrolls: the small `▲` `▼` beside
the words move it a line per click, greying out when there is nothing further that way.

If nothing can receive the text — the desktop has focus, or you are looking at just_speak_codex
itself — the words go to your clipboard instead, and the detail box's status strip says so.
The words are never lost.

The bar carries two buttons: **Details**, which opens the detail box, and **Exit**, which
quits. The bar has no window frame, so without it the terminal that started the app would be
the only way out.

The detail box has four tabs:

- **Compare** — what you said beside what it became. The difference is the point. The list
  down the left runs newest first, and a row shows its date — and how long it ran — only
  while you point at it. Deleting is two clicks on that line: the ✕, then `Delete?`.
- **Grammar** — corrections and a practice line. Checked when you ask, then kept.
- **Speak** — how it sounded, if you have speaking coaching switched on.
- **Settings** — the model, speaking coaching, and how much audio is in memory.

## Where your data lives

Everything is under the data directory: `~/.local/share/just-speak` when installed,
the repository when running from source.

The data directory, app identifier, preference key, and `JUST_SPEAK_*` environment
variables retain their original names so existing history, models, and settings remain available.

| What | Where |
| --- | --- |
| Your history | `history/entries.md` — plain markdown, yours to read and edit |
| Recordings | Nowhere. Audio is held in memory while it is being used |
| API keys | `.env` in the data directory |
| Models and Python | `.local-models/`, `.venv/` |

The history is the app's database and its notebook at the same time: each recording is a
section with the original and the polished text, and the coaching is written into the same
section when you ask for it. Editing or deleting a section by hand is supported — the app
reads it back the next time it opens.

## What leaves your computer

- **Recognition: nothing.** Whisper runs locally, on the CPU.
- **Transcripts** go to Cerebras for polishing and grammar feedback. This happens on every
  recording.
- **Audio** goes to OpenAI only if you turn on speaking coaching, and only then. It is one
  capability, not a general-purpose pipe.
- **Nothing else.** There is no telemetry, and no history in the cloud.

Read your providers' data policies before recording anything sensitive.

## Configuration

All optional except the keys, and all read from `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | Speaking coaching only |
| `CEREBRAS_API_KEY` | — | Polishing and grammar feedback |
| `OPENAI_AUDIO_MODEL` | `gpt-audio` | Model that accepts audio |
| `CEREBRAS_MODEL` | `qwen-3.8-27b` | Text model with JSON schema support |
| `CEREBRAS_REASONING_EFFORT` | `none` | Set to `omit` if your model rejects it |
| `PORT` | `3000` | Local API port, 1024–65535 |
| `JUST_SPEAK_DATA_DIR` | `~/.local/share/just-speak` | Where history, models and the venv live |
| `LOCAL_MODELS_DIR` | `<data>/​.local-models` | Model cache, if you want it elsewhere |
| `LOCAL_WHISPER_PYTHON` | `<data>/​.venv/bin/python` | Interpreter, if you have your own |
| `LOCAL_WHISPER_THREADS` | up to 6 | CPU threads for recognition |
| `DOTENV_CONFIG_PATH` | `<data>/​.env` | Where to read keys from |

Never name a secret with a `VITE_` prefix. The browser side is served configuration
readiness, model names and status only — never a key.

## Limits worth knowing

- **Recognition makes mistakes, and it tidies as it goes.** Whisper normalises grammar and
  can drop words. Compare what you see against what you remember saying before treating a
  correction as evidence about your speech.
- **Speaking coaching is advice, not assessment.** It is a language model listening to your
  recording, not a validated pronunciation test. It can miss things and invent things; the
  goal is being understood, not sounding like a native speaker.
- **A recording stops at ten minutes**, and the last piece is cut at fifteen seconds of
  unbroken speech.
- **The detail box re-reads when it is shown.** Put it away and open it again after
  recording, and the new recording is there.
- **X11 only**, and Linux only.

## Development

```bash
npm test                                          # API, history, session, streaming
python3 -m unittest discover -s local             # segmentation and the worker protocol
npm run typecheck
npm run build                                     # frontend + server bundle
npm run tauri build                               # the .deb
node scripts/stream-check.mjs speech.wav 3000     # stream a file through the real endpoint
```

`docs/plan.md` is the build plan and the record of what was verified, including the
measurements behind decisions that would otherwise look arbitrary. `docs/checklist.md` is
the by-hand pass for the parts tests cannot reach: that the window manager leaves focus
alone, that the words arrive in another application, and that the hotkey works when
something else has focus. `CONTEXT.md` is the
vocabulary the code and the docs are expected to use.

The pieces: `src-tauri/` is the desktop shell (windows, hotkeys, insertion, the server
process), `src/rec-bar/` and `src/detail/` are the two windows, `src/session.ts` is what a
recording is, `server/` is the local API, and `local/` is the Python that does recognition
and decides where sentences end.

MIT licensed; see [LICENSE](LICENSE).
