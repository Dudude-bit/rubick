//! `ShellCommand` builder + execution. Wraps `tokio::process::Command`
//! with timeout enforcement and the user PATH from `super::path`.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;

use super::path::get_user_path;

/// `CREATE_NO_WINDOW` — a console app spawned from a GUI gets no console of
/// its own.
///
/// Windows gives a subsystem-windows process no console, so `CreateProcess`
/// allocates one for every console child and it appears on screen. Nothing
/// here is meant to be looked at: these are `--version` probes and `kubectl`
/// calls whose pipes we read ourselves. Reported against 4.9.0 — opening
/// Settings → Diagnostics fires six tool probes at once and six windows
/// flash over whatever the reader was doing.
///
/// This is `run`'s business rather than each caller's: one spawn point, one
/// place to decide. The auth PTY is deliberately not this — `ConPTY` has no
/// window to begin with, and its child is one the reader can watch.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Errors that can occur during shell command execution.
#[derive(Debug, Error)]
pub enum ShellError {
    #[error("Command timed out after {0:?}")]
    Timeout(Duration),

    #[error("Failed to execute command: {0}")]
    Exec(String),

    #[error("Command failed with exit code {code:?}: {stderr}")]
    Failed { code: Option<i32>, stderr: String },
}

pub type Result<T> = std::result::Result<T, ShellError>;

/// Output from a shell command execution.
#[derive(Debug)]
pub struct CommandOutput {
    /// Standard output as string.
    pub stdout: String,
    /// Standard error as string.
    pub stderr: String,
    /// Exit code if available.
    pub exit_code: Option<i32>,
}

impl CommandOutput {
    /// Returns true if the command exited with code 0.
    #[must_use]
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// Builder for shell commands with user PATH and timeout.
pub struct ShellCommand {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) envs: HashMap<String, String>,
    pub(crate) timeout: Duration,
    pub(crate) current_dir: Option<PathBuf>,
}

impl ShellCommand {
    /// Create a new shell command.
    /// Accepts any type that can be converted to `OsStr` (String, &str, `PathBuf`, &Path, `OsString`, etc.)
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_owned(),
            args: Vec::new(),
            envs: HashMap::new(),
            timeout: Duration::from_secs(30),
            current_dir: None,
        }
    }

    /// Add a single argument.
    #[must_use]
    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_owned());
        self
    }

    /// Add multiple arguments.
    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|s| s.as_ref().to_owned()));
        self
    }

    /// Set an environment variable.
    #[must_use]
    pub fn env(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.envs.insert(key.into(), val.into());
        self
    }

    /// Set the command timeout (default: 30s).
    #[must_use]
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Set the working directory.
    #[must_use]
    pub fn current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(dir.into());
        self
    }

    /// Execute the command and return stdout if successful.
    ///
    /// Returns error if command exits with non-zero code.
    pub async fn run_success(self) -> Result<String> {
        let output = self.run().await?;
        if output.success() {
            Ok(output.stdout)
        } else {
            Err(ShellError::Failed {
                code: output.exit_code,
                stderr: output.stderr,
            })
        }
    }

    /// Execute the command and return output.
    pub async fn run(self) -> Result<CommandOutput> {
        let mut cmd = Command::new(&self.program);

        cmd.args(&self.args);
        // The timeout below enforces itself by dropping the future, and a
        // dropped `tokio::process` child is not a killed one by default: a
        // credential plugin that hangs kept running after the app had given
        // up waiting for it, holding its pipes for the life of the process.
        cmd.kill_on_drop(true);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        // Apply user PATH
        let user_path = get_user_path();
        if !user_path.is_empty() {
            cmd.env("PATH", user_path);
        }

        // Apply additional env vars
        for (key, val) in &self.envs {
            cmd.env(key, val);
        }

        // Set working directory if specified
        if let Some(dir) = &self.current_dir {
            cmd.current_dir(dir);
        }

        // Execute with timeout
        let output = tokio::time::timeout(self.timeout, cmd.output())
            .await
            .map_err(|_| ShellError::Timeout(self.timeout))?
            .map_err(|e| ShellError::Exec(e.to_string()))?;

        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_output_success() {
        let output = CommandOutput {
            stdout: "hello".to_string(),
            stderr: String::new(),
            exit_code: Some(0),
        };
        assert!(output.success());

        let failed = CommandOutput {
            stdout: String::new(),
            stderr: "error".to_string(),
            exit_code: Some(1),
        };
        assert!(!failed.success());
    }

    #[test]
    fn test_shell_command_builder() {
        let cmd = ShellCommand::new("echo")
            .arg("hello")
            .args(["world", "!"])
            .env("FOO", "bar")
            .timeout(Duration::from_mins(1));

        assert_eq!(cmd.program, OsString::from("echo"));
        assert_eq!(
            cmd.args,
            vec![
                OsString::from("hello"),
                OsString::from("world"),
                OsString::from("!")
            ]
        );
        assert_eq!(cmd.envs.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(cmd.timeout, Duration::from_mins(1));
    }

    #[tokio::test]
    async fn test_shell_command_run_echo() {
        let output = ShellCommand::new("echo")
            .arg("hello")
            .run()
            .await
            .expect("echo should succeed");

        assert!(output.success());
        assert_eq!(output.stdout.trim(), "hello");
        assert!(output.stderr.is_empty());
    }

    #[tokio::test]
    async fn test_shell_command_run_timeout() {
        let result = ShellCommand::new("sleep")
            .arg("10")
            .timeout(Duration::from_millis(100))
            .run()
            .await;

        assert!(matches!(result, Err(ShellError::Timeout(_))));
    }

    #[tokio::test]
    async fn test_shell_command_run_success() {
        let stdout = ShellCommand::new("echo")
            .arg("hello")
            .run_success()
            .await
            .expect("should succeed");

        assert_eq!(stdout.trim(), "hello");
    }

    #[tokio::test]
    async fn test_shell_command_run_success_fails_on_error() {
        let result = ShellCommand::new("sh")
            .args(["-c", "echo error >&2; exit 1"])
            .run_success()
            .await;

        assert!(matches!(result, Err(ShellError::Failed { .. })));
    }
}
