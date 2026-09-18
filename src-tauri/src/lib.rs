//! The desktop shell: two windows, a global shortcut, insertion, and the server.
//!
//! The rec bar is the whole product surface while you are speaking. It is never focusable —
//! `focusable: false` in the config, plus `gtk_window_set_focus_on_map(false)`, which Tauri
//! does not expose — so that focus stays in the application you were already typing in,
//! which is where the words have to land.
//!
//! It is created hidden and shown only once its page has laid out and its size and
//! position have been set. GTK otherwise sizes a window to whatever its webview asks for,
//! and WebKitGTK's idea of that is the document height: measured, that produced windows of
//! 237, 182 and 145 pixels for a 108-pixel bar, depending on timing. Nothing is mapped
//! until the geometry is known, so nothing can flash at the wrong size.
//!
//! The detail box, by contrast, is built once and then hidden rather than closed, because it
//! is where the rec bar's failures are written down: the rec bar is the window that sees a paste
//! fail, and the detail box is the window you read about it in afterwards. That is also why
//! the rec bar's `report` lines and its notices both leave the pages.

mod insert;
mod server;

use std::path::PathBuf;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use insert::Inserter;
use server::Server;

const REC_BAR: &str = "rec-bar";
const DETAIL: &str = "detail";

/// Each page knows the size it draws at — its stylesheet pins it, and it asks for that
/// size when it is ready — so what is left here is how far the rec bar sits above the bottom
/// edge, and how big the detail box opens.
const BAR_MARGIN: i32 = 48;

/// Big enough for the original and the polished text side by side.
const DETAIL_WIDTH: f64 = 1040.0;
const DETAIL_HEIGHT: f64 = 680.0;

/// Origins permitted to use the microphone. The webview only ever loads our own frontend,
/// but the permission handler is the one place where a mistake hands the microphone to
/// whatever document happens to be loaded, so the check is explicit rather than a blanket
/// allow. WebKitGTK has no permission UI at all and denies silently.
#[cfg(target_os = "linux")]
const ALLOWED_ORIGINS: [&str; 2] = ["tauri://localhost", "http://localhost:1420"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    port: u16,
    data_dir: String,
    version: String,
    /// Set when the API could not be started: the page has no other way to find out.
    problem: Option<String>,
}

struct ShellState {
    inserter: Inserter,
    server: Server,
    info: ShellInfo,
}

#[tauri::command]
fn shell_info(state: tauri::State<'_, ShellState>) -> ShellInfo {
    state.info.clone()
}

#[tauri::command]
async fn insert_text(
    text: String,
    state: tauri::State<'_, ShellState>,
) -> Result<insert::InsertResult, String> {
    let inserter = state.inserter.clone();
    // Off the main thread, and off the async runtime's own threads too: the clipboard and
    // the keystroke take hundreds of milliseconds by design.
    tauri::async_runtime::spawn_blocking(move || inserter.insert(text))
        .await
        .map_err(|error| error.to_string())?
}

/// Prints a line from the frontend into the terminal running the app, for the moments
/// when the rec bar cannot be inspected in a browser.
#[tauri::command]
fn report(line: String) {
    println!("[rec-bar] {line}");
}

/// Quit, from the rec bar's Exit button.
///
/// The rec bar has no frame and is never focused, so there is no title bar to close and no
/// keyboard to type `Ctrl+C` at: without this, the terminal it was started from is the only
/// way out. `exit` runs the same shutdown the window manager would — `RunEvent::Exit` stops
/// the server, which is what gives the port back.
#[tauri::command]
fn quit(app: AppHandle) {
    println!("[shell] quit from the rec bar");
    app.exit(0);
}

/// Put a window where it belongs and show it.
///
/// Called by the page itself once it has loaded, because that is the first moment the
/// webview has stopped asking to be a different size.
/// Whether a window has the size it was asked for, allowing for the display scale.
fn settled(window: &tauri::WebviewWindow, width: f64, height: f64) -> bool {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .inner_size()
        .map(|size| {
            size.width == (width * scale).round() as u32
                && size.height == (height * scale).round() as u32
        })
        .unwrap_or(false)
}

#[tauri::command]
fn show_window(app: AppHandle, label: String, width: f64, height: f64) -> Result<String, String> {
    let window = app.get_webview_window(&label).ok_or("no such window")?;
    let fixed = label == REC_BAR;
    let size = size_and_place(&window, width, height, fixed).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    if label == DETAIL {
        // An ordinary window, so it should come up ready to type in: without this the
        // window manager leaves focus where it was. Measured in the spike.
        let _ = window.set_focus();
    }

    // Keep asserting the geometry until it holds. GTK sizes a toplevel to its child's
    // natural size, and the child is a webview whose page can reload — measured, a reload
    // collapsed the detail box to 1040x68 while the page's own re-assertions had already run.
    // The shell knows the size it wants, so the shell is what insists on it.
    settle_later(app, label, width, height, fixed, 12);

    Ok(size)
}

