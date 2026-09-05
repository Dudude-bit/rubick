//! The environment the user's terminal has, adopted by this process.
//!
//! A desktop app is started by launchd or the desktop session, which hand it
//! an environment no shell profile has touched: none of the `PATH` additions,
//! no `AWS_PROFILE`, no `KUBECONFIG`, nothing that `.zshrc` or `.bashrc`
//! export. A credential plugin that works in the terminal then fails here,
//! and the failure looks like a missing binary or the wrong account. Lens
//! answers this by asking the login shell for its environment once at
//! startup and adopting it wholesale; this does the same.
//!
//! The shell is started as an *interactive* login shell, `-i -l`, not a login
//! shell alone. zsh reads `.zshrc` only when interactive, and the `.profile`
//! that Debian and macOS ship sources `.bashrc` only when interactive. Those
//! are the files where `pyenv`, `mise`, `nvm`, krew and most hand-written
//! `export` lines live; the probe this replaced used `-l -c` and missed every
//! one of them. What `-i` cannot give is a terminal: stdin is `/dev/null`, so
//! a profile that gates its setup on `[ -t 0 ]` still skips it.
//!
//! The probe shell starts from this process's own environment, so whatever
//! differs afterwards is what the profile did on purpose: a variable it set
//! is set here, a variable it unset is unset here. Four groups are left as
//! the desktop started them, because the profile's version of those is at
//! best the same and at worst stale: the probe shell's own bookkeeping, the
//! desktop session's and its toolkits' variables, the locale, and the
//! dynamic loader's.
//!
//! Values never leave the process. Diagnostics reports how many variables
//! changed and the shell that was asked, nothing else.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::path::{build_fallback_path, set_user_path};

/// Long, on purpose: coming up without the environment is the bug, and a
/// `.zshrc` that starts `nvm` takes seconds. A profile that hangs is what the
/// cap is for.
#[cfg(unix)]
/// How long the login shell gets to answer. Public so `main` can name it in
/// the line it prints before the wait — a number in a message and a number
/// in the code that disagree is worse than no message.
pub const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(30);

/// More than any environment can be. Hard: an answer that crosses it in its
/// last read is still no answer.
#[cfg(unix)]
const MAX_OUTPUT: usize = 8 << 20;

/// `-i` is the load-bearing flag; the module doc says why.
#[cfg(unix)]
const LOGIN_SHELL_FLAGS: [&str; 3] = ["-i", "-l", "-c"];

/// The probe shell's own bookkeeping. Adopting `PWD` would tell every
/// spawned plugin it is running in the user's home directory.
const PROBE_OWNED: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_"];

/// The desktop session's variables, by name and by prefix. This process is a
/// member of that session and the values it was started with are the live
/// ones. A profile line written for an SSH login (`export DISPLAY=:0`,
/// `export GDK_BACKEND=wayland`) would point the webview at a display that
/// is not there, before the window exists; an `AppImage`'s `XDG_DATA_DIRS`
/// overwritten by a profile loses the bundled GTK schemas the same way. The
/// loader's variables are here for the same reason: they decide what this
/// process and every child of it link against. The locale stays too: the
/// toolkit reads it once, at start, and the tools this app spawns do not
/// localise, so a profile's `LC_ALL=C` would change the window and nothing
/// else.
const SESSION_OWNED: &[&str] = &[
    "DISPLAY",
    "XAUTHORITY",
    "SESSION_MANAGER",
    "TMPDIR",
    "APPIMAGE",
    "APPDIR",
    "OWD",
    "ARGV0",
    "LANG",
    "LANGUAGE",
];
const SESSION_PREFIXES: &[&str] = &[
    "XDG_",
    "LC_",
    "WAYLAND_",
    "DBUS_",
    "GDK_",
    "GTK_",
    "GIO_",
    "GSETTINGS_",
    "WEBKIT_",
    "QT_",
    "DESKTOP_",
    "GNOME_",
    "KDE_",
    "LD_",
    "DYLD_",
];

/// The XDG base directories are the user's, not the session's: a profile
/// that moves `XDG_CONFIG_HOME` moves it for the helm and krew in a
/// terminal, and has to move it for the ones spawned here.
const USER_OWNED: &[&str] = &[
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
];

