//! Spawning binaries with the environment the user's terminal has.
//!
//! - `env`:     the login shell's environment, asked for once at startup and
//!   adopted by this process; PATH merged with the well-known locations.
//! - `path`:    the merged PATH, and the well-known locations themselves.
//! - `command`: `ShellCommand` builder + execution with timeout.

mod command;
mod env;
mod path;

pub use command::{CommandOutput, ShellCommand, ShellError};
#[cfg(unix)]
pub use env::SHELL_ENV_TIMEOUT;
pub use env::{env_report, import_login_shell_env, ShellEnvReport};
pub use path::get_user_path;
