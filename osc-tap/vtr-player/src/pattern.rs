//! OSC address pattern matching for trigger classification.
//!
//! Own implementation of the `*`, `?`, `[]`, `{}` subset, matching what
//! `tdu.match` provides for our patterns. `rosc::address::Matcher` was
//! tried first but its `*` requires at least one character, so `/kick*`
//! would not match `/kick`. Wildcards never cross a `/`. Patterns are
//! supplied at `load` and compiled once; the resolver turns them into a
//! per-address bool table.

#[derive(Debug)]
enum Tok {
    Lit(char),
    /// `*`: zero or more non-`/` characters.
    Any,
    /// `?`: exactly one non-`/` character.
    One,
    /// `[abc]` / `[a-z]` / `[!...]`: one non-`/` character (not) in the set.
    Class { negated: bool, chars: Vec<char> },
    /// `{foo,bar}`: one of the literal alternatives.
    Choice(Vec<String>),
}

fn compile_one(pattern: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => toks.push(Tok::Any),
            '?' => toks.push(Tok::One),
            '[' => {
                let end = chars[i + 1..]
                    .iter()
                    .position(|&c| c == ']')
                    .map(|p| i + 1 + p)
                    .ok_or("unclosed [")?;
                let mut inner = &chars[i + 1..end];
                let negated = inner.first() == Some(&'!');
                if negated {
                    inner = &inner[1..];
                }
                if inner.is_empty() {
                    return Err("empty character class".into());
                }
                let mut set = Vec::new();
                let mut j = 0;
                while j < inner.len() {
                    if j + 2 < inner.len() && inner[j + 1] == '-' {
                        set.extend(inner[j]..=inner[j + 2]);
                        j += 3;
                    } else {
                        set.push(inner[j]);
                        j += 1;
                    }
                }
                toks.push(Tok::Class { negated, chars: set });
                i = end;
            }
            '{' => {
                let end = chars[i + 1..]
                    .iter()
                    .position(|&c| c == '}')
                    .map(|p| i + 1 + p)
                    .ok_or("unclosed {")?;
                let inner: String = chars[i + 1..end].iter().collect();
                toks.push(Tok::Choice(inner.split(',').map(String::from).collect()));
                i = end;
            }
            c => toks.push(Tok::Lit(c)),
        }
        i += 1;
    }
    Ok(toks)
}

fn matches_from(toks: &[Tok], addr: &[char]) -> bool {
    match toks.first() {
        None => addr.is_empty(),
        Some(Tok::Lit(c)) => addr.first() == Some(c) && matches_from(&toks[1..], &addr[1..]),
        Some(Tok::One) => {
            addr.first().is_some_and(|&c| c != '/') && matches_from(&toks[1..], &addr[1..])
        }
        Some(Tok::Class { negated, chars }) => {
            addr.first()
                .is_some_and(|&c| c != '/' && chars.contains(&c) != *negated)
                && matches_from(&toks[1..], &addr[1..])
        }
        Some(Tok::Choice(opts)) => opts.iter().any(|o| {
            let oc: Vec<char> = o.chars().collect();
            addr.starts_with(&oc) && matches_from(&toks[1..], &addr[oc.len()..])
        }),
        Some(Tok::Any) => (0..=addr.len())
            .take_while(|&k| k == 0 || addr[k - 1] != '/')
            .any(|k| matches_from(&toks[1..], &addr[k..])),
    }
}

pub struct TriggerPatterns {
    compiled: Vec<Vec<Tok>>,
}

impl TriggerPatterns {
    /// Compile patterns. Invalid patterns are skipped with a warning —
    /// a typo in one trigger must not unload the session.
    pub fn compile(patterns: &[String]) -> Self {
        let compiled = patterns
            .iter()
            .filter_map(|p| match compile_one(p) {
                Ok(toks) => Some(toks),
                Err(e) => {
                    eprintln!("vtr-player: warn: bad trigger pattern {p:?} skipped: {e}");
                    None
                }
            })
            .collect();
        Self { compiled }
    }

    pub fn matches(&self, addr: &str) -> bool {
        let addr: Vec<char> = addr.chars().collect();
        self.compiled.iter().any(|toks| matches_from(toks, &addr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(patterns: &[&str]) -> TriggerPatterns {
        TriggerPatterns::compile(&patterns.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn literal_and_star() {
        let p = compile(&["/kick", "/note/*"]);
        assert!(p.matches("/kick"));
        assert!(!p.matches("/kick2"));
        assert!(p.matches("/note/60"));
        assert!(!p.matches("/note/60/vel"), "* must not cross a /");
        assert!(!p.matches("/fader"));
    }

    #[test]
    fn star_within_a_part() {
        let p = compile(&["/kick*"]);
        assert!(p.matches("/kick"), "* matches zero characters");
        assert!(p.matches("/kick2"));
        assert!(!p.matches("/kick/sub"));
    }

    #[test]
    fn star_in_the_middle() {
        let p = compile(&["/ch*/vol"]);
        assert!(p.matches("/ch1/vol"));
        assert!(p.matches("/ch/vol"));
        assert!(!p.matches("/ch1/sub/vol"));
    }

    #[test]
    fn question_brackets_braces() {
        let p = compile(&["/pad?", "/ch[1-4]", "/{snare,hat}"]);
        assert!(p.matches("/pad1"));
        assert!(!p.matches("/pad12"));
        assert!(p.matches("/ch3"));
        assert!(!p.matches("/ch5"));
        assert!(p.matches("/snare"));
        assert!(p.matches("/hat"));
        assert!(!p.matches("/tom"));
    }

    #[test]
    fn negated_class() {
        let p = compile(&["/ch[!0-9]"]);
        assert!(p.matches("/chX"));
        assert!(!p.matches("/ch5"));
        assert!(!p.matches("/ch/"), "class never matches /");
    }

    #[test]
    fn bad_pattern_is_skipped_not_fatal() {
        let p = compile(&["/bad[", "/ok"]);
        assert!(p.matches("/ok"));
        assert!(!p.matches("/other"));
    }

    #[test]
    fn empty_patterns_match_nothing() {
        let p = compile(&[]);
        assert!(!p.matches("/anything"));
    }
}
