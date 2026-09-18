//! The Node server, as a child of this process.
//!
//! Tauri's `externalBin` mechanism execs the file directly with no interpreter step, so a
//! JavaScript server cannot be a sidecar — it is spawned with a plain `Command`. Node has
//! to be installed for any of this to work, which is a reasonable price for a personal app
//! and worth stating in the README rather than discovering at runtime.
//!
//! Cleanup is ours to write. There is no kill-on-drop, and an app that crashes does not
//! run its exit handlers — so the child is spawned into its own process group and the
//! whole group is signalled, which takes the Python worker down with it.

use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
// Linux and X11 only for now, as the plan's platform facts say: the shortcut plugin is
// X11-only upstream and window positioning is a no-op on Wayland.
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Server {
    /// Behind a mutex so it can be stopped from an event handler that only has `&self`.
    child: Mutex<Option<Child>>,
    port: u16,
    /// Why there is no server, if there is none: the frontend has no other way to know.
    problem: Option<String>,
}

fn port_is_open(port: u16) -> bool {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    TcpStream::connect_timeout(&address.into(), Duration::from_millis(200)).is_ok()
}

/// Where the repository (or, later, the installed app) keeps `dist/server.js`.
///
/// The binary sits in `src-tauri/target/<profile>/`, so the root is a few levels up. The
/// search is by marker rather than by counting directories, and `JUST_SPEAK_ROOT` overrides
/// it for tests and for an installed layout.
pub fn find_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("JUST_SPEAK_ROOT") {
        return Some(PathBuf::from(root));
    }
    let mut directory = std::env::current_exe().ok()?;
    for _ in 0..5 {
        directory = directory.parent()?.to_path_buf();
        if directory.join("package.json").is_file() && directory.join("local/worker.py").is_file()
        {
            return Some(directory);
        }
    }
    None
}

impl Server {
    /// Reuse a server that is already listening, or start one.
    ///
    /// Reuse is what makes development possible: run the API under `npm run dev:server`
    /// and the app will talk to that instead of spawning a second copy of itself.
    pub fn start(root: &Path, port: u16, data_dir: &Path) -> Server {
        if port_is_open(port) {
            println!("[shell] using the server already listening on {port}");
            return Server { child: Mutex::new(None), port, problem: None };
        }

        let script = root.join("dist/server.js");
        if !script.is_file() {
            let problem = format!("The server is missing ({}).", script.display());
            println!("[shell] {problem} Run npm run build.");
            return Server { child: Mutex::new(None), port, problem: Some(problem) };
        }

        let mut command = Command::new("node");
        command
            .arg(&script)
            .current_dir(root)
            .env("PORT", port.to_string())
            .env("JUST_SPEAK_DATA_DIR", data_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            // Its own process group, so the group can be signalled as one.
            .process_group(0);
        unsafe {
            command.pre_exec(|| {
                // And the kernel tells the server when this process dies, however it dies.
                // An app that is killed runs no exit handler — measured: the server stayed
                // listening on the port afterwards — and a server left holding the port
                // makes the next launch reuse a build that is no longer on disk.
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let spawned = command.spawn();

        match spawned {
            Ok(child) => {
                println!("[shell] server started (pid {}) on {port}", child.id());
                let server = Server { child: Mutex::new(Some(child)), port, problem: None };
                server.wait_until_listening();
                server
            }
            Err(error) => {
                // Node is a documented requirement: it runs the server this app is built
                // around, and there is nothing to fall back to.
                let problem = format!("Could not start the server ({error}). Is Node installed?");
                println!("[shell] {problem}");
                Server { child: Mutex::new(None), port, problem: Some(problem) }
            }
        }
    }

    /// Give it a moment to bind, so the frontend's first request is not the thing that
    /// discovers the failure.
    fn wait_until_listening(&self) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if port_is_open(self.port) {
                println!("[shell] server is listening on {}", self.port);
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        println!("[shell] server did not start listening on {}", self.port);
    }

    /// Why there is no server, if there is none.
    pub fn problem(&self) -> Option<String> {
        self.problem.clone()
    }

    /// Ask it to stop, then insist. The server closes its worker on SIGTERM, so the whole
    /// tree is gone either way; SIGKILL is for a process that has stopped reading.
    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().expect("server mutex").take() else {
            return;
        };
        // Safety: the child was spawned into its own group, so its pid is the group id.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(status)) => {
                    println!("[shell] server exited ({status})");
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => {
                    println!("[shell] could not wait for the server: {error}");
                    break;
                }
            }
        }
        println!("[shell] server did not stop politely; killing it");
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        let _ = child.wait();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        // The exit handler stops it first; this is for every other way the app can end.
        self.stop();
    }
}
