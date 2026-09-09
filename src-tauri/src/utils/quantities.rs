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

pub const PEBIBYTE: u64 = 1024 * TEBIBYTE;
pub const EXBIBYTE: u64 = 1024 * PEBIBYTE;

/// Decimal unit multipliers (K, M, G, T)
pub const KILOBYTE: u64 = 1000;
pub const MEGABYTE: u64 = 1000 * 1000;
pub const GIGABYTE: u64 = 1000 * 1000 * 1000;
pub const TERABYTE: u64 = 1000 * 1000 * 1000 * 1000;
pub const PETABYTE: u64 = 1000 * TERABYTE;
pub const EXABYTE: u64 = 1000 * PETABYTE;

/// Suffix to the divisor that turns the number in front of it into millicores.
const CPU_UNITS: [(char, f64); 3] = [('m', 1.0), ('n', 1_000_000.0), ('u', 1_000.0)];

/// Suffix to the number of bytes it stands for. Binary units are listed
/// first, though nothing depends on the order: a value ending in `Ki` does
/// not end in `K`.
const MEMORY_UNITS: [(&str, u64); 12] = [
    ("Ki", KIBIBYTE),
    ("Mi", MEBIBYTE),
    ("Gi", GIBIBYTE),
    ("Ti", TEBIBYTE),
    ("Pi", PEBIBYTE),
    ("Ei", EXBIBYTE),
    ("K", KILOBYTE),
    ("M", MEGABYTE),
    ("G", GIGABYTE),
    ("T", TERABYTE),
    ("P", PETABYTE),
    ("E", EXABYTE),
];

/// Parse CPU quantity string to millicores (f64)
/// Supports formats: "500m", "0.5", "2", "2.5", "100n" (nanocores)
#[must_use]
pub fn parse_cpu(cpu_str: &str) -> f64 {
    parse_cpu_checked(cpu_str).unwrap_or(0.0)
}

/// Like [`parse_cpu`], but `None` when the number itself will not parse, so a
/// caller can tell "could not read" from a real zero rather than collapse the
/// two. An unknown *suffix* still falls through to the no-suffix (cores) path.
#[must_use]
pub fn parse_cpu_checked(cpu_str: &str) -> Option<f64> {
    let cpu_str = cpu_str.trim();
    for (suffix, per_millicore) in CPU_UNITS {
        if let Some(num) = cpu_str.strip_suffix(suffix) {
            return num.parse::<f64>().ok().map(|n| n / per_millicore);
        }
    }
    // No suffix means cores: "2", "0.5", "2.5".
    cpu_str.parse::<f64>().ok().map(|n| n * 1000.0)
}

/// Parse memory quantity string to bytes (u64)
/// Supports formats: "512Mi", "1Gi", "1024Ki", "1073741824", "128974848", "100M", "1G"
#[must_use]
pub fn parse_memory(mem_str: &str) -> u64 {
    parse_memory_checked(mem_str).unwrap_or(0)
}

/// Like [`parse_memory`], but `None` when the number itself will not parse, so
/// a caller can tell "could not read" from a real zero rather than collapse
/// the two.
#[must_use]
pub fn parse_memory_checked(mem_str: &str) -> Option<u64> {
    let mem_str = mem_str.trim();
    for (suffix, bytes) in MEMORY_UNITS {
        if let Some(num) = mem_str.strip_suffix(suffix) {
            return num.parse::<f64>().ok().map(|n| (n * bytes as f64) as u64);
        }
    }
    // No suffix means the quantity is already in bytes.
    mem_str.parse::<u64>().ok()
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

    /// Pi/Ei and P/E are valid Kubernetes suffixes the table lacked; an
    /// unhandled suffix fell through to the no-suffix path and parsed to a
    /// silent zero — the collapse node_budget's `parse` must not make.
    #[test]
    fn the_large_binary_and_decimal_suffixes_parse() {
        assert_eq!(parse_memory("1Pi"), 1024_u64.pow(5));
        assert_eq!(parse_memory("1Ei"), 1024_u64.pow(6));
        assert_eq!(parse_memory("1P"), 1_000_000_000_000_000);
        assert_eq!(parse_memory("1E"), 1_000_000_000_000_000_000);
    }

    /// The checked parsers tell "could not read" from a real zero, so a caller
    /// can carry unknown rather than answer a confident 0.
    #[test]
    fn the_checked_parsers_return_none_for_an_unreadable_quantity() {
        assert_eq!(parse_memory_checked("nonsense"), None);
        assert_eq!(parse_memory_checked("Gi"), None);
        assert_eq!(parse_memory_checked("2Gi"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_memory_checked("0"), Some(0));
        assert_eq!(parse_cpu_checked("banana"), None);
        assert_eq!(parse_cpu_checked("500m"), Some(500.0));
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
}
