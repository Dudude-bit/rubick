//! Input validation utilities
//!
//! This module provides unified validation logic used across all Rubick projects.

/// Validation result with error message
pub type ValidationResult = Result<(), String>;

/// Validate and sanitize pagination parameters
///
/// # Examples
///
/// ```
/// use k8s_gui_common::validation::validate_pagination;
///
/// assert_eq!(validate_pagination(None, None, 100), (50, 0));
/// assert_eq!(validate_pagination(Some(10), Some(20), 100), (10, 20));
/// assert_eq!(validate_pagination(Some(-5), Some(-10), 100), (0, 0));
/// assert_eq!(validate_pagination(Some(200), Some(0), 100), (100, 0));
/// ```
pub fn validate_pagination(limit: Option<i32>, offset: Option<i32>, max_limit: i64) -> (i64, i64) {
    let limit = limit.unwrap_or(50).max(0).min(max_limit as i32) as i64;
    let offset = offset.unwrap_or(0).max(0) as i64;
    (limit, offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pagination_validation() {
        assert_eq!(validate_pagination(None, None, 100), (50, 0));
        assert_eq!(validate_pagination(Some(10), Some(20), 100), (10, 20));
        assert_eq!(validate_pagination(Some(-5), Some(-10), 100), (0, 0));
        assert_eq!(validate_pagination(Some(200), Some(0), 100), (100, 0));
    }
}
