//! Kubernetes Quantity Parsing and Formatting
//!
//! Unified module for parsing and formatting Kubernetes resource quantities.
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

/// Parse CPU quantity string to millicores (f64)
/// Supports formats: "500m", "0.5", "2", "2.5", "100n" (nanocores)
#[must_use]
pub fn parse_cpu(cpu_str: &str) -> f64 {
    let cpu_str = cpu_str.trim();

    if cpu_str.ends_with('m') {
        // Millicores: "500m" -> 500.0 millicores
        cpu_str[..cpu_str.len() - 1].parse::<f64>().unwrap_or(0.0)
    } else if cpu_str.ends_with('n') {
        // Nanocores: "100000000n" -> 100.0 millicores
        let nanocores = cpu_str[..cpu_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        nanocores / 1_000_000.0
    } else if cpu_str.ends_with('u') {
        // Microcores: "1000000u" -> 1000 millicores
        let microcores = cpu_str[..cpu_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        microcores / 1_000.0
    } else {
        // Cores: "2", "0.5", "2.5" -> convert to millicores
        cpu_str.parse::<f64>().unwrap_or(0.0) * 1000.0
    }
}

/// Parse memory quantity string to bytes (u64)
/// Supports formats: "512Mi", "1Gi", "1024Ki", "1073741824", "128974848", "100M", "1G"
#[must_use]
pub fn parse_memory(mem_str: &str) -> u64 {
    let mem_str = mem_str.trim();

    // Binary units (Ki, Mi, Gi, Ti)
    if mem_str.ends_with("Ki") {
        let num = mem_str[..mem_str.len() - 2].parse::<f64>().unwrap_or(0.0);
        (num * KIBIBYTE as f64) as u64
    } else if mem_str.ends_with("Mi") {
        let num = mem_str[..mem_str.len() - 2].parse::<f64>().unwrap_or(0.0);
        (num * MEBIBYTE as f64) as u64
    } else if mem_str.ends_with("Gi") {
        let num = mem_str[..mem_str.len() - 2].parse::<f64>().unwrap_or(0.0);
        (num * GIBIBYTE as f64) as u64
    } else if mem_str.ends_with("Ti") {
        let num = mem_str[..mem_str.len() - 2].parse::<f64>().unwrap_or(0.0);
        (num * TEBIBYTE as f64) as u64
    // Decimal units (K, M, G, T)
    } else if mem_str.ends_with('K') && !mem_str.ends_with("Ki") {
        let num = mem_str[..mem_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        (num * KILOBYTE as f64) as u64
    } else if mem_str.ends_with('M') && !mem_str.ends_with("Mi") {
        let num = mem_str[..mem_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        (num * MEGABYTE as f64) as u64
    } else if mem_str.ends_with('G') && !mem_str.ends_with("Gi") {
        let num = mem_str[..mem_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        (num * GIGABYTE as f64) as u64
    } else if mem_str.ends_with('T') && !mem_str.ends_with("Ti") {
        let num = mem_str[..mem_str.len() - 1].parse::<f64>().unwrap_or(0.0);
        (num * TERABYTE as f64) as u64
    } else {
        // Assume bytes
        mem_str.parse::<u64>().unwrap_or(0)
    }
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
    Some((used / total * 100.0).min(100.0).max(0.0))
}

#[cfg(test)]
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
        assert_eq!(parse_memory("1M"), 1_000_000);
        assert_eq!(parse_memory("1024"), 1024);
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
