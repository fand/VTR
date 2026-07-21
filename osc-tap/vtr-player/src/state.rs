//! Shared session slot: the control server swaps it on `load`, the
//! transport and every control connection watch the epoch to reset their
//! resolvers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::pattern::TriggerPatterns;
use crate::session::Session;

pub struct LoadedSession {
    pub path: PathBuf,
    pub session: Arc<Session>,
    pub triggers: TriggerPatterns,
    /// Effective routes: session header routes, overridden at `load`.
    pub routes: HashMap<u16, u16>,
}

#[derive(Default)]
pub struct SharedState {
    /// (epoch, loaded). The epoch increments on every swap; a resolver
    /// built for an older epoch must be rebuilt (full catch-up).
    slot: Mutex<(u64, Option<Arc<LoadedSession>>)>,
}

impl SharedState {
    pub fn snapshot(&self) -> (u64, Option<Arc<LoadedSession>>) {
        let s = self.slot.lock().unwrap();
        (s.0, s.1.clone())
    }

    pub fn swap(&self, loaded: Arc<LoadedSession>) -> u64 {
        let mut s = self.slot.lock().unwrap();
        s.0 += 1;
        s.1 = Some(loaded);
        s.0
    }
}
