//! CRD (Custom Resource Definition) commands.
//!
//! Commands for managing CRDs and the custom-resource instances they
//! define. Split into:
//! - `types`: frontend-facing structs
//! - `convert`: kube → frontend conversions
//! - `crd`: Tauri commands operating on CRDs themselves
//! - `instance`: Tauri commands operating on custom-resource instances

mod convert;
mod crd;
mod instance;
mod types;

// Glob re-exports — `#[tauri::command]` generates a sibling `__cmd__X`
// item next to each command function. The `tauri::generate_handler!`
// macro in main.rs looks up `__cmd__X` in the module path it was given,
// so the named re-exports `pub use crd::{X}` weren't enough — they
// brought `X` but not its `__cmd__X` neighbour. Glob `pub use crd::*`
// re-exports both. Same shape applied to every command-bearing split.
pub use convert::*;
pub use crd::*;
pub use instance::*;
pub use types::*;