/// Whether a variable stays as the desktop set it, whatever the shell says.
fn is_kept(key: &str) -> bool {
    if USER_OWNED.contains(&key) {
        return false;
    }
    PROBE_OWNED.contains(&key)
        || SESSION_OWNED.contains(&key)
        || SESSION_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

/// What became of the one ask at startup, for Settings -> Diagnostics.
///
/// Five states rather than a boolean because "the shell was not asked" and
/// "the shell was asked and did not answer" call for different fixes, and
/// the screen is the only place a person finds out which happened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub enum ShellEnvReport {
    /// `adopted` counts variables whose value is now the shell's and was not
    /// before; `removed` counts those the profile had unset.
    Imported {
        shell: String,
        adopted: usize,
        removed: usize,
    },
    TimedOut {
        shell: String,
        seconds: u64,
    },
    /// The OS refused the spawn; `error` is its own message.
    CouldNotStart {
        shell: String,
        error: String,
    },
    /// The shell ran and exited without printing its environment: a profile
    /// that replaced `PATH` outright so `env` was not found, a `.zshrc` that
    /// `exec`s something else, a shell whose flags mean something different
    /// (tcsh takes `-l` only on its own).
    NoAnswer {
        shell: String,
        exit: Option<i32>,
    },
    /// Windows: a GUI app is started with the user's environment already in
    /// place, so there is nothing to ask a shell for. A real answer — the
    /// search path below is the process's own and that is correct there.
    NotAsked,
    /// Nobody asked, and nobody decided not to: `import_login_shell_env`
    /// has not run in this process.
    ///
    /// Distinct from `NotAsked` on purpose. Both used to be `NotAsked`, so a
    /// build that stopped calling the import at startup would have reported
    /// a Windows story on a Mac, `answered()` would have said yes, and the
    /// caveat on every "not installed" verdict would have been suppressed —
    /// the third state folded into a confident second one.
    NotRecorded,
}

impl ShellEnvReport {
    /// Whether the search path was built from a real answer.
    #[must_use]
    pub fn answered(&self) -> bool {
        // `NotRecorded` is not here: an import that never ran did not answer,
        // and the search path below it is the fallback list, not the
        // shell's.
        matches!(self, Self::Imported { .. } | Self::NotAsked)
    }
}

static REPORT: OnceLock<ShellEnvReport> = OnceLock::new();

/// What happened at startup, or `None` before `import_login_shell_env` ran.
#[must_use]
pub fn env_report() -> Option<&'static ShellEnvReport> {
    REPORT.get()
}

/// What to set, what to unset, and the shell's own `PATH` to merge.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub set: Vec<(String, OsString)>,
    pub unset: Vec<String>,
    pub shell_path: Option<OsString>,
    /// How many of `set` differ from what the process had.
    pub adopted: usize,
}

/// Decide what to adopt.
///
/// `answer` is what the shell exported, or `None` when it did not answer;
/// `present` is this process's environment before it was asked. The shell
/// wins for everything it exports, and a variable that was here and is not
/// in the answer was unset by the profile, so it goes. `PATH` is handed back
/// for the caller to merge, once the rest is in place. No answer means
/// nothing to compare against, and nothing moves.
#[must_use]
pub fn plan(answer: Option<&[(String, OsString)]>, present: &[(String, OsString)]) -> Plan {
    let Some(shell_vars) = answer else {
        return Plan {
            set: Vec::new(),
            unset: Vec::new(),
            shell_path: None,
            adopted: 0,
        };
    };

    let before: HashMap<&str, &OsString> = present.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let mut set = Vec::with_capacity(shell_vars.len());
    let mut shell_path: Option<OsString> = None;
    let mut answered: HashSet<&str> = HashSet::with_capacity(shell_vars.len());
    for (key, value) in shell_vars {
        answered.insert(key.as_str());
        if is_kept(key) {
            continue;
        }
        if key == "PATH" {
            shell_path = Some(value.clone());
            continue;
        }
        set.push((key.clone(), value.clone()));
    }
    let adopted = set
        .iter()
        .filter(|(key, value)| before.get(key.as_str()) != Some(&value))
        .count();

    // Only names the parser could have read back: a name `env` prints that
    // is not an identifier (bash's exported functions) was never in the
    // answer and must not be mistaken for an unset.
    let unset = present
        .iter()
        .map(|(key, _)| key)
        .filter(|key| {
            is_identifier(key)
                && key.as_str() != "PATH"
                && !is_kept(key)
                && !answered.contains(key.as_str())
        })
        .cloned()
        .collect();

    Plan {
        set,
        unset,
        shell_path,
        adopted,
    }
}

/// Ask the login shell for its environment and adopt it.
///
/// Called from `main`, before the Tauri runtime, the webview, or any thread
/// that reads the environment exists. `setenv` is not safe beside a
/// concurrent `getenv`, and GTK, `WebKit` and the tokio workers all call
/// `getenv` from threads of their own once they are up. The one thread this
/// spawns reads a pipe and touches nothing else.
///
/// Idempotent: a second call returns the first report and changes nothing.
pub fn import_login_shell_env() -> &'static ShellEnvReport {
    REPORT.get_or_init(|| {
        let present: Vec<(String, OsString)> = std::env::vars_os()
            .filter_map(|(key, value)| key.into_string().ok().map(|key| (key, value)))
            .collect();
        let asked = capture();
        let answer = asked.as_ref().ok().map(|(_, vars)| vars.as_slice());
        let plan = plan(answer, &present);
        for (key, value) in &plan.set {
            std::env::set_var(key, value);
        }
        for key in &plan.unset {
            std::env::remove_var(key);
        }
        // PATH last, once the shell's variables are in: `build_fallback_path`
        // reads `KREW_ROOT`, and a profile is where that is set.
        let shell_path = plan
            .shell_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned());
        let path =
            crate::cli::PathResolver::merge_paths(shell_path.as_deref(), &build_fallback_path());
        std::env::set_var("PATH", &path);
        set_user_path(path);
        match asked {
            Ok((shell, _)) => ShellEnvReport::Imported {
                shell,
                adopted: plan.adopted,
                removed: plan.unset.len(),
            },
            Err(report) => report,
        }
    })
}

