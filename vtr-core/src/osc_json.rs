//! The OSC↔JSON codec, owned in one place so record and replay agree.
//!
//! The tap records each arg as a JSON value plus an OSC type tag char; the
//! `types` field of a JSONL line is those tags concatenated. Replay must
//! encode by the tag, not by the JSON value's shape — `r`, `I` and big `h`
//! args all land as JSON strings and would otherwise go back out as OSC
//! strings. See the JSONL schema section in README.md.
//!
//! Two conversions are one-way by design, so nothing round-trips them:
//! blob args are dropped at record time (no tag, no value), and OSC types
//! with no tag of their own (Time, Char, Midi, Array, ...) are recorded as
//! `s` plus a debug string.

use rosc::{OscColor, OscType};
use serde_json::{json, Value};

use crate::RateLimitedLog;

/// int64s beyond ±2^53 don't survive a JS JSON.parse (f64 rounding).
const JS_SAFE_INT: u64 = 1 << 53;

/// JSON value plus its OSC type tag. `types` in the JSONL line is these tags
/// concatenated, so a skipped arg (blob) must skip its tag too. Warnings go
/// through `log`: these run per arg per packet on the recording path.
pub fn to_json(arg: &OscType, log: &mut RateLimitedLog) -> Option<(char, Value)> {
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

/// One arg back to OSC. `tag` is its char from the line's `types`, or None
/// when the line has no usable `types` — then the JSON shape is all we have.
pub fn from_json(tag: Option<char>, v: &Value) -> OscType {
    let Some(tag) = tag else {
        return guess(v);
    };
    match tag {
        // json! turns a non-finite float into null, so NaN and infinity both
        // record as `("f", null)`. Replaying NaN at least keeps the message
        // signature `,f` — Nil would change it.
        'f' => match v.as_f64() {
            Some(f) => OscType::Float(f as f32),
            None if v.is_null() => OscType::Float(f32::NAN),
            None => guess(v),
        },
        'd' => match v.as_f64() {
            Some(d) => OscType::Double(d),
            None if v.is_null() => OscType::Double(f64::NAN),
            None => guess(v),
        },
        'i' => match v.as_i64() {
            Some(i) => OscType::Int(i.clamp(i32::MIN as i64, i32::MAX as i64) as i32),
            None => guess(v),
        },
        // Beyond ±2^53 the recorded value is a decimal string.
        'h' => match v.as_i64().or_else(|| v.as_str()?.parse().ok()) {
            Some(i) => OscType::Long(i),
            None => guess(v),
        },
        's' => match v {
            Value::String(s) => OscType::String(s.clone()),
            other => OscType::String(other.to_string()),
        },
        'T' => OscType::Bool(true),
        'F' => OscType::Bool(false),
        'r' => match v.as_str().and_then(parse_color) {
            Some(c) => OscType::Color(c),
            None => guess(v),
        },
        'I' => OscType::Inf,
        'N' => OscType::Nil,
        _ => guess(v),
    }
}

/// A message's args back to OSC. A `types` whose length doesn't match `args`
/// is unusable positionally, so every arg falls back to guessing — that also
/// covers the empty `types` of pre-`types` clips and editor-added events.
pub fn args_from_json(types: &str, args: &[Value]) -> Vec<OscType> {
    if types.chars().count() != args.len() {
        return args.iter().map(guess).collect();
    }
    types
        .chars()
        .zip(args)
        .map(|(tag, v)| from_json(Some(tag), v))
        .collect()
}

/// Best effort when the tag is missing: integral numbers narrow to the
/// smallest int that holds them, everything else follows the JSON shape.
fn guess(v: &Value) -> OscType {
    match v {
        Value::Number(n) if n.is_i64() => {
            let i = n.as_i64().unwrap();
            match i32::try_from(i) {
                Ok(i) => OscType::Int(i),
                Err(_) => OscType::Long(i),
            }
        }
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if (f as f32) as f64 == f {
                OscType::Float(f as f32)
            } else {
                OscType::Double(f)
            }
        }
        Value::String(s) => OscType::String(s.clone()),
        Value::Bool(b) => OscType::Bool(*b),
        Value::Null => OscType::Nil,
        other => OscType::String(other.to_string()),
    }
}

