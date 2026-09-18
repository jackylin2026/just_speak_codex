//! Putting text into whatever application has focus.
//!
//! Clipboard paste, not simulated typing: arbitrary Unicode cannot be typed reliably,
//! because both enigo and xdotool remap keysyms and have open bugs for non-ASCII. The
//! sequence is set the clipboard, synthesize Ctrl+V, wait for the target to read it, put
//! the previous contents back.
//!
//! All of it happens on one dedicated thread that owns the clipboard for the life of the
//! app. On X11 the selection is served by the process that set it, so a clipboard that is
//! dropped takes every other application's paste with it; and reading the clipboard on the
//! GTK main thread can deadlock the whole app.

use std::process::Command;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertResult {
    pub ok: bool,
    pub detail: String,
}

struct Job {
    text: String,
    reply: Sender<InsertResult>,
}

#[derive(Clone)]
pub struct Inserter(Arc<Mutex<Sender<Job>>>);

impl Inserter {
    pub fn spawn() -> Inserter {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("just-speak-insert".into())
            .spawn(move || {
                let mut clipboard = match arboard::Clipboard::new() {
                    Ok(clipboard) => clipboard,
                    Err(error) => {
                        println!("[shell] insertion unavailable: {error}");
                        return;
                    }
                };
                for job in rx {
                    let result = paste(&mut clipboard, &job.text);
                    println!("[shell] insert: {}", result.detail);
                    let _ = job.reply.send(result);
                }
            })
            .expect("insertion thread");
        Inserter(Arc::new(Mutex::new(tx)))
    }

    /// Hand the text to the insertion thread and wait for what happened to it. Blocking:
    /// the caller is off the main thread, which is the point.
    pub fn insert(&self, text: String) -> Result<InsertResult, String> {
        let (reply, result) = mpsc::channel();
        self.0
            .lock()
            .map_err(|_| "insert queue poisoned".to_string())?
            .send(Job { text, reply })
            .map_err(|error| error.to_string())?;
        result
            .recv()
            .map_err(|error| format!("insertion thread stopped: {error}"))
    }
}

/// The window that has focus, as X sees it: its id and its class.
fn active_window() -> Option<(String, String)> {
    let root = Command::new("xprop")
        .args(["-root", "_NET_ACTIVE_WINDOW"])
        .output()
        .ok()?;
    let id = String::from_utf8_lossy(&root.stdout)
        .split_whitespace()
        .last()?
        .to_string();
    if id == "0x0" {
        return None;
    }
    let props = Command::new("xprop")
        .args(["-id", &id, "WM_CLASS"])
        .output()
        .ok()?;
    Some((id, String::from_utf8_lossy(&props.stdout).to_lowercase()))
}

/// Whether a window belongs to us. Pasting into our own window would put the text
/// somewhere the user cannot see it land.
fn is_ours(class: &str) -> bool {
    ["just_speak_codex", "just-speak", "justspeak", "com.justspeak"]
        .iter()
        .any(|ours| class.contains(ours))
}

fn paste(clipboard: &mut arboard::Clipboard, text: &str) -> InsertResult {
    let started = Instant::now();
    let target = active_window();

    // Nowhere to type. Never lose the words: they stay in the bar and go to the clipboard
    // so they can be pasted by hand.
    let nowhere = match &target {
        None => Some("No window has focus"),
        Some((_, class)) if is_ours(class) => Some("The text would land in just_speak_codex itself"),
        // Clicking the desktop gives focus to GNOME Shell's own window, whose class is
        // "gjs" — the name of the runtime, not the shell.
        Some((_, class)) if class.contains("gnome-shell") || class.contains("\"gjs\"") => {
            Some("The desktop has focus")
        }
        _ => None,
    };
    if let Some(reason) = nowhere {
        return match clipboard.set_text(text.to_string()) {
            Ok(()) => InsertResult {
                ok: false,
                detail: format!("{reason}. The text is on your clipboard instead."),
            },
            Err(error) => InsertResult {
                ok: false,
                detail: format!("{reason}, and the clipboard could not be written: {error}"),
            },
        };
    }

    let previous = clipboard.get_text().ok().filter(|old| !old.is_empty());
    if let Err(error) = clipboard.set_text(text.to_string()) {
        return InsertResult {
            ok: false,
            detail: format!("The clipboard could not be written: {error}"),
        };
    }

    // Let the selection settle before the target reads it.
    std::thread::sleep(Duration::from_millis(40));

    let typed: Result<(), String> = {
        use enigo::{Direction, Enigo, Key, Keyboard};
        match Enigo::new(&enigo::Settings::default()) {
            Ok(mut enigo) => {
                let mut attempt = || -> Result<(), enigo::InputError> {
                    enigo.key(Key::Control, Direction::Press)?;
                    enigo.key(Key::Unicode('v'), Direction::Click)?;
                    enigo.key(Key::Control, Direction::Release)?;
                    Ok(())
                };
                attempt().map_err(|error| error.to_string())
            }
            Err(error) => Err(format!("input simulation unavailable: {error}")),
        }
    };

    // The target reads the selection asynchronously; restoring sooner than this is the
    // documented "stale text" race, restoring not at all is the documented clobber.
    std::thread::sleep(Duration::from_millis(300));
    let restored = match &previous {
        Some(previous) => clipboard.set_text(previous.clone()).is_ok(),
        None => false,
    };

    match typed {
        Ok(()) => InsertResult {
            ok: true,
            detail: format!(
                "{} characters where you were typing, in {} ms, clipboard {}",
                text.chars().count(),
                started.elapsed().as_millis(),
                if restored {
                    "restored"
                } else if previous.is_some() {
                    "not restored"
                } else {
                    "was empty"
                }
            ),
        },
        Err(error) => InsertResult {
            ok: false,
            detail: format!("The paste did not go through ({error}). The text is on your clipboard."),
        },
    }
}
