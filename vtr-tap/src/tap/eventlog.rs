use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Recording transitions, in order. Local (control socket) and remote (OSC)
/// start/stops emit the same events.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum Event {
    RecStarted {
        clip: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        tl: Option<f64>,
    },
    RecStopped {
        clip: PathBuf,
    },
}

/// Rec transitions are rare; 64 outlives any realistic wait gap.
pub(super) const EVENT_LOG_CAP: usize = 64;

/// OSC monitor lines burst at packet rate; sized for the editor's ~50ms
/// drain cadence with a wide margin.
pub(super) const MONITOR_LOG_CAP: usize = 8192;

struct LogState<T> {
    /// seq of the next event to be pushed; starts at 1, only grows.
    next_seq: u64,
    events: VecDeque<(u64, T)>,
    /// Last wait_since entry; producers gate work on it (see polled_within).
    last_wait: Option<Instant>,
}

/// Ring buffer of `(seq, T)` shared between the writer thread (push)
/// and control-socket wait threads (wait_since).
pub struct EventLog<T = Event> {
    inner: Arc<(Mutex<LogState<T>>, Condvar)>,
    cap: usize,
}

impl<T> Clone for EventLog<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            cap: self.cap,
        }
    }
}

pub struct WaitResult<T = Event> {
    /// Newest seq the caller should wait from next.
    pub seq: u64,
    pub events: Vec<T>,
    /// The caller's cursor is unusable (overflowed past or from another
    /// process); it must re-baseline from a status snapshot.
    pub reset: bool,
}

impl<T: Clone> EventLog<T> {
    pub(super) fn new(cap: usize) -> Self {
        Self {
            inner: Arc::new((
                Mutex::new(LogState {
                    next_seq: 1,
                    events: VecDeque::new(),
                    last_wait: None,
                }),
                Condvar::new(),
            )),
            cap,
        }
    }

    pub(super) fn push(&self, event: T) {
        let (lock, cvar) = &*self.inner;
        let mut st = lock.lock().unwrap();
        let seq = st.next_seq;
        st.next_seq += 1;
        st.events.push_back((seq, event));
        while st.events.len() > self.cap {
            st.events.pop_front();
        }
        cvar.notify_all();
    }

    /// A wait_since entered within `d`. The writer skips monitor work when no
    /// consumer polls, so an idle tap never pays for decoding.
    pub(super) fn polled_within(&self, d: Duration) -> bool {
        self.inner
            .0
            .lock()
            .unwrap()
            .last_wait
            .is_some_and(|at| at.elapsed() <= d)
    }

    /// Newest seq (0 when nothing was ever pushed).
    pub fn newest(&self) -> u64 {
        self.inner.0.lock().unwrap().next_seq - 1
    }

    /// Block until an event with seq > n exists, then return everything
    /// after n. Timeout returns empty events with the cursor unchanged.
    /// With buffered seqs oldest..=newest, serving needs n >= oldest-1;
    /// n < oldest-1 (overflow) or n > newest (other process) is a reset.
    pub fn wait_since(&self, n: u64, timeout: Duration) -> WaitResult<T> {
        let (lock, cvar) = &*self.inner;
        let deadline = Instant::now() + timeout;
        let mut st = lock.lock().unwrap();
        st.last_wait = Some(Instant::now());
        loop {
            let newest = st.next_seq - 1;
            let lost = st.events.front().is_some_and(|&(oldest, _)| n + 1 < oldest);
            if n > newest || lost {
                return WaitResult {
                    seq: newest,
                    events: Vec::new(),
                    reset: true,
                };
            }
            if newest > n {
                return WaitResult {
                    seq: newest,
                    events: st
                        .events
                        .iter()
                        .filter(|(s, _)| *s > n)
                        .map(|(_, e)| e.clone())
                        .collect(),
                    reset: false,
                };
            }
            let now = Instant::now();
            if now >= deadline {
                return WaitResult {
                    seq: n,
                    events: Vec::new(),
                    reset: false,
                };
            }
            st = cvar.wait_timeout(st, deadline - now).unwrap().0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn event_log_serves_after_cursor() {
        let log = EventLog::new(EVENT_LOG_CAP);
        for i in 0..3 {
            log.push(Event::RecStopped {
                clip: PathBuf::from(format!("{i}.jsonl")),
            });
        }
        let r = log.wait_since(0, Duration::ZERO);
        assert!(!r.reset);
        assert_eq!(r.seq, 3);
        assert_eq!(r.events.len(), 3);

        let r = log.wait_since(2, Duration::ZERO);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.seq, 3);
    }

    #[test]
    fn event_log_timeout_keeps_cursor() {
        let log = EventLog::new(EVENT_LOG_CAP);
        log.push(Event::RecStopped { clip: "a".into() });
        let r = log.wait_since(1, Duration::from_millis(5));
        assert!(!r.reset);
        assert_eq!(r.seq, 1);
        assert!(r.events.is_empty());
    }

    #[test]
    fn event_log_overflow_resets() {
        let log = EventLog::new(EVENT_LOG_CAP);
        for _ in 0..(EVENT_LOG_CAP as u64 + 5) {
            log.push(Event::RecStopped { clip: "a".into() });
        }
        // Cursor 0 predates the buffer: events were lost.
        let r = log.wait_since(0, Duration::ZERO);
        assert!(r.reset);
        assert_eq!(r.seq, EVENT_LOG_CAP as u64 + 5);
        assert!(r.events.is_empty());
        // Oldest still-served cursor.
        let r = log.wait_since(5, Duration::ZERO);
        assert!(!r.reset);
        assert_eq!(r.events.len(), EVENT_LOG_CAP);
    }

    #[test]
    fn event_log_cursor_ahead_resets() {
        // A cursor from a previous process: newest here is 0.
        let log: EventLog = EventLog::new(EVENT_LOG_CAP);
        let r = log.wait_since(7, Duration::ZERO);
        assert!(r.reset);
        assert_eq!(r.seq, 0);
    }

    #[test]
    fn event_log_push_wakes_blocked_wait() {
        let log = EventLog::new(EVENT_LOG_CAP);
        let waiter = {
            let log = log.clone();
            std::thread::spawn(move || log.wait_since(0, Duration::from_secs(5)))
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
        log.push(Event::RecStarted {
            clip: "a".into(),
            tl: Some(1.5),
        });
        let r = waiter.join().unwrap();
        assert!(!r.reset);
        assert_eq!(r.seq, 1);
        assert_eq!(r.events.len(), 1);
    }

    #[test]
    fn event_serialization_shape() {
        let started = serde_json::to_value(Event::RecStarted {
            clip: "a.jsonl".into(),
            tl: Some(42.0),
        })
        .unwrap();
        assert_eq!(
            started,
            json!({"ev": "rec_started", "clip": "a.jsonl", "tl": 42.0})
        );
        let no_tl = serde_json::to_value(Event::RecStarted {
            clip: "a.jsonl".into(),
            tl: None,
        })
        .unwrap();
        assert_eq!(no_tl, json!({"ev": "rec_started", "clip": "a.jsonl"}));
        let stopped = serde_json::to_value(Event::RecStopped {
            clip: "a.jsonl".into(),
        })
        .unwrap();
        assert_eq!(stopped, json!({"ev": "rec_stopped", "clip": "a.jsonl"}));
    }
}
