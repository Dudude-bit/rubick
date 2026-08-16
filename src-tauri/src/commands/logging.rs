//! Logging commands
use crate::error::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Log entry from frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendLogEntry {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub data: Option<Value>,
    /// Timestamp in milliseconds since epoch
    #[serde(default)]
    pub timestamp: Option<i64>,
}

/// Result of batch logging operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchLogResult {
    pub processed: usize,
    pub failed: usize,
}

fn log_frontend(level: &str, message: &str, context: Option<&str>, data: Option<Value>) {
    let message = match context {
        Some(ctx) if !ctx.is_empty() => format!("[{}] {}", ctx, message),
        _ => message.to_string(),
    };

    match level.to_lowercase().as_str() {
        "debug" => {
            if let Some(d) = data {
                tracing::debug!(target: "frontend", data = ?d, "{}", message);
            } else {
                tracing::debug!(target: "frontend", "{}", message);
            }
        }
        "info" | "log" => {
            if let Some(d) = data {
                tracing::info!(target: "frontend", data = ?d, "{}", message);
            } else {
                tracing::info!(target: "frontend", "{}", message);
            }
        }
        "warn" => {
            if let Some(d) = data {
                tracing::warn!(target: "frontend", data = ?d, "{}", message);
            } else {
                tracing::warn!(target: "frontend", "{}", message);
            }
        }
        "error" => {
            if let Some(d) = data {
                tracing::error!(target: "frontend", data = ?d, "{}", message);
            } else {
                tracing::error!(target: "frontend", "{}", message);
            }
        }
        _ => {
            tracing::info!(target: "frontend", "{} (unknown level: {})", message, level);
        }
    }
}

/// Log multiple frontend events in a single batch.
#[tauri::command]
pub fn log_frontend_events_batch(entries: Vec<FrontendLogEntry>) -> Result<BatchLogResult> {
    let total = entries.len();
    let failed = 0;

    for entry in entries {
        // We don't actually fail on individual entries, just log them all
        log_frontend(
            &entry.level,
            &entry.message,
            entry.context.as_deref(),
            entry.data,
        );
    }

    Ok(BatchLogResult {
        processed: total - failed,
        failed,
    })
}
