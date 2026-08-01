//! Which definition wins at a playhead position.
//!
//! The rule, shared by event-vs-curve resolution (`resolver::resolve_at`)
//! and same-arg curve stacking (`session::curve_group_args`): among the
//! candidates that have started, the latest definition time wins; if none
//! has started, clamp to the earliest one (values extend flat before the
//! first data point). Every tie goes to the later candidate — the caller
//! orders candidates so "later" means the newer edit layer/line.

/// One candidate: `def` is its definition time at the playhead once it has
/// started (`None` before that), `start` its earliest definition time.
pub type Candidate = (Option<f64>, f64);

/// Returns `(index, started)` of the winner, `None` for no candidates.
pub fn pick_latest_or_earliest(cands: &[Candidate]) -> Option<(usize, bool)> {
    let mut win = None;
    let mut best = f64::NEG_INFINITY;
    for (i, &(def, _)) in cands.iter().enumerate() {
        if let Some(def) = def
            && def >= best
        {
            best = def;
            win = Some((i, true));
        }
    }
    if win.is_some() {
        return win;
    }
    let mut best = f64::INFINITY;
    for (i, &(_, start)) in cands.iter().enumerate() {
        if start <= best {
            best = start;
            win = Some((i, false));
        }
    }
    win
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_started_definition_wins() {
        let picked = pick_latest_or_earliest(&[(Some(1.0), 1.0), (Some(3.0), 0.0)]);
        assert_eq!(picked, Some((1, true)));
    }

    #[test]
    fn started_beats_not_started() {
        let picked = pick_latest_or_earliest(&[(None, 0.5), (Some(1.0), 1.0)]);
        assert_eq!(picked, Some((1, true)));
    }

    #[test]
    fn started_tie_goes_to_the_later_candidate() {
        let picked = pick_latest_or_earliest(&[(Some(2.0), 0.0), (Some(2.0), 1.0)]);
        assert_eq!(picked, Some((1, true)));
    }

    #[test]
    fn none_started_clamps_to_the_earliest() {
        let picked = pick_latest_or_earliest(&[(None, 5.0), (None, 3.0)]);
        assert_eq!(picked, Some((1, false)));
    }

    #[test]
    fn earliest_tie_goes_to_the_later_candidate() {
        let picked = pick_latest_or_earliest(&[(None, 3.0), (None, 3.0)]);
        assert_eq!(picked, Some((1, false)));
    }

    #[test]
    fn empty_is_none() {
        assert_eq!(pick_latest_or_earliest(&[]), None);
    }
}