/// The shell's name and what it exported, or why there is no answer.
#[cfg(not(unix))]
fn capture() -> Result<(String, Vec<(String, OsString)>), ShellEnvReport> {
    Err(ShellEnvReport::NotAsked)
}

#[cfg(unix)]
fn capture() -> Result<(String, Vec<(String, OsString)>), ShellEnvReport> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    let vars = unix::capture(&shell, SHELL_ENV_TIMEOUT)?;
    Ok((shell, vars))
}

/// The strings that bracket the answer in the shell's output.
///
/// Fresh for every run. Profiles print to stdout (a `neofetch`, an update
/// nag), which is what the start marker is for, and a fixed marker would
/// be one more string a value could happen to contain; one nobody has seen
/// before cannot.
#[cfg(unix)]
struct Markers {
    start: String,
    end: String,
}

#[cfg(unix)]
impl Markers {
    fn fresh() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static RUN: AtomicU64 = AtomicU64::new(0);
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let run = RUN.fetch_add(1, Ordering::Relaxed);
        let stem = format!("__RUBICK_ENV_{}_{run}_{nonce}", std::process::id());
        Self {
            start: format!("{stem}_START__"),
            end: format!("{stem}_END__"),
        }
    }

    /// `command` bypasses an `alias env=` or a function of that name, which
    /// an interactive shell would otherwise expand. `env -0` where it exists
    /// (GNU coreutils, macOS since 10.11), plain `env` elsewhere; the parser
    /// takes either. stderr is dropped at spawn, so a rejected `-0` costs
    /// nothing but the retry.
    fn script(&self) -> String {
        format!(
            "printf '%s' {}; command env -0 || command env; printf '%s' {}",
            self.start, self.end
        )
    }
}

/// The `KEY=VALUE` records between the markers, or `None` when they are not
/// an answer.
///
/// Both markers are required: a missing end marker means the output was cut
/// short. So is a `PATH` record: `printf` is a builtin and `env` is not, so
/// a profile that replaces `PATH` outright prints both markers and nothing
/// between them, and reading that as "the profile unset everything" would
/// strip this process of `HOME`. Every shell exports `PATH`, so an answer
/// without one is `env` not having run.
#[cfg(unix)]
fn parse(output: &[u8], markers: &Markers) -> Option<Vec<(String, OsString)>> {
    use std::os::unix::ffi::OsStringExt as _;

    let start = find(output, markers.start.as_bytes())? + markers.start.len();
    let end = start + find(&output[start..], markers.end.as_bytes())?;
    let body = &output[start..end];

    let separator = if body.contains(&0) { 0 } else { b'\n' };
    let vars: Vec<(String, OsString)> = body
        .split(|byte| *byte == separator)
        .filter_map(|record| {
            let eq = record.iter().position(|b| *b == b'=')?;
            let key = std::str::from_utf8(&record[..eq]).ok()?;
            is_identifier(key).then(|| {
                (
                    key.to_string(),
                    OsString::from_vec(record[eq + 1..].to_vec()),
                )
            })
        })
        .collect();
    vars.iter().any(|(key, _)| key == "PATH").then_some(vars)
}

#[cfg(unix)]
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// What a shell would accept as a variable name. Anything else between the
/// markers is a profile talking, not a variable.
fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(unix)]
mod unix {
    use super::{find, parse, Markers, ShellEnvReport, LOGIN_SHELL_FLAGS, MAX_OUTPUT};
    use std::ffi::OsString;
    use std::io::Read as _;
    use std::os::unix::process::CommandExt as _;
    use std::process::{Child, Command, Stdio};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;

