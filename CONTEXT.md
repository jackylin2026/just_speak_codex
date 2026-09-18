# just_speak_codex

A personal dictation and English-practice tool for one user on Ubuntu. Speak English, get clean text inserted into whatever application you were already typing in, and get feedback worth learning from.

## Language

**Recording**:
One press of Record to one press of Stop. Owns an original transcript, polished text, segments, and feedback.
_Avoid_: session, clip, capture, take

**Segment**:
A stretch of continuous speech between pauses, transcribed and polished as a unit while you are still speaking.
_Avoid_: chunk, utterance, phrase, block

**Original transcript**:
The literal speech-to-text output, never edited by a model.
_Avoid_: transcription, recognition, raw text, original version

**Polished text**:
The copyable result of the polish step.
_Avoid_: transcription, optimized sentence, polished version, result

**Polish**:
The LLM step that turns an original transcript into polished text — fixing errors and improving wording without changing meaning.
_Avoid_: optimize, rewrite, clean up, enhance

**Language feedback**:
Teaching about grammar, collocations, expression, and idiom, derived from the original transcript. Shown on the Grammar tab.
_Avoid_: grammar check, corrections, text feedback

**Speaking feedback**:
Teaching about pronunciation and delivery, derived from the recording's audio. Shown on the Speak tab.
_Avoid_: audio feedback, pronunciation score, voice feedback

**Rec bar**:
The always-visible, never-focusable strip at the bottom of the screen. Shows polished text as it forms and holds the record control.
_Avoid_: bar, compact mode, dock, overlay, mini window

**Detail box**:
The focusable window holding the five tabs. Opened from the rec bar, and put away rather
than closed: it is built once, hidden when you are done with it, and re-reads what it shows
when it is asked for again.
_Avoid_: studio, extended mode, panel, expanded view, dashboard

**Tab**:
One of the four detail box views: Compare, Grammar, Speak, Settings.
_Avoid_: page, panel, screen

**Status strip**:
The single line at the foot of the detail box where the tool says what it is doing or what
went wrong — one message at a time, silent when there is nothing to say. The rec bar's
failures are said there too, since the rec bar is where they happen and the detail box is
where they are read.
_Avoid_: status bar, footer, log, toast, notification

**Target app**:
The application holding focus when a recording starts, and the one that receives the polished text.
_Avoid_: destination, host app, foreground app

**Insertion**:
Delivering polished text into the target app's focused field.
_Avoid_: typing, injection, paste