fn parse_color(s: &str) -> Option<OscColor> {
    let hex = s.strip_prefix('#')?;
    if hex.len() != 8 || !hex.is_ascii() {
        return None;
    }
    let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some(OscColor {
        red: byte(0)?,
        green: byte(2)?,
        blue: byte(4)?,
        alpha: byte(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log() -> RateLimitedLog {
        RateLimitedLog::new("vtr-core")
    }

    const COLOR: OscColor = OscColor {
        red: 255,
        green: 0,
        blue: 16,
        alpha: 32,
    };

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
            (OscType::Color(COLOR), 'r', json!("#ff001020")),
            (OscType::Inf, 'I', json!("<impulse>")),
            (OscType::Nil, 'N', Value::Null),
        ];
        for (arg, tag, value) in cases {
            let (t, v) = to_json(&arg, &mut log()).unwrap();
            assert_eq!((t, v), (tag, value), "arg {arg:?}");
        }
    }

    #[test]
    fn big_long_becomes_string_small_stays_number() {
        let big = (1i64 << 53) + 1;
        assert_eq!(
            to_json(&OscType::Long(big), &mut log()).unwrap(),
            ('h', json!(big.to_string()))
        );
        assert_eq!(
            to_json(&OscType::Long(-big), &mut log()).unwrap(),
            ('h', json!((-big).to_string()))
        );
        assert_eq!(
            to_json(&OscType::Long(i64::MIN), &mut log()).unwrap(),
            ('h', json!(i64::MIN.to_string()))
        );
        // Exactly ±2^53 is representable in f64: stays a number.
        assert_eq!(
            to_json(&OscType::Long(1 << 53), &mut log()).unwrap(),
            ('h', json!(1i64 << 53))
        );
    }

    #[test]
    fn blob_skips_value_and_tag() {
        assert!(to_json(&OscType::Blob(vec![1, 2, 3]), &mut log()).is_none());
    }

    /// Every arg the tap can record with a tag of its own, through both
    /// directions. Blobs and tagless OSC types are one-way (see the module
    /// doc) and can't appear here.
    #[test]
    fn every_supported_type_round_trips() {
        let cases = [
            OscType::Float(0.42),
            OscType::Float(0.0),
            OscType::Float(-0.0),
            OscType::Float(f32::MIN_POSITIVE),
            OscType::Float(f32::MAX),
            OscType::Double(0.5),
            OscType::Double(1_753_776_000.123_45),
            OscType::Double(f64::MIN_POSITIVE),
            OscType::Int(0),
            OscType::Int(i32::MIN),
            OscType::Int(i32::MAX),
            OscType::Long(0),
            OscType::Long(1 << 53),
            OscType::Long(-(1 << 53)),
            OscType::Long((1 << 53) + 1),
            OscType::Long(-((1 << 53) + 1)),
            OscType::Long(i64::MIN),
            OscType::Long(i64::MAX),
            OscType::String(String::new()),
            OscType::String("hi".into()),
            OscType::String("#ff001020".into()),
            OscType::Bool(true),
            OscType::Bool(false),
            OscType::Color(COLOR),
            OscType::Color(OscColor {
                red: 0,
                green: 0,
                blue: 0,
                alpha: 0,
            }),
            OscType::Inf,
            OscType::Nil,
        ];
        for arg in cases {
            let (tag, v) = to_json(&arg, &mut log()).unwrap();
            assert_eq!(from_json(Some(tag), &v), arg, "tag {tag} value {v}");
        }
    }

    /// The other direction: a well-formed (tag, value) pair survives a trip
    /// through OSC unchanged, so replay can't drift from what was recorded.
    #[test]
    fn tagged_values_are_stable_through_osc() {
        let cases = [
            ('f', json!(0.42)),
            ('d', json!(1_753_776_000.123_45)),
            ('i', json!(-7)),
            ('h', json!(9007199254740992i64)),
            ('h', json!("9007199254740993")),
            ('s', json!("hi")),
            ('T', json!(true)),
            ('F', json!(false)),
            ('r', json!("#ff001020")),
            ('I', json!("<impulse>")),
            ('N', Value::Null),
        ];
        for (tag, v) in cases {
            let got = to_json(&from_json(Some(tag), &v), &mut log()).unwrap();
            assert_eq!(got, (tag, v.clone()), "tag {tag} value {v}");
        }
    }

    /// The bug this module exists to fix: these three used to replay as OSC
    /// strings because the encoder read the JSON value instead of the tag.
    #[test]
    fn string_shaped_args_decode_by_tag() {
        assert_eq!(
            args_from_json(
                "rIh",
                &[
                    json!("#ff001020"),
                    json!("<impulse>"),
                    json!("-12345678901234567")
                ]
            ),
            vec![
                OscType::Color(COLOR),
                OscType::Inf,
                OscType::Long(-12345678901234567),
            ]
        );
    }

    #[test]
    fn tags_pick_the_width_the_json_value_cannot() {
        // A whole number tagged `d` is a Double, not a Float; a small `h` is
        // a Long, not an Int. Guessing gets both wrong.
        assert_eq!(
            args_from_json("dh", &[json!(0.5), json!(7)]),
            vec![OscType::Double(0.5), OscType::Long(7)]
        );
        assert_eq!(
            args_from_json("", &[json!(0.5), json!(7)]),
            vec![OscType::Float(0.5), OscType::Int(7)]
        );
    }

    #[test]
    fn missing_or_mismatched_types_falls_back_to_guessing() {
        let args = [json!(1), json!(0.25), json!("hi"), json!(true), Value::Null];
        let want = vec![
            OscType::Int(1),
            OscType::Float(0.25),
            OscType::String("hi".into()),
            OscType::Bool(true),
            OscType::Nil,
        ];
        // Empty (pre-`types` clips, editor-added events), too short, too long.
        assert_eq!(args_from_json("", &args), want);
        assert_eq!(args_from_json("if", &args), want);
        assert_eq!(args_from_json("ifsTNN", &args), want);
        assert_eq!(args_from_json("", &[]), Vec::<OscType>::new());
    }

    #[test]
    fn non_finite_floats_record_as_null_and_replay_as_nan() {
        for arg in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let (tag, v) = to_json(&OscType::Float(arg), &mut log()).unwrap();
            assert_eq!((tag, &v), ('f', &Value::Null), "{arg}");
            let OscType::Float(got) = from_json(Some('f'), &v) else {
                panic!("tag f must stay a Float so the message signature holds");
            };
            assert!(got.is_nan());
        }
        let (tag, v) = to_json(&OscType::Double(f64::NAN), &mut log()).unwrap();
        assert_eq!((tag, &v), ('d', &Value::Null));
        let OscType::Double(got) = from_json(Some('d'), &v) else {
            panic!("tag d must stay a Double");
        };
        assert!(got.is_nan());
    }

    #[test]
    fn unusable_tagged_values_fall_back_instead_of_panicking() {
        // Malformed colors, unparseable longs, unknown tags.
        assert_eq!(
            from_json(Some('r'), &json!("#ff00")),
            OscType::String("#ff00".into())
        );
        assert_eq!(
            from_json(Some('r'), &json!("#gggggggg")),
            OscType::String("#gggggggg".into())
        );
        assert_eq!(
            from_json(Some('h'), &json!("nope")),
            OscType::String("nope".into())
        );
        assert_eq!(
            from_json(Some('i'), &json!("nope")),
            OscType::String("nope".into())
        );
        assert_eq!(from_json(Some('z'), &json!(2)), OscType::Int(2));
        // Out-of-range ints clamp rather than wrap.
        assert_eq!(
            from_json(Some('i'), &json!(i64::MAX)),
            OscType::Int(i32::MAX)
        );
    }

    #[test]
    fn unsupported_osc_types_are_one_way() {
        let (tag, v) = to_json(&OscType::Char('x'), &mut log()).unwrap();
        assert_eq!(tag, 's');
        assert_eq!(
            from_json(Some('s'), &v),
            OscType::String("Char('x')".into())
        );
    }
}
