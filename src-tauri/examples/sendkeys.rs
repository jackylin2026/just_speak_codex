//! Sends key chords through XTEST — the same mechanism insertion uses.
//!
//! `cargo run --example sendkeys -- "ctrl+shift+space"`
//!
//! This exists so the global-hotkey path can be driven from a script during the spike.
//! It is not part of the app.

use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

fn parse(name: &str) -> Key {
    match name {
        "ctrl" | "control" => Key::Control,
        "shift" => Key::Shift,
        "alt" => Key::Alt,
        "space" => Key::Space,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" => Key::Delete,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        other => Key::Unicode(other.chars().next().expect("empty key name")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: sendkeys \"ctrl+shift+space\" | click X Y | move X Y");
        std::process::exit(2);
    }

    let mut enigo = Enigo::new(&Settings::default()).expect("XTEST unavailable");
    let mut chords: Vec<String> = Vec::new();
    let mut rest = args.into_iter().peekable();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "click" => {
                flush(&mut enigo, &mut chords);
                let x: i32 = rest.next().expect("click X Y").parse().expect("x");
                let y: i32 = rest.next().expect("click X Y").parse().expect("y");
                enigo
                    .move_mouse(x, y, Coordinate::Abs)
                    .expect("move mouse");
                std::thread::sleep(std::time::Duration::from_millis(150));
                enigo
                    .button(Button::Left, Direction::Click)
                    .expect("click");
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            "move" => {
                flush(&mut enigo, &mut chords);
                let x: i32 = rest.next().expect("move X Y").parse().expect("x");
                let y: i32 = rest.next().expect("move X Y").parse().expect("y");
                enigo
                    .move_mouse(x, y, Coordinate::Abs)
                    .expect("move mouse");
            }
            chord => chords.push(chord.to_string()),
        }
    }
    flush(&mut enigo, &mut chords);
}

fn flush(enigo: &mut Enigo, chords: &mut Vec<String>) {
    if chords.is_empty() {
        return;
    }
    let chords = std::mem::take(chords);
    for chord in chords {
        let keys: Vec<Key> = chord.split('+').map(parse).collect();
        let (last, modifiers) = keys.split_last().expect("empty chord");
        for key in modifiers {
            enigo.key(*key, Direction::Press).expect("press modifier");
        }
        enigo.key(*last, Direction::Click).expect("click key");
        for key in modifiers.iter().rev() {
            enigo.key(*key, Direction::Release).expect("release modifier");
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
}