/// Assert a window's geometry again shortly, on the main thread, until it holds.
///
/// Each attempt runs *on* the main thread rather than dispatching to it: `inner_size` and
/// `current_monitor` dispatch and wait, and a background thread calling them while the
/// main thread is busy is how a window manager ends up with a window that never opens
/// again.
fn settle_later(app: AppHandle, label: String, width: f64, height: f64, fixed: bool, attempts: u32) {
    if attempts == 0 {
        println!("[shell] {label}: gave up settling at the size that was asked for");
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let next = attempts - 1;
        let settled_label = label.clone();
        if let Err(error) = app.clone().run_on_main_thread(move || {
            let Some(window) = app.get_webview_window(&settled_label) else {
                return;
            };
            if settled(&window, width, height) {
                return;
            }
            let _ = size_and_place(&window, width, height, fixed);
            settle_later(app.clone(), settled_label, width, height, fixed, next);
        }) {
            println!("[shell] {label}: could not settle: {error}");
        }
    });
}

/// Open the detail box, creating it the first time.
///
/// Never called from the shortcut handler itself: that runs on the plugin's own event
/// loop thread and holds a mutex, while building a window is main-thread work that can
/// wait on the event loop. Dispatch, then return.
fn open_detail(app: &AppHandle) {
    let app = app.clone();
    let fired = Instant::now();
    if let Err(error) = app.clone().run_on_main_thread(move || {
        println!("[shell] detail: dispatched after {:?}", fired.elapsed());
        if let Some(window) = app.get_webview_window(DETAIL) {
            let _ = window.show();
            let _ = window.set_focus();
            // Hiding is not closing: the page has been sitting there since the last look,
            // holding a status strip that the rec bar has been talking to, and showing history
            // that the rec bar has been adding to. Everything it read from disk is re-read.
            let _ = app.emit_to(DETAIL, "detail-shown", ());
            return;
        }
        match tauri::WebviewWindowBuilder::new(&app, DETAIL, tauri::WebviewUrl::App("detail.html".into()))
            .title("just_speak_codex — Detail box")
            .inner_size(DETAIL_WIDTH, DETAIL_HEIGHT)
            .visible(false)
            .build()
        {
            Ok(_) => println!(
                "[shell] detail: window ready {:?} after the trigger",
                fired.elapsed()
            ),
            Err(error) => println!("[shell] detail: could not open: {error}"),
        }
    }) {
        println!("[shell] detail: dispatch failed: {error}");
    }
}

#[tauri::command]
fn open_detail_window(app: AppHandle) {
    open_detail(&app);
}

/// Fix a window's geometry, and report what it actually is.
///
/// A GTK window that is not resizable is sized to its child's natural size — the webview's,
/// which is the document's — so resizability has to be released for the window to take the
/// size asked for. But the release is a request handled by the event loop, and locking it
/// again immediately freezes whatever size the window had at that instant: measured, a
/// 200-pixel-tall window stayed 200 for ever. So lock it only once it measures right, and
/// let the caller ask again until it does.
///
/// `fixed` is the rec bar: pinned to the size it draws at, anchored above the bottom edge.
/// Anything else is an ordinary window — centred, and left resizable.
fn size_and_place(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
    fixed: bool,
) -> tauri::Result<String> {
    let scale = window.scale_factor()?;
    let wanted = (width * scale).round() as u32;
    let wanted_height = (height * scale).round() as u32;
    let current = window.inner_size()?;

    if current.width == wanted && current.height == wanted_height {
        if fixed {
            window.set_resizable(false)?;
        }
    } else {
        window.set_resizable(true)?;
        window.set_size(tauri::LogicalSize::new(width, height))?;
    }

    if let Some(monitor) = window.current_monitor()? {
        let screen = monitor.size();
        // Positioned from the size that was asked for, not measured: GTK's answer to a
        // resize includes the window manager's frame extents, which are not the pill.
        let x = (screen.width as i32 - width as i32) / 2;
        let y = if fixed {
            screen.height as i32 - height as i32 - BAR_MARGIN
        } else {
            (screen.height as i32 - height as i32) / 2
        };
        window.set_position(PhysicalPosition::new(x, y))?;
    }

    Ok(format!(
        "{}x{}, wanted {wanted}x{wanted_height}",
        current.width, current.height
    ))
}