    /// Run the shell and read until the end marker, the pipe closes, the
    /// output cap is hit, or the deadline passes.
    ///
    /// The end marker, not EOF, is what says the answer is complete. A
    /// profile that starts a daemon (`ssh-agent`, `gpg-agent`) leaves the
    /// pipe's write end open for as long as the daemon lives, so EOF may
    /// never come; the reader thread is left to it rather than joined.
    pub(super) fn capture(
        shell: &str,
        timeout: Duration,
    ) -> Result<Vec<(String, OsString)>, ShellEnvReport> {
        let markers = Markers::fresh();
        let mut command = Command::new(shell);
        command
            .args(LOGIN_SHELL_FLAGS)
            .arg(markers.script())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // A session of its own, for two reasons. It makes the shell a group
        // leader, so the deadline can take the profile's children down with
        // it. And it drops the controlling terminal: started from one, an
        // interactive bash or zsh in a mere new process group finds it is
        // not the terminal's foreground group and stops itself with SIGTTIN,
        // and the app waits out the whole deadline on every `make dev`.
        // SAFETY: setsid(2) is async-signal-safe and reads no parent memory.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| ShellEnvReport::CouldNotStart {
                shell: shell.to_string(),
                error: error.to_string(),
            })?;

        let Some(mut stdout) = child.stdout.take() else {
            return Err(ShellEnvReport::NoAnswer {
                shell: shell.to_string(),
                exit: None,
            });
        };
        let output = Arc::new(Mutex::new(Vec::new()));
        let (done, answered) = mpsc::channel::<()>();
        let reader_copy = Arc::clone(&output);
        let end = markers.end.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match stdout.read(&mut chunk) {
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut seen = reader_copy
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        // Only the new bytes and a marker's length before
                        // them; scanning everything each time is quadratic.
                        let scan_from = seen.len().saturating_sub(end.len() - 1);
                        seen.extend_from_slice(&chunk[..n]);
                        if seen.len() > MAX_OUTPUT
                            || find(&seen[scan_from..], end.as_bytes()).is_some()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = done.send(());
        });

        let timed_out = answered.recv_timeout(timeout).is_err();
        let answer = {
            let seen = output
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if seen.len() <= MAX_OUTPUT {
                parse(&seen, &markers)
            } else {
                None
            }
        };
        // A complete answer means the shell is on its way out, and whatever
        // the profile left running behind it (an agent it just exported the
        // socket of, a helper that did not detach) is the user's to keep, as
        // a terminal would keep it. Anything else means the shell, or
        // something it is waiting on, has hung: the whole group goes.
        let status = if answer.is_some() {
            reap_or_kill(&mut child)
        } else {
            terminate_group(&child);
            reap_within(&mut child, KILL_GRACE)
        };
        match answer {
            Some(vars) => Ok(vars),
            None if timed_out => Err(ShellEnvReport::TimedOut {
                shell: shell.to_string(),
                seconds: timeout.as_secs(),
            }),
            None => Err(ShellEnvReport::NoAnswer {
                shell: shell.to_string(),
                exit: status.and_then(|s| s.code()),
            }),
        }
    }

    /// Exiting takes milliseconds; a `.zlogout` that hangs is what this is for.
    const EXIT_GRACE: Duration = Duration::from_secs(1);

    /// A killed process is gone in milliseconds, unless it is in
    /// uninterruptible sleep on a dead mount, where SIGKILL waits with it.
    const KILL_GRACE: Duration = Duration::from_secs(1);

    /// Wait briefly for a shell that has answered, then kill the shell
    /// alone: its background children are left running on purpose.
    fn reap_or_kill(child: &mut Child) -> Option<std::process::ExitStatus> {
        reap_within(child, EXIT_GRACE).or_else(|| {
            let _ = child.kill();
            reap_within(child, KILL_GRACE)
        })
    }

    /// Never a bare `wait`: this runs before the window exists, and a shell
    /// stuck in the kernel would hold the whole start with it. Past the
    /// grace the child is left unreaped, a zombie at worst.
    fn reap_within(child: &mut Child, grace: Duration) -> Option<std::process::ExitStatus> {
        let deadline = std::time::Instant::now() + grace;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Some(status);
            }
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Kill the shell's process group. The shell leads it, so the group id
    /// is its pid, and the pid stays reserved by the unreaped child until
    /// `wait` below. A daemon that moved to a session of its own is out of
    /// reach and left alone, as a terminal would leave it.
    fn terminate_group(child: &Child) {
        let Ok(pgid) = i32::try_from(child.id()) else {
            return;
        };
        // SAFETY: kill(2) takes two integers and dereferences nothing.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(String, OsString)> {
        list.iter()
            .map(|(k, v)| ((*k).to_string(), OsString::from(v)))
            .collect()
    }

    fn keys(plan: &Plan) -> Vec<&str> {
        plan.set.iter().map(|(k, _)| k.as_str()).collect()
    }

    #[cfg(unix)]
    fn markers() -> Markers {
        Markers {
            start: "<<START>>".to_string(),
            end: "<<END>>".to_string(),
        }
    }

    /// The reported failure, in one flag. A login shell that is not
    /// interactive never reads `.zshrc`, and that is where the user's `aws`
    /// and `kubectl-oidc_login` were on their PATH. Drop `-i` and every
    /// plugin installed by a profile line goes missing again, with every
    /// other test still green.
    #[test]
    fn the_shell_is_started_interactively_as_well_as_as_a_login_shell() {
        assert!(
            LOGIN_SHELL_FLAGS.contains(&"-i"),
            "not interactive: .zshrc is never read"
        );
        assert!(
            LOGIN_SHELL_FLAGS.contains(&"-l"),
            "not a login shell: .zprofile is never read"
        );
        assert_eq!(LOGIN_SHELL_FLAGS[2], "-c", "the script has to follow -c");
    }

    /// An interactive shell expands aliases even under `-c`. A profile with
    /// `alias env='env | sort'` would then hand the parser sorted lines, or
    /// nothing; `command` asks for the binary.
    #[cfg(unix)]
    #[test]
    fn env_is_run_as_a_command_not_through_an_alias() {
        let script = Markers::fresh().script();
        assert!(script.contains("command env -0 || command env"), "{script}");
    }

    /// Profiles print. The start marker is what separates a `neofetch`
    /// banner from the first variable, and NUL is what keeps a value with a
    /// newline in it (a multi-line `PS1`, a `LESS` with an escape) whole.
    #[cfg(unix)]
    #[test]
    fn records_between_the_markers_are_read_and_the_banner_is_not() {
        let mut out = Vec::new();
        out.extend_from_slice(b"Welcome back, you have MOTD=1 in this line\n");
        out.extend_from_slice(b"<<START>>");
        out.extend_from_slice(b"HOME=/Users/a\0PS1=one\ntwo\0PATH=/a:/b\0");
        out.extend_from_slice(b"<<END>>");
        out.extend_from_slice(b"\nlogout noise\n");

        let parsed = parse(&out, &markers()).expect("both markers are there");
        assert_eq!(
            parsed,
            vars(&[("HOME", "/Users/a"), ("PS1", "one\ntwo"), ("PATH", "/a:/b")])
        );
    }

    /// `env` without `-0` is what an older macOS answers with, one record
    /// per line.
    #[cfg(unix)]
    #[test]
    fn a_newline_separated_answer_is_read_too() {
        assert_eq!(
            parse(b"<<START>>HOME=/h\nPATH=/a\n<<END>>", &markers()).expect("parses"),
            vars(&[("HOME", "/h"), ("PATH", "/a")])
        );
    }

    /// A line that is not `NAME=value` is a profile talking, not a variable,
    /// and adopting it would put the banner into the environment.
    #[cfg(unix)]
    #[test]
    fn anything_that_is_not_a_variable_is_skipped() {
        assert_eq!(
            parse(
                b"<<START>>not a variable\0=novalue\0bad-name=x\0OK=1\0PATH=/a\0<<END>>",
                &markers()
            )
            .expect("parses"),
            vars(&[("OK", "1"), ("PATH", "/a")])
        );
    }

    /// Cut short is not complete. An environment that stops mid-way would be
    /// adopted as the whole of it, PATH included, and a half PATH is exactly
    /// the state this module was written to end.
    #[cfg(unix)]
    #[test]
    fn output_without_the_end_marker_is_not_an_answer() {
        assert_eq!(parse(b"<<START>>HOME=/h\0PATH=/a", &markers()), None);
        assert_eq!(parse(b"nothing at all", &markers()), None);
    }

    /// Reproduced with bash: a `.bashrc` holding `export PATH="$HOME/bin"`
    /// leaves `env` nowhere to be found, and the shell prints the two
    /// markers with nothing between them. Read as an answer, that is "the
    /// profile unset everything", and the process loses `HOME`, `USER`,
    /// `LANG` and `KUBECONFIG` while Diagnostics reports success.
    #[cfg(unix)]
    #[test]
    fn an_answer_without_path_is_no_answer() {
        assert_eq!(parse(b"<<START>><<END>>", &markers()), None);
        assert_eq!(parse(b"<<START>>FOO=1\0<<END>>", &markers()), None);
    }

    /// The markers are minted per run, so a value that happens to hold
    /// another run's marker (a log line pasted into a variable, a previous
    /// probe's output) does not end this one early.
    #[cfg(unix)]
    #[test]
    fn a_value_holding_another_runs_marker_does_not_end_the_answer() {
        let first = Markers::fresh();
        let second = Markers::fresh();
        assert_ne!(first.end, second.end, "two runs share a marker");

        let out = format!(
            "{}NOTE={}\0PATH=/a\0{}",
            second.start, first.end, second.end
        );
        let parsed = parse(out.as_bytes(), &second).expect("parses");
        assert_eq!(parsed.len(), 2, "{parsed:?}");
        assert_eq!(parsed[0], ("NOTE".to_string(), OsString::from(&first.end)));
    }

    /// The shell wins. It started from this process's own environment, so
    /// every difference is something the user's profile set on purpose.
    #[test]
    fn what_the_shell_exports_is_adopted() {
        let plan = plan(
            Some(&vars(&[
                ("AWS_PROFILE", "work"),
                ("KUBECONFIG", "/k/a:/k/b"),
            ])),
            &[],
        );
        assert!(plan
            .set
            .contains(&("AWS_PROFILE".to_string(), OsString::from("work"))));
        assert!(plan
            .set
            .contains(&("KUBECONFIG".to_string(), OsString::from("/k/a:/k/b"))));
    }

    /// The count on the Diagnostics screen is what changed, not how large
    /// the shell's environment is: `HOME` coming back as it was is not an
    /// adoption, and a screen saying "45 variables adopted" for two real
    /// changes would send a reader looking for 43 that did not happen.
    #[test]
    fn adopted_counts_what_the_shell_changed_not_what_it_repeated() {
        let plan = plan(
            Some(&vars(&[
                ("HOME", "/h"),
                ("AWS_PROFILE", "work"),
                ("NEW", "1"),
                ("PATH", "/a"),
            ])),
            &vars(&[("HOME", "/h"), ("AWS_PROFILE", "old"), ("PATH", "/p")]),
        );
        assert_eq!(plan.adopted, 2, "{plan:?}");
        assert_eq!(plan.shell_path, Some(OsString::from("/a")));
    }

    /// The other half of "the shell wins". A desktop that was started with
    /// `AWS_PROFILE=old` (a `~/.pam_environment`, a systemd user unit) and a
    /// profile that unsets it leave the terminal without one; this process
    /// would otherwise keep `old` and sign in as the wrong account.
    #[test]
    fn a_variable_the_profile_unsets_is_unset_here_too() {
        let plan = plan(
            Some(&vars(&[("HOME", "/h"), ("PATH", "/a")])),
            &vars(&[("HOME", "/h"), ("AWS_PROFILE", "old"), ("PATH", "/p")]),
        );
        assert_eq!(plan.unset, vec!["AWS_PROFILE".to_string()]);
    }

    /// bash prints its exported functions as `BASH_FUNC_x%%=…`, which is
    /// not a name the parser reads back. Absent from the answer is not the
    /// same as unset, so such a name must not be removed.
    #[test]
    fn a_name_the_parser_could_not_have_read_is_not_taken_for_an_unset() {
        let plan = plan(
            Some(&vars(&[("HOME", "/h")])),
            &vars(&[("HOME", "/h"), ("BASH_FUNC_x%%", "() { :; }")]),
        );
        assert!(plan.unset.is_empty(), "{:?}", plan.unset);
    }

    /// `PWD` is where the probe shell ran, not where a plugin should think it
    /// is; `SHLVL` and `_` describe that shell and nothing else.
    #[test]
    fn the_probe_shells_own_bookkeeping_is_not_adopted() {
        let plan = plan(
            Some(&vars(&[
                ("PWD", "/Users/a"),
                ("OLDPWD", "/"),
                ("SHLVL", "2"),
                ("_", "/usr/bin/env"),
            ])),
            &[],
        );
        assert!(keys(&plan).is_empty(), "{plan:?}");
    }

    /// `export DISPLAY=:0` sits in dotfiles written for SSH, and
    /// `GDK_BACKEND=wayland` in ones written for another app; adopted before
    /// the window exists, either points the webview at a display that is not
    /// there. An `AppImage`'s `XDG_DATA_DIRS` overwritten by a profile loses
    /// the bundled schemas the same way. The session's variables keep the
    /// values this process was started with, in both directions.
    #[test]
    fn the_desktop_sessions_own_variables_are_neither_adopted_nor_unset() {
        let plan = plan(
            Some(&vars(&[
                ("DISPLAY", ":0"),
                ("GDK_BACKEND", "wayland"),
                ("XDG_DATA_DIRS", "/usr/share"),
                ("QT_QPA_PLATFORM", "xcb"),
                ("TMPDIR", "/tmp"),
                ("LC_ALL", "C"),
                ("HOME", "/h"),
            ])),
            &vars(&[
                ("HOME", "/h"),
                ("WAYLAND_DISPLAY", "wayland-0"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1/bus"),
                ("XDG_RUNTIME_DIR", "/run/user/1"),
                ("APPDIR", "/tmp/.mount_x"),
                ("LANG", "ru_RU.UTF-8"),
            ]),
        );
        assert_eq!(keys(&plan), vec!["HOME"]);
        assert!(plan.unset.is_empty(), "{:?}", plan.unset);
    }

    /// `XDG_CONFIG_HOME` decides where helm and krew keep their files, and
    /// a profile that moves it is the reason the app's helm must follow.
    /// Treating it as the session's would leave the plugins spawned here
    /// reading a different config root than the same tools in a terminal.
    #[test]
    fn the_xdg_base_directories_are_the_users_and_follow_the_profile() {
        let plan = plan(
            Some(&vars(&[
                ("XDG_CONFIG_HOME", "/h/cfg"),
                ("XDG_DATA_HOME", "/h/data"),
                ("XDG_RUNTIME_DIR", "/run/user/9"),
            ])),
            &vars(&[
                ("XDG_CACHE_HOME", "/tmp/cache"),
                ("XDG_RUNTIME_DIR", "/run/user/1"),
            ]),
        );
        assert_eq!(keys(&plan), vec!["XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
        assert_eq!(plan.unset, vec!["XDG_CACHE_HOME"]);
    }

    /// `LD_PRELOAD` from a profile would be handed to every plugin this app
    /// spawns, and to whatever the app itself loads later.
    #[test]
    fn the_dynamic_loaders_variables_are_left_alone() {
        let plan = plan(
            Some(&vars(&[
                ("LD_PRELOAD", "/x.so"),
                ("DYLD_INSERT_LIBRARIES", "/y"),
            ])),
            &vars(&[("LD_LIBRARY_PATH", "/lib")]),
        );
        assert!(keys(&plan).is_empty(), "{plan:?}");
        assert!(plan.unset.is_empty());
    }

    /// No answer at all touches nothing: there is nothing to compare the
    /// process against, so nothing may be called unset.
    #[test]
    fn without_an_answer_nothing_moves() {
        let plan = plan(None, &vars(&[("AWS_PROFILE", "old")]));
        assert!(plan.set.is_empty());
        assert!(plan.unset.is_empty());
        assert_eq!(plan.shell_path, None);
        assert_eq!(plan.adopted, 0);
    }

    /// The real shell on this machine, with the real profile. Ignored in the
    /// ordinary run because it sources the developer's `.zshrc`, which may
    /// start agents and take seconds; the fake shells below run the same
    /// code with `/bin/sh`. Strict when it runs: a shell that is there and
    /// does not answer is a failure, not a shrug.
    #[cfg(unix)]
    #[test]
    #[ignore = "sources the real login profile; run by hand"]
    fn the_login_shell_on_this_machine_answers_with_a_path() {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let vars = unix::capture(&shell, SHELL_ENV_TIMEOUT).expect("the login shell answers");
        let path = vars
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .expect("a shell exports PATH");
        assert!(path.contains(':'), "PATH should have entries: {path}");
    }

    /// A stand-in shell: ignores the flags it is given and runs `body`. The
    /// script it would have been handed is `$4`, which is how a body gets at
    /// the run's own markers.
    #[cfg(unix)]
    fn fake_shell(dir: &std::path::Path, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt as _;
        let path = dir.join("shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        path.to_string_lossy().into_owned()
    }

    /// The pid a fake shell wrote for a helper it started in the background.
    #[cfg(unix)]
    fn helper_pid(pid_file: &std::path::Path) -> i32 {
        std::fs::read_to_string(pid_file)
            .expect("the shell wrote its helper's pid")
            .trim()
            .parse()
            .expect("a pid")
    }

    /// Whether a process exists. A killed one answers yes for a moment more,
    /// as a zombie, until init collects it.
    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 checks for existence and delivers nothing.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// A profile that starts an agent and exports its socket has handed
    /// this app a live thing. Killing the probe's whole group on success
    /// would import `SSH_AUTH_SOCK` and then kill the agent behind it, and
    /// every plugin that needed the key would fail against a dead socket.
    /// On success the shell alone is reaped; what it left behind is the
    /// user's, as it would be when a terminal window closes.
    #[cfg(unix)]
    #[test]
    fn a_helper_the_profile_left_running_survives_a_successful_answer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("helper.pid");
        let shell = fake_shell(
            dir.path(),
            &format!("sleep 30 & echo $! > {}; sh -c \"$4\"", pid_file.display()),
        );
        let vars = unix::capture(&shell, Duration::from_secs(20)).expect("an answer");
        assert!(vars.iter().any(|(k, _)| k == "PATH"));

        let helper = helper_pid(&pid_file);
        // Long enough for a SIGKILLed helper to have been collected, so
        // "alive" below means alive and not merely not yet reaped.
        std::thread::sleep(Duration::from_millis(300));
        let survived = alive(helper);
        // Clean up before asserting, or a failure leaves a 30 s sleeper.
        // SAFETY: the pid was written by our own child moments ago.
        unsafe {
            libc::kill(helper, libc::SIGKILL);
        }
        assert!(
            survived,
            "the profile's helper {helper} was killed along with a shell that had answered"
        );
    }

    /// A profile that leaves a daemon holding stdout never closes the pipe.
    /// The end marker is the signal, not EOF, or every such machine would
    /// wait out the whole deadline and then report a timeout it did not have.
    /// The shell here also hangs after answering, so this is the grace-then-
    /// kill path too: it has to come back in about a second, not thirty.
    #[cfg(unix)]
    #[test]
    fn the_end_marker_completes_the_answer_before_the_pipe_closes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = fake_shell(dir.path(), "sh -c \"$4\"; sleep 3");
        let started = std::time::Instant::now();
        let vars = unix::capture(&shell, Duration::from_secs(20)).expect("an answer");
        assert!(
            vars.iter().any(|(k, _)| k == "PATH"),
            "the real env was not read: {vars:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "waited for EOF instead of the marker: {:?}",
            started.elapsed()
        );
    }

    /// A shell that hangs is cut off at the deadline and reported as a
    /// timeout, and the app carries on without it.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_hangs_is_cut_off_at_the_deadline() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = fake_shell(dir.path(), "sleep 30");
        let report =
            unix::capture(&shell, Duration::from_millis(300)).expect_err("a hang is not an answer");
        assert_eq!(
            report,
            ShellEnvReport::TimedOut {
                shell: shell.clone(),
                seconds: 0
            }
        );
    }

    /// The thing the deadline was really waiting on is usually not the
    /// shell but something it started: a version manager, a credential
    /// helper. Killing the shell alone leaves that running with the pipe
    /// open; the whole group has to go.
    #[cfg(unix)]
    #[test]
    fn the_profiles_own_children_are_taken_down_with_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid_file = dir.path().join("child.pid");
        let shell = fake_shell(
            dir.path(),
            &format!("sleep 30 & echo $! > {}; wait", pid_file.display()),
        );
        // Three seconds, not five hundred milliseconds. The deadline has to
        // outlast the shell's own startup, and under the parallel test binary
        // on a loaded machine it did not: the group was killed before the
        // profile reached `echo $!`, the pid file was never written, and this
        // failed four runs out of five — but only when run beside its
        // neighbours, which is why it looked green alone. Nothing here is
        // waiting on the deadline being short; it is waiting on it passing.
        let report = unix::capture(&shell, Duration::from_secs(3));
        assert!(matches!(report, Err(ShellEnvReport::TimedOut { .. })));

        let child = helper_pid(&pid_file);
        let gone = std::time::Instant::now();
        while alive(child) {
            assert!(
                gone.elapsed() < Duration::from_secs(5),
                "the profile's child {child} outlived the deadline"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A profile that never stops printing is cut off at the cap and
    /// counted as no answer, well inside the deadline, rather than allowed
    /// to fill memory until it passes.
    #[cfg(unix)]
    #[test]
    fn output_that_never_ends_is_cut_off_at_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = fake_shell(dir.path(), "yes");
        let started = std::time::Instant::now();
        let report = unix::capture(&shell, Duration::from_secs(20))
            .expect_err("an endless stream is not an answer");
        assert!(
            matches!(report, ShellEnvReport::NoAnswer { .. }),
            "{report:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "read until the deadline instead of the cap: {:?}",
            started.elapsed()
        );
    }

    /// A shell that never prints the marker is reported as such, not as a
    /// timeout, and the exit code it gave is carried.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_says_nothing_is_reported_with_its_exit_code() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = fake_shell(dir.path(), "exit 3");
        let report = unix::capture(&shell, Duration::from_secs(5))
            .expect_err("nothing printed is not an answer");
        assert_eq!(
            report,
            ShellEnvReport::NoAnswer {
                shell,
                exit: Some(3)
            }
        );
    }

    /// The bash reproduction of the empty answer, end to end: markers and
    /// nothing else has to come back as no answer, with the exit code, and
    /// never as an import.
    #[cfg(unix)]
    #[test]
    fn markers_with_nothing_between_them_are_no_answer() {
        let dir = tempfile::tempdir().expect("tempdir");
        // `/bin/sh` by path: with PATH emptied, `printf` still prints (a
        // builtin) and `env` is not found, which is the bash reproduction.
        let shell = fake_shell(dir.path(), "PATH=/nowhere /bin/sh -c \"$4\"");
        let report = unix::capture(&shell, Duration::from_secs(5))
            .expect_err("two markers around nothing is not an environment");
        assert!(
            matches!(report, ShellEnvReport::NoAnswer { .. }),
            "{report:?}"
        );
    }

    /// A shell that cannot be started says so with the OS's own words.
    #[cfg(unix)]
    #[test]
    fn a_shell_that_is_not_there_could_not_start() {
        let report = unix::capture("/nowhere/at/all/zsh", Duration::from_secs(5))
            .expect_err("a missing binary is not an answer");
        assert!(matches!(
            report,
            ShellEnvReport::CouldNotStart { ref shell, .. } if shell == "/nowhere/at/all/zsh"
        ));
    }

    /// The wire shape the frontend switches on.
    #[test]
    fn the_report_names_its_outcome_on_the_wire() {
        let json = serde_json::to_value(ShellEnvReport::Imported {
            shell: "/bin/zsh".to_string(),
            adopted: 2,
            removed: 1,
        })
        .expect("serialises");
        assert_eq!(json["outcome"], "imported");
        assert_eq!(json["adopted"], 2);
        assert_eq!(json["removed"], 1);
        assert_eq!(
            serde_json::to_value(ShellEnvReport::NotAsked).expect("serialises")["outcome"],
            "notAsked"
        );
    }

    /// Only an import or a platform that needed none leaves the search path
    /// trustworthy; every other outcome makes it a guess, and the finding
    /// that says so hangs off this.
    #[test]
    fn only_an_import_or_a_platform_that_needs_none_counts_as_answered() {
        assert!(ShellEnvReport::NotAsked.answered());
        assert!(ShellEnvReport::Imported {
            shell: "zsh".into(),
            adopted: 0,
            removed: 0
        }
        .answered());
        assert!(!ShellEnvReport::TimedOut {
            shell: "zsh".into(),
            seconds: 30
        }
        .answered());
        assert!(!ShellEnvReport::NoAnswer {
            shell: "zsh".into(),
            exit: None
        }
        .answered());
    }
}
