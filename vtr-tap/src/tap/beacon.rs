use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Latest `/vtr/clock` beacon.
#[derive(Debug, Clone, Copy)]
pub struct Beacon {
    /// Master timeline seconds.
    pub t: f64,
    /// Timeline speed: 1.0 = playing, 0.0 = paused, negative = reverse.
    pub rate: f64,
    pub at: Instant,
}

impl Beacon {
    /// Extrapolate the timeline position to `now`.
    pub(super) fn tl_at(&self, now: Instant) -> f64 {
        self.t + self.rate * signed_secs_since(now, self.at)
    }
}

pub(super) type BeaconState = Arc<Mutex<Option<Beacon>>>;

pub(super) fn signed_secs_since(t: Instant, since: Instant) -> f64 {
    match t.checked_duration_since(since) {
        Some(d) => d.as_secs_f64(),
        None => -since.duration_since(t).as_secs_f64(),
    }
}