fn configure_rec_bar(app: &AppHandle) -> tauri::Result<()> {
    let rec_bar = app
        .get_webview_window(REC_BAR)
        .expect("the rec bar window is declared in the config");

    // `focusable: false` already maps to gtk_window_set_accept_focus(false). The missing
    // half is set_focus_on_map: without it the window manager may still hand the window
    // focus the moment it is mapped, which is exactly when a dictation would be lost.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::GtkWindowExt;

        let rec_bar_for_gtk = rec_bar.clone();
        rec_bar.run_on_main_thread(move || match rec_bar_for_gtk.gtk_window() {
            Ok(window) => {
                window.set_focus_on_map(false);
                window.set_accept_focus(false);
                println!("[shell] rec-bar: focus_on_map(false) + accept_focus(false)");
            }
            Err(error) => println!("[shell] rec-bar: gtk_window() failed: {error}"),
        })?;
    }

    Ok(())
}

/// The microphone permission handler. WebKitGTK ships no permission UI and denies by
/// default, so a missing handler is indistinguishable from a broken microphone.
#[cfg(target_os = "linux")]
fn allow_microphone(app: &AppHandle) -> tauri::Result<()> {
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};

    let rec_bar = app
        .get_webview_window(REC_BAR)
        .expect("the rec bar window is declared in the config");
    rec_bar.with_webview(|webview| {
        let view = webview.inner();
        if let Some(settings) = view.settings() {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|view, request| {
            let uri = view.uri().map(|u| u.to_string()).unwrap_or_default();
            let allowed = ALLOWED_ORIGINS.iter().any(|origin| uri.starts_with(origin));
            println!(
                "[shell] microphone request from '{uri}' -> {}",
                if allowed { "allow" } else { "deny" }
            );
            if allowed {
                request.allow();
            } else {
                request.deny();
            }
            true // handled: never fall through to the silent default
        });
    })
}

/// Where the server and the Python worker live.
///
/// An installed app carries them as bundle resources, next to the binary; a development
/// checkout has them in the repository, a few directories above the binary. `JUST_SPEAK_ROOT`
/// overrides both.
fn server_root(app: &AppHandle) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("JUST_SPEAK_ROOT") {
        return Some(PathBuf::from(configured));
    }
    let resources = app.path().resource_dir().ok().filter(|directory| {
        directory.join("dist/server.js").is_file()
    });
    let repository = server::find_root();
    // Development reads the source tree, even though a debug build also has a copy of the
    // resources beside it: that copy is a build artefact, and running the previous build's
    // server — with its own idea of the data directory — is a confusing way to lose an
    // afternoon.
    if cfg!(debug_assertions) {
        repository.or(resources)
    } else {
        resources.or(repository)
    }
}

/// Where the models, the Python environment and the history live: beside the source while
/// developing, and under the user's data directory once installed.
fn data_dir(root: &PathBuf) -> PathBuf {
    if let Some(configured) = std::env::var_os("JUST_SPEAK_DATA_DIR") {
        return PathBuf::from(configured);
    }
    if cfg!(debug_assertions) {
        return root.clone();
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("just-speak")
}

fn port() -> u16 {
    std::env::var("JUST_SPEAK_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3000)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            // Closing the detail box hides it. The window is where the rec bar's messages land —
            // a paste that did not go through, a microphone that was not there — and a
            // window that has to be rebuilt is a window that never heard them. It is built
            // once, and it reloads what it reads rather than itself.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == DETAIL {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            shell_info,
            insert_text,
            report,
            quit,
            show_window,
            open_detail_window
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            configure_rec_bar(&handle)?;
            #[cfg(target_os = "linux")]
            allow_microphone(&handle)?;

            let root = server_root(&handle).unwrap_or_else(|| PathBuf::from("."));
            let port = port();
            // A packaged build keeps its environment, models and history under the user's
            // data directory; the repository keeps them beside itself while developing.
            let data = data_dir(&root);
            println!("[shell] root {} · data {} · port {port}", root.display(), data.display());

            let server = Server::start(&root, port, &data);
            app.manage(ShellState {
                info: ShellInfo {
                    port,
                    data_dir: data.display().to_string(),
                    version: env!("CARGO_PKG_VERSION").to_string(),
                    problem: server.problem(),
                },
                inserter: Inserter::spawn(),
                server,
            });

            // Registered from Rust: the webview needs no permission for the hotkey, and a
            // page that fails to load cannot take the shortcut down with it.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            app.global_shortcut().on_shortcut(toggle, |app, _shortcut, event| {
                // Both halves of every keypress arrive here, and held keys repeat.
                if event.state != ShortcutState::Pressed {
                    return;
                }
                match app.emit_to(REC_BAR, "record-toggle", ()) {
                    Ok(()) => println!("[shell] record-toggle"),
                    Err(error) => println!("[shell] record-toggle failed: {error}"),
                }
            })?;

            let detail = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyS);
            app.global_shortcut().on_shortcut(detail, |app, _shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                println!("[shell] detail shortcut");
                open_detail(app);
            })?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running the app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Explicit rather than relying on the state being dropped: a server left
                // holding the port makes the next launch fail to bind.
                println!("[shell] exiting");
                app.state::<ShellState>().server.stop();
            }
        });
}
