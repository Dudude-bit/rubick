//! Shell command execution with user PATH resolution.
//!
//! - `path`:    `USER_PATH` `OnceCell` + login-shell PATH probe + fallback
//!              merge for common locations (homebrew, asdf, cargo).
//! - `command`: `ShellCommand` builder + execution with timeout.

mod command;
mod path;

pub use command::{CommandOutput, ShellCommand, ShellError};
pub use path::{get_user_path, init_user_path};
