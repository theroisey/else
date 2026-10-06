//! One local, disposable Redis child owned and reaped by the serving process.
use crate::startup::Failure;
use async_trait::async_trait;
use pingora_core::{server::ShutdownWatch, services::background::BackgroundService};
use std::{
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    os::unix::process::ExitStatusExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Notify,
};

pub const PORT: u16 = 6379;
pub const ENDPOINT: &str = "redis://127.0.0.1:6379/0";
const PING: &[u8] = b"*1\r\n$4\r\nPING\r\n";

pub struct EmbeddedRedis {
    child: Mutex<Option<Child>>,
    address: SocketAddr,
    alive: AtomicBool,
    failed: AtomicBool,
    failure: Notify,
}
impl EmbeddedRedis {
    pub fn start() -> Result<Arc<Self>, Failure> {
        Self::start_port(PORT)
    }

    pub(crate) fn start_port(port: u16) -> Result<Arc<Self>, Failure> {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        // Never adopt another process already listening on the private endpoint.
        let reservation = std::net::TcpListener::bind(address).map_err(|e| {
            Failure::io(
                "embedded_redis",
                "embedded_redis_port_unavailable",
                "reserve_loopback_port",
                e,
            )
        })?;
        let packaged = PathBuf::from("/redis-server");
        let mut command = if packaged.is_file() {
            Command::new(packaged)
        } else {
            let mut build = std::env::current_dir()
                .map_err(|e| {
                    Failure::io(
                        "embedded_redis",
                        "embedded_redis_start_failed",
                        "locate_artifacts",
                        e,
                    )
                })?
                .join("build");
            if !build.join("redis-server").is_file()
                && let Some(parent) = build.parent().and_then(|p| p.parent())
            {
                build = parent.join("build");
            }
            // Native development/CI uses the same checked binary and minimal
            // musl dependencies, without installing a system Redis service.
            let mut command = Command::new(build.join("redis-runtime/lib/ld-musl-x86_64.so.1"));
            command
                .arg("--library-path")
                .arg(format!(
                    "{}:{}",
                    build.join("redis-runtime/lib").display(),
                    build.join("redis-runtime/usr/lib").display()
                ))
                .arg(build.join("redis-server"));
            command
        };
        command
            .args([
                "--bind",
                "127.0.0.1",
                "--protected-mode",
                "yes",
                "--port",
                &port.to_string(),
                "--save",
                "",
                "--appendonly",
                "no",
                "--maxmemory",
                "64mb",
                "--maxmemory-policy",
                "allkeys-lru",
                "--daemonize",
                "no",
                "--pidfile",
                "",
                "--logfile",
                "",
                "--loglevel",
                "warning",
                "--dir",
                "/tmp",
                "--enable-debug-command",
                "no",
                "--enable-module-command",
                "no",
            ])
            .env_clear()
            .env("TZ", "UTC")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        tracing::info!("embedded_redis_starting");
        drop(reservation);
        let child = command.spawn().map_err(|e| {
            Failure::io(
                "embedded_redis",
                "embedded_redis_start_failed",
                "spawn_child",
                e,
            )
        })?;
        let owned = Arc::new(Self {
            child: Mutex::new(Some(child)),
            address,
            alive: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            failure: Notify::new(),
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if owned.poll_exit() {
                return Err(Failure::new(
                    "embedded_redis",
                    "embedded_redis_start_failed",
                ));
            }
            if ping(address) {
                owned.alive.store(true, Ordering::Release);
                tracing::info!("embedded_redis_ready");
                return Ok(owned);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(Failure::new("embedded_redis", "embedded_redis_not_ready"))
    }

    pub async fn ready(&self) -> bool {
        if !self.alive.load(Ordering::Acquire) {
            return false;
        }
        tokio::time::timeout(Duration::from_millis(150), async {
            let mut socket = tokio::net::TcpStream::connect(self.address).await.ok()?;
            socket.write_all(PING).await.ok()?;
            let mut reply = [0u8; 7];
            socket.read_exact(&mut reply).await.ok()?;
            (reply == *b"+PONG\r\n").then_some(())
        })
        .await
        .ok()
        .flatten()
        .is_some()
    }
    fn poll_exit(&self) -> bool {
        let Ok(mut child) = self.child.lock() else {
            self.fail();
            return true;
        };
        let Some(process) = child.as_mut() else {
            return self.failed.load(Ordering::Acquire);
        };
        match process.try_wait() {
            Ok(Some(status)) => {
                tracing::error!(
                    exit_code = status.code(),
                    signal = status.signal(),
                    "embedded_redis_exited"
                );
                *child = None; // try_wait has reaped this owned child.
                self.fail();
                true
            }
            Ok(None) => false,
            Err(_) => {
                tracing::error!("embedded_redis_wait_failed");
                self.fail();
                true
            }
        }
    }
    fn fail(&self) {
        self.alive.store(false, Ordering::Release);
        self.failed.store(true, Ordering::Release);
        self.failure.notify_one();
    }
    pub async fn failed(&self) {
        if !self.failed.load(Ordering::Acquire) {
            self.failure.notified().await;
        }
    }
    pub fn has_failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    pub fn stop(&self) {
        self.alive.store(false, Ordering::Release);
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        let Some(mut child) = child.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    tracing::info!("embedded_redis_stopped");
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        tracing::info!("embedded_redis_stopped");
    }
}
impl Drop for EmbeddedRedis {
    fn drop(&mut self) {
        self.stop();
    }
}

fn ping(address: SocketAddr) -> bool {
    let Ok(mut socket) = TcpStream::connect_timeout(&address, Duration::from_millis(100)) else {
        return false;
    };
    let _ = socket.set_read_timeout(Some(Duration::from_millis(100)));
    let _ = socket.set_write_timeout(Some(Duration::from_millis(100)));
    let mut reply = [0u8; 7];
    socket.write_all(PING).is_ok()
        && socket.read_exact(&mut reply).is_ok()
        && reply == *b"+PONG\r\n"
}

pub struct Monitor {
    pub redis: Arc<EmbeddedRedis>,
    pub listen: SocketAddr,
}
#[async_trait]
impl BackgroundService for Monitor {
    async fn start(&self, mut shutdown: ShutdownWatch) {
        let mut listen = self.listen;
        if listen.ip().is_unspecified() {
            listen.set_ip(if listen.is_ipv6() {
                std::net::Ipv6Addr::LOCALHOST.into()
            } else {
                Ipv4Addr::LOCALHOST.into()
            });
        }
        let mut announced = false;
        loop {
            if *shutdown.borrow() || self.redis.poll_exit() {
                break;
            }
            if !announced
                && tokio::time::timeout(
                    Duration::from_millis(100),
                    tokio::net::TcpStream::connect(listen),
                )
                .await
                .is_ok_and(|r| r.is_ok())
            {
                tracing::info!(listen_address = %self.listen, "server_listening");
                announced = true;
            }
            tokio::select! { _ = shutdown.changed() => break, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn owned_child_is_ready_private_transient_reaped_and_failure_is_signaled() {
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(
            EmbeddedRedis::start_port(port).err().unwrap().code,
            "embedded_redis_port_unavailable"
        );
        drop(listener);
        let child = EmbeddedRedis::start_port(port).unwrap();
        assert!(child.ready().await);
        let pid = child.child.lock().unwrap().as_ref().unwrap().id();
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while !child.poll_exit() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(child.has_failed());
        assert!(!child.ready().await);
        child.failed().await;
        assert_eq!(
            unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
        let replacement = EmbeddedRedis::start_port(port).unwrap();
        assert!(replacement.ready().await);
        replacement.stop();
        assert!(!replacement.ready().await);
    }
}
