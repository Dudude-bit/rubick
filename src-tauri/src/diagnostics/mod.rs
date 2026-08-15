//! What the app can see of the machine it runs on, and what is wrong with it.
//!
//! Collection answers questions; findings turn those answers into sentences.
//! They are separate because the connect-time refusal in
//! `auth::interactive::exec` needs the sentences without needing the whole
//! environment — and because both have to say the same thing about the same
//! machine, which two implementations cannot promise.

pub mod findings;

pub use findings::{missing_plugin_finding, Finding, Severity};
