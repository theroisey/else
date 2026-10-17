//! Bounded process counters. No user IDs, application IDs, arguments, or token labels.
use serde_json::{Value, json};
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
const BUCKETS: [u64; 9] = [
    1_000, 5_000, 10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 5_000_000,
];
#[derive(Default)]
pub struct Counters {
    requests: AtomicU64,
    failures: AtomicU64,
    active: AtomicU64,
    micros: AtomicU64,
    buckets: [AtomicU64; 10],
}
static HTTP: OnceLock<Counters> = OnceLock::new();
static TOOLS: OnceLock<Vec<Counters>> = OnceLock::new();
pub struct Observation {
    counter: &'static Counters,
    start: Instant,
    failed: bool,
}
impl Observation {
    fn new(counter: &'static Counters) -> Self {
        counter.requests.fetch_add(1, Ordering::Relaxed);
        counter.active.fetch_add(1, Ordering::Relaxed);
        Self {
            counter,
            start: Instant::now(),
            failed: true,
        }
    }
    pub fn success(&mut self) {
        self.failed = false;
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        let elapsed = self.start.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
        self.counter.active.fetch_sub(1, Ordering::Relaxed);
        self.counter.micros.fetch_add(elapsed, Ordering::Relaxed);
        let bucket = BUCKETS
            .iter()
            .position(|limit| elapsed <= *limit)
            .unwrap_or(BUCKETS.len());
        self.counter.buckets[bucket].fetch_add(1, Ordering::Relaxed);
        if self.failed {
            self.counter.failures.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub fn http() -> Observation {
    Observation::new(HTTP.get_or_init(Default::default))
}
pub fn tool(name: &str) -> Option<Observation> {
    let index = super::registry::definitions()
        .iter()
        .position(|d| d.name == name)?;
    let all = TOOLS.get_or_init(|| {
        super::registry::definitions()
            .iter()
            .map(|_| Counters::default())
            .collect()
    });
    Some(Observation::new(&all[index]))
}
fn snapshot(c: &Counters) -> Value {
    json!({"requests":c.requests.load(Ordering::Relaxed).to_string(),"failures":c.failures.load(Ordering::Relaxed).to_string(),"active":c.active.load(Ordering::Relaxed).to_string(),"duration_microseconds":c.micros.load(Ordering::Relaxed).to_string(),"duration_buckets":c.buckets.iter().map(|n|n.load(Ordering::Relaxed).to_string()).collect::<Vec<_>>()})
}
pub fn read() -> Value {
    let tools = TOOLS
        .get()
        .map(|c| {
            c.iter()
                .zip(super::registry::definitions())
                .filter(|(c, _)| c.requests.load(Ordering::Relaxed) > 0)
                .map(|(c, d)| json!({"name":d.name,"counts":snapshot(c)}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"http":snapshot(HTTP.get_or_init(Default::default)),"tools":tools,"bucket_upper_microseconds":BUCKETS,"concurrency_limit":12,"response_limit_bytes":super::protocol::MAX_RESPONSE})
}
