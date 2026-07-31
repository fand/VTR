use std::fs::File;
use std::io::Write as _;

use rosc::OscType;
use serde_json::{json, Value};

use vtr_core::RateLimitedLog;

/// Write one JSON line and flush so a crash loses nothing. Callers log;
/// at 120 Hz an unthrottled per-packet eprintln would flood the editor pipe.
pub(super) fn write_line(file: &mut File, value: &Value) -> Result<(), String> {
    let mut line = value.to_string();
    line.push('\n');
    file.write_all(line.as_bytes())
        .and_then(|_| file.flush())
        .map_err(|e| e.to_string())
}

/// int64s beyond ±2^53 don't survive a JS JSON.parse (f64 rounding).
const JS_SAFE_INT: u64 = 1 << 53;

/// JSON value plus its OSC type tag. `types` in the JSONL line is these tags
/// concatenated, so a skipped arg (blob) must skip its tag too. Warnings go
/// through `log`: these run per arg per packet on the recording path.
pub(super) fn arg_to_json_tagged(arg: &OscType, log: &mut RateLimitedLog) -> Option<(char, Value)> {
    match arg {
        // Shortest f32 repr, reparsed as f64, so 0.42f32 logs as 0.42.
        OscType::Float(f) => Some(('f', json!(f.to_string().parse::<f64>().unwrap_or(*f as f64)))),
        OscType::Double(d) => Some(('d', json!(d))),
        OscType::Int(i) => Some(('i', json!(i))),
        OscType::Long(i) if i.unsigned_abs() > JS_SAFE_INT => Some(('h', json!(i.to_string()))),
        OscType::Long(i) => Some(('h', json!(i))),
        OscType::String(s) => Some(('s', json!(s))),
        OscType::Bool(true) => Some(('T', json!(true))),
        OscType::Bool(false) => Some(('F', json!(false))),
        OscType::Color(c) => Some((
            'r',
            json!(format!(
                "#{:02x}{:02x}{:02x}{:02x}",
                c.red, c.green, c.blue, c.alpha
            )),
        )),
        OscType::Inf => Some(('I', json!("<impulse>"))),
        OscType::Nil => Some(('N', Value::Null)),
        OscType::Blob(b) => {
            log.log(&format!("warn: blob arg skipped ({} bytes)", b.len()));
            None
        }
        other => {
            log.log(&format!("warn: unsupported arg {other:?}, stringified"));
            Some(('s', json!(format!("{other:?}"))))
        }
    }
}

pub(super) fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_cover_every_serialized_type() {
        let cases = [
            (OscType::Float(0.42), 'f', json!(0.42)),
            (OscType::Double(0.5), 'd', json!(0.5)),
            (OscType::Int(3), 'i', json!(3)),
            (OscType::Long(3), 'h', json!(3)),
            (OscType::String("hi".into()), 's', json!("hi")),
            (OscType::Bool(true), 'T', json!(true)),
            (OscType::Bool(false), 'F', json!(false)),
            (
                OscType::Color(rosc::OscColor {
                    red: 255,
                    green: 0,
                    blue: 16,
                    alpha: 32,
                }),
                'r',
                json!("#ff001020"),
            ),
            (OscType::Inf, 'I', json!("<impulse>")),
            (OscType::Nil, 'N', Value::Null),
        ];
        let mut log = RateLimitedLog::new("vtr-tap");
        for (arg, tag, value) in cases {
            let (t, v) = arg_to_json_tagged(&arg, &mut log).unwrap();
            assert_eq!((t, v), (tag, value), "arg {arg:?}");
        }
    }

    #[test]
    fn big_long_becomes_string_small_stays_number() {
        let mut log = RateLimitedLog::new("vtr-tap");
        let big = (1i64 << 53) + 1;
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(big), &mut log).unwrap(),
            ('h', json!(big.to_string()))
        );
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(-big), &mut log).unwrap(),
            ('h', json!((-big).to_string()))
        );
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(i64::MIN), &mut log).unwrap(),
            ('h', json!(i64::MIN.to_string()))
        );
        // Exactly ±2^53 is representable in f64: stays a number.
        assert_eq!(
            arg_to_json_tagged(&OscType::Long(1 << 53), &mut log).unwrap(),
            ('h', json!(1i64 << 53))
        );
    }

    #[test]
    fn blob_skips_value_and_tag() {
        let mut log = RateLimitedLog::new("vtr-tap");
        assert!(arg_to_json_tagged(&OscType::Blob(vec![1, 2, 3]), &mut log).is_none());
    }
}
