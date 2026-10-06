//! Local, bounded cache of immutable report bytes. SQLite selects the current
//! revision, digest and authority; neither permissions nor job state enter Redis.
use crate::error::{Error, Result};
use redis::{AsyncConnectionConfig, Client, aio::MultiplexedConnection};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};

pub const MAX_REPORT: usize = 2_097_152;
#[derive(Clone, Default)]
pub struct ReportCache(Option<Arc<Inner>>);
struct Inner {
    client: Client,
    connection: Mutex<Option<MultiplexedConnection>>,
    slots: Semaphore,
    origin: Instant,
    retry_at: AtomicU64,
}
impl ReportCache {
    pub fn new() -> Result<Self> {
        Self::connect(crate::embedded_redis::ENDPOINT)
    }
    pub(crate) fn connect(url: &str) -> Result<Self> {
        let client =
            Client::open(url).map_err(|_| Error::Invalid("invalid_cache_configuration"))?;
        Ok(Self(Some(Arc::new(Inner {
            client,
            connection: Mutex::new(None),
            slots: Semaphore::new(4),
            origin: Instant::now(),
            retry_at: AtomicU64::new(0),
        }))))
    }
    pub async fn get(&self, key: &str) -> Option<Vec<u8>> {
        // GETRANGE bounds responses even if an accidentally oversized cache value
        // is present. The extra byte lets the reader reject truncation explicitly.
        let mut command = redis::cmd("GETRANGE");
        command.arg(key).arg(0).arg(MAX_REPORT);
        let raw: Vec<u8> = self.command(command).await?;
        (!raw.is_empty() && raw.len() <= MAX_REPORT).then_some(raw)
    }
    pub async fn put(&self, key: &str, raw: &[u8]) {
        if raw.is_empty() || raw.len() > MAX_REPORT {
            return;
        }
        let mut command = redis::cmd("SETEX");
        command.arg(key).arg(300).arg(raw);
        let _: Option<String> = self.command(command).await;
    }
    async fn command<T: redis::FromRedisValue>(&self, command: redis::Cmd) -> Option<T> {
        let inner = self.0.as_ref()?;
        let now = inner.origin.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        if now < inner.retry_at.load(Ordering::Relaxed) {
            return None;
        }
        let _permit = inner.slots.try_acquire().ok()?;
        let result = tokio::time::timeout(Duration::from_millis(80), async {
            let mut connection = {
                // Never queue dashboard requests behind connection establishment.
                let mut guard = inner.connection.try_lock().map_err(|_| ())?;
                if guard.is_none() {
                    let config = AsyncConnectionConfig::new()
                        .set_connection_timeout(Some(Duration::from_millis(60)))
                        .set_response_timeout(Some(Duration::from_millis(60)))
                        .set_pipeline_buffer_size(4)
                        .set_concurrency_limit(4);
                    let connection = inner
                        .client
                        .get_multiplexed_async_connection_with_config(&config)
                        .await
                        .map_err(|_| ())?;
                    *guard = Some(connection);
                    tracing::info!("report_cache_connected");
                }
                guard.as_ref().ok_or(())?.clone()
            };
            command
                .query_async::<T>(&mut connection)
                .await
                .map_err(|_| ())
        })
        .await;
        match result {
            Ok(Ok(value)) => Some(value),
            _ => {
                let previous = inner
                    .retry_at
                    .swap(now.saturating_add(5000), Ordering::Relaxed);
                if previous <= now {
                    tracing::warn!("report_cache_unavailable_using_database");
                }
                if let Ok(mut connection) = inner.connection.try_lock() {
                    *connection = None;
                }
                None
            }
        }
    }
}
