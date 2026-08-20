//! Kubernetes Quantity Parsing and Formatting
//!
//! Unified module for parsing and formatting Kubernetes resource quantities.

// Converting between numeric types is what this module does: "1.5Gi" becomes
// bytes through f64 and back again. A quantity a cluster reports is never
// negative and stays far below the magnitude where f64's 52-bit mantissa or
// u64's range would round anything a reader could notice.
#![allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
//! Supports both CPU (cores/millicores) and Memory (bytes/Ki/Mi/Gi) formats.

/// Binary unit multipliers (Ki, Mi, Gi, Ti, Pi, Ei)
pub const KIBIBYTE: u64 = 1024;
pub const MEBIBYTE: u64 = 1024 * 1024;
pub const GIBIBYTE: u64 = 1024 * 1024 * 1024;
pub const TEBIBYTE: u64 = 1024 * 1024 * 1024 * 1024;

/// Decimal unit multipliers (K, M, G, T)
pub const KILOBYTE: u64 = 1000;
pub const MEGABYTE: u64 = 1000 * 1000;
pub const GIGABYTE: u64 = 1000 * 1000 * 1000;
pub const TERABYTE: u64 = 1000 * 1000 * 1000 * 1000;

/// Suffix to the divisor that turns the number in front of it into millicores.
const CPU_UNITS: [(char, f64); 3] = [('m', 1.0), ('n', 1_000_000.0), ('u', 1_000.0)];

/// Suffix to the number of bytes it stands for. Binary units are listed
/// first, though nothing depends on the order: a value ending in `Ki` does
/// not end in `K`.
const MEMORY_UNITS: [(&str, u64); 8] = [
    ("Ki", KIBIBYTE),
    ("Mi", MEBIBYTE),
    ("Gi", GIBIBYTE),
    ("Ti", TEBIBYTE),
    ("K", KILOBYTE),
    ("M", MEGABYTE),
    ("G", GIGABYTE),
    ("T", TERABYTE),
];

/// Parse CPU quantity string to millicores (f64)
/// Supports formats: "500m", "0.5", "2", "2.5", "100n" (nanocores)
#[must_use]
pub fn parse_cpu(cpu_str: &str) -> f64 {
    let cpu_str = cpu_str.trim();
    for (suffix, per_millicore) in CPU_UNITS {
        if let Some(num) = cpu_str.strip_suffix(suffix) {
            return num.parse::<f64>().unwrap_or(0.0) / per_millicore;
        }
    }
    // No suffix means cores: "2", "0.5", "2.5".
    cpu_str.parse::<f64>().unwrap_or(0.0) * 1000.0
}

/// Parse memory quantity string to bytes (u64)
/// Supports formats: "512Mi", "1Gi", "1024Ki", "1073741824", "128974848", "100M", "1G"
#[must_use]
pub fn parse_memory(mem_str: &str) -> u64 {
    let mem_str = mem_str.trim();
    for (suffix, bytes) in MEMORY_UNITS {
        if let Some(num) = mem_str.strip_suffix(suffix) {
            return (num.parse::<f64>().unwrap_or(0.0) * bytes as f64) as u64;
        }
    }
    // No suffix means the quantity is already in bytes.
    mem_str.parse::<u64>().unwrap_or(0)
}

/// Format millicores to string representation
/// Returns "500m" for < 1000 millicores, or "2" for >= 1000 millicores
#[must_use]
pub fn format_cpu(millicores: f64) -> String {
    if millicores < 1000.0 {
        format!("{}m", millicores as u64)
    } else {
        let cores = millicores / 1000.0;
        if cores.fract() == 0.0 {
            format!("{}", cores as u64)
        } else {
            format!("{cores:.1}")
        }
    }
}

/// Format bytes to human-readable string
/// Returns format like "512Mi", "1Gi", etc.
#[must_use]
pub fn format_memory(bytes: u64) -> String {
    if bytes == 0 {
        return "0".to_string();
    }

    let tib = bytes as f64 / TEBIBYTE as f64;
    if tib >= 1.0 {
        return format!("{tib:.2}Ti");
    }

    let gib = bytes as f64 / GIBIBYTE as f64;
    if gib >= 1.0 {
        return format!("{gib:.2}Gi");
    }

    let mib = bytes as f64 / MEBIBYTE as f64;
    if mib >= 1.0 {
        return format!("{mib:.2}Mi");
    }

    let kib = bytes as f64 / KIBIBYTE as f64;
    if kib >= 1.0 {
        return format!("{kib:.2}Ki");
    }

    format!("{bytes}")
}

/// Calculate utilization percentage
#[must_use]
pub fn calculate_utilization(used: f64, total: f64) -> Option<f64> {
    if total <= 0.0 {
        return None;
    }
    Some((used / total * 100.0).clamp(0.0, 100.0))
}

#[cfg(test)]
// Every float here is compared against a value the arithmetic under test
// produces exactly, so an exact comparison is the assertion we want.
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_cpu() {
        assert_eq!(parse_cpu("500m"), 500.0);
        assert_eq!(parse_cpu("1"), 1000.0);
        assert_eq!(parse_cpu("2.5"), 2500.0);
        assert_eq!(parse_cpu("100000000n"), 100.0);
    }

    #[test]
    fn test_parse_memory() {
        assert_eq!(parse_memory("1Ki"), 1024);
        assert_eq!(parse_memory("1Mi"), 1024 * 1024);
        assert_eq!(parse_memory("1Gi"), 1024 * 1024 * 1024);
        assert_eq!(parse_memory("1Ti"), 1024_u64.pow(4));
        assert_eq!(parse_memory("1K"), 1_000);
        assert_eq!(parse_memory("1M"), 1_000_000);
        assert_eq!(parse_memory("1G"), 1_000_000_000);
        assert_eq!(parse_memory("1T"), 1_000_000_000_000);
        assert_eq!(parse_memory("1024"), 1024);
        assert_eq!(parse_memory("1.5Gi"), 1024 * 1024 * 1024 * 3 / 2);
        assert_eq!(parse_memory("  512Mi  "), 512 * 1024 * 1024);
        assert_eq!(parse_memory(""), 0);
        assert_eq!(parse_memory("nonsense"), 0);
        assert_eq!(parse_memory("Gi"), 0);
    }

    #[test]
    fn test_format_cpu() {
        assert_eq!(format_cpu(500.0), "500m");
        assert_eq!(format_cpu(1000.0), "1");
        assert_eq!(format_cpu(2500.0), "2.5");
    }

    #[test]
    fn test_format_memory() {
        assert_eq!(format_memory(1024), "1.00Ki");
        assert_eq!(format_memory(1024 * 1024), "1.00Mi");
        assert_eq!(format_memory(1024 * 1024 * 1024), "1.00Gi");
    }

    #[test]
    fn test_calculate_utilization() {
        assert_eq!(calculate_utilization(50.0, 100.0), Some(50.0));
        assert_eq!(calculate_utilization(150.0, 100.0), Some(100.0));
        assert_eq!(calculate_utilization(-10.0, 100.0), Some(0.0));
        assert_eq!(calculate_utilization(10.0, 0.0), None);
    }
}
