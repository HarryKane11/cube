//! Sliding-window counters for failed handshakes and for publishing.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Sweep entries that have gone quiet once the map holds this many keys.
const SWEEP_AT: usize = 4096;

pub struct SlidingWindow<K> {
    max: usize,
    window: Duration,
    hits: HashMap<K, VecDeque<Instant>>,
    /// Map size at which the next sweep runs; doubles while the map stays full
    /// of live keys so sweeping stays cheap per insert.
    sweep_at: usize,
}

impl<K: Hash + Eq + Clone> SlidingWindow<K> {
    pub fn new(max: usize, window: Duration) -> Self {
        SlidingWindow { max, window, hits: HashMap::new(), sweep_at: SWEEP_AT }
    }

    fn live(&mut self, key: &K, now: Instant) -> usize {
        let Some(times) = self.hits.get_mut(key) else {
            return 0;
        };
        while times.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            times.pop_front();
        }
        if times.is_empty() {
            self.hits.remove(key);
            return 0;
        }
        times.len()
    }

    /// True once `max` hits were recorded for `key` within the window.
    pub fn is_blocked(&mut self, key: &K, now: Instant) -> bool {
        self.live(key, now) >= self.max
    }

    /// Records a hit. Only the newest `max` are kept, which is all a decision needs.
    pub fn record(&mut self, key: &K, now: Instant) {
        if self.hits.len() >= self.sweep_at && !self.hits.contains_key(key) {
            self.sweep(now);
            self.sweep_at = SWEEP_AT.max(self.hits.len() * 2);
        }
        let times = self.hits.entry(key.clone()).or_default();
        times.push_back(now);
        while times.len() > self.max {
            times.pop_front();
        }
    }

    /// Records a hit if `key` is under the limit; returns whether it was allowed.
    pub fn try_acquire(&mut self, key: &K, now: Instant) -> bool {
        if self.is_blocked(key, now) {
            return false;
        }
        self.record(key, now);
        true
    }

    fn sweep(&mut self, now: Instant) {
        let window = self.window;
        self.hits
            .retain(|_, times| times.back().is_some_and(|t| now.duration_since(*t) < window));
    }

    #[cfg(test)]
    fn keys(&self) -> usize {
        self.hits.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_at_max_and_recovers() {
        let mut w = SlidingWindow::new(3, Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(!w.is_blocked(&"a", t0));
        for i in 0..3 {
            w.record(&"a", t0 + Duration::from_secs(i));
        }
        assert!(w.is_blocked(&"a", t0 + Duration::from_secs(3)));
        assert!(!w.is_blocked(&"b", t0 + Duration::from_secs(3)));
        // The first hit leaves the window at t0+10.
        assert!(w.is_blocked(&"a", t0 + Duration::from_millis(9_999)));
        assert!(!w.is_blocked(&"a", t0 + Duration::from_secs(10)));
        assert!(w.try_acquire(&"a", t0 + Duration::from_secs(10)));
        assert!(!w.try_acquire(&"a", t0 + Duration::from_secs(10)));
    }

    #[test]
    fn try_acquire_counts_only_allowed_hits() {
        let mut w = SlidingWindow::new(2, Duration::from_secs(10));
        let t0 = Instant::now();
        assert!(w.try_acquire(&1, t0));
        assert!(w.try_acquire(&1, t0));
        for _ in 0..50 {
            assert!(!w.try_acquire(&1, t0 + Duration::from_secs(5)));
        }
        assert!(w.try_acquire(&1, t0 + Duration::from_secs(10)));
    }

    #[test]
    fn quiet_keys_are_swept() {
        let mut w = SlidingWindow::new(2, Duration::from_secs(10));
        let t0 = Instant::now();
        for k in 0..SWEEP_AT {
            w.record(&k, t0);
        }
        assert_eq!(w.keys(), SWEEP_AT);
        w.record(&usize::MAX, t0 + Duration::from_secs(11));
        assert_eq!(w.keys(), 1);
    }
}
