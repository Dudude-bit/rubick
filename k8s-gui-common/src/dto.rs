//! Common Data Transfer Objects (DTOs)
//!
//! This module provides shared request/response structures used across
//! all Rubick projects.

use serde::{Deserialize, Serialize};

/// Generic message response DTO
///
/// Used for simple responses that only contain a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResponse {
    /// Response message
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_response_serialization() {
        let response = MessageResponse {
            message: "ok".to_string(),
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("message"));

        let parsed: MessageResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.message, response.message);
    }
}
