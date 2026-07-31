use std::fs::File;
use std::io::Write as _;

use serde_json::Value;

/// Write one JSON line and flush so a crash loses nothing. Callers log;
/// at 120 Hz an unthrottled per-packet eprintln would flood the editor pipe.
pub(super) fn write_line(file: &mut File, value: &Value) -> Result<(), String> {
    let mut line = value.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| e.to_string())
}

pub(super) fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}
