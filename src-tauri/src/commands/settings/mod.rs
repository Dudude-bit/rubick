//! Settings and configuration commands.
//!
//! Split into:
//! - `helpers`: thin `save_config` / `with_config` / `read_config` wrappers
//! - `cloud`:   GCP + Azure + bindings + CLI paths
//! - `prefs`:   theme + YAML history + recent +
//!   updater + cluster preferences + `AppInfo`

mod cloud;
pub mod helpers;
mod prefs;

// Glob re-exports — see commands/crds/mod.rs for why `pub use sub::*`
// is required to bring along the `__cmd__X` siblings that
// `#[tauri::command]` generates.
pub use cloud::*;
pub use helpers::*;
pub use prefs::*;
