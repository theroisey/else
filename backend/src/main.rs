use async_trait::async_trait;
use pingora_core::{
    server::{RunArgs, Server, ShutdownSignal, ShutdownSignalWatch, configuration::ServerConf},
    services::listening::Service,
};
use roisey_else::{
    api::Api, auth::Auth, config::Config, db::Database, embedded_redis::EmbeddedRedis,
    server::Application, startup::Failure, static_files::Assets,
};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

fn main() {
    // Keep dependency diagnostics bounded; never enable Pingora header tracing.
    tracing_subscriber::fmt()
        .json()
        .with_env_filter("roisey_else=info,pingora_core=warn")
        .with_target(false)
        .with_writer(std::io::stderr)
        .init();
    if let Err(error) = run() {
        tracing::error!(
            stage = error.stage,
            error_code = error.code,
            operation = error.operation,
            error_kind = error.error_kind,
            errno = error.errno,
            owner_uid = error.owner_uid,
            runtime_uid = error.runtime_uid,
            directory_mode = error.directory_mode,
            message = if error.stage == "runtime" {
                "application_failed"
            } else {
                "application_startup_failed"
            }
        );
        std::process::exit(1);
    }
}

fn run() -> Result<(), Failure> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).unwrap_or("serve");
    if arguments.len() > 1 {
        return Err(Failure::new("configuration", "invalid_command"));
    }
    if command == "health" {
        return health().map_err(Failure::from);
    }
    if command == "help" {
        println!(
            "Roisey Else: serve | health | migrate | bootstrap | backup | restore | key-inventory | rotate-credentials\nBootstrap and key operations read bounded JSON from stdin. Backup/restore use BACKUP_DIRECTORY."
        );
        return Ok(());
    }
    let config = Config::load().map_err(|code| Failure::new("configuration", code))?;
    if command == "serve" {
        return serve(config);
    }
    if command == "restore" {
        let bundle = std::path::PathBuf::from(
            std::env::var_os("BACKUP_DIRECTORY").ok_or("backup_directory_required")?,
        );
        roisey_else::recovery::restore(&bundle, &config.database, &config.key_file)
            .map_err(|e| e.code())?;
        println!("Backup restored into empty storage with retained and fresh active keys.");
        return Ok(());
    }
    if !matches!(
        command,
        "serve" | "migrate" | "bootstrap" | "backup" | "key-inventory" | "rotate-credentials"
    ) {
        return Err(Failure::new("configuration", "invalid_command"));
    }
    if command == "backup" {
        if config.database.symlink_metadata().is_err() {
            return Err(Failure::from("database_unavailable"));
        }
        let connection = roisey_else::db::connection(&config.database).map_err(|e| e.code())?;
        if config.key_provision {
            roisey_else::credentials::provision(&config.key_file, &connection)
                .map_err(|_| "integration_key_startup_failed")?;
        }
        drop(connection);
        let destination = std::path::PathBuf::from(
            std::env::var_os("BACKUP_DIRECTORY").ok_or("backup_directory_required")?,
        );
        roisey_else::recovery::backup(&config.database, &config.key_file, &destination)
            .map_err(|e| e.code())?;
        println!("Database and retained keys backed up and verified.");
        return Ok(());
    }
    if matches!(command, "key-inventory" | "rotate-credentials")
        && config.database.symlink_metadata().is_err()
    {
        return Err(Failure::from("database_unavailable"));
    }
    let db = Database::open(&config.database, true).map_err(|e| e.code())?;
    if matches!(command, "key-inventory" | "rotate-credentials") {
        return key_operation(command, &config, db).map_err(Failure::from);
    }
    if command == "migrate" {
        println!("Database migrations verified.");
        return Ok(());
    }
    if command == "bootstrap" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            email: String,
            display_name: String,
            password: String,
        }
        let mut data = zeroize::Zeroizing::new(Vec::new());
        std::io::stdin()
            .take(4097)
            .read_to_end(&mut data)
            .map_err(|_| "bootstrap_input_unavailable")?;
        if data.len() > 4096 {
            return Err(Failure::from("invalid_bootstrap_input"));
        }
        let input: Input =
            roisey_else::validation::json(&data).map_err(|_| "invalid_bootstrap_input")?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|_| "runtime_failed")?;
        let auth = Auth::new(db).map_err(|e| e.code())?;
        runtime
            .block_on(auth.bootstrap(input.email, input.display_name, input.password))
            .map_err(|e| e.code())?;
        println!("Initial administrator created.");
        return Ok(());
    }
    Err(Failure::new("configuration", "invalid_command"))
}

fn serve(config: Config) -> Result<(), Failure> {
    tracing::info!("application_starting");
    let directory = config
        .database
        .parent()
        .ok_or_else(|| Failure::new("storage", "data_directory_unavailable"))?;
    roisey_else::startup::directory(directory, "storage", "data_directory_unavailable")?;
    tracing::info!("data_directory_ready");
    roisey_else::startup::directory(
        &directory.join(".control"),
        "control",
        "control_directory_unavailable",
    )?;
    let _runtime_lease = roisey_else::private_files::RuntimeLease::acquire(&config.database)
        .map_err(|e| Failure::domain("runtime_lock", "runtime_lock_failed", e))?;
    // Report a conflicting listener before starting any dependent processes.
    let port = std::net::TcpListener::bind(config.address).map_err(|e| {
        Failure::io(
            "http_listener",
            "http_listener_unavailable",
            "bind_http_listener",
            e,
        )
    })?;
    drop(port);
    let redis = EmbeddedRedis::start()?;
    let db = Database::initialize(&config.database, true)
        .map_err(|e| Failure::domain(e.stage, e.code, e.source))?;
    tracing::info!("database_ready");
    tracing::info!(
        schema_version = roisey_else::db::SCHEMA_VERSION,
        "migrations_ready"
    );
    let auth = Auth::new(db.clone()).map_err(|e| {
        Failure::domain("authentication", "authentication_initialization_failed", e)
    })?;
    let key_connection = roisey_else::db::connection(&config.database)
        .map_err(|e| Failure::domain("keyring", "keyring_initialization_failed", e))?;
    if config.key_provision {
        roisey_else::credentials::provision(&config.key_file, &key_connection)
            .map_err(|e| Failure::domain("keyring", "keyring_initialization_failed", e))?;
    }
    let ring = roisey_else::credentials::Keyring::load(&config.key_file)
        .map_err(|e| Failure::domain("keyring", "keyring_initialization_failed", e))?;
    ring.preflight(&key_connection, config.key_restored, true)
        .map_err(|e| Failure::domain("keyring", "keyring_initialization_failed", e))?;
    drop(key_connection);
    tracing::info!("keyring_ready");
    let vault = roisey_else::vault::Vault::new(db.clone(), ring.clone());
    let synchronization =
        roisey_else::synchronization::Synchronization::new(db.clone(), vault.clone(), ring);
    let worker =
        roisey_else::provider_worker::Worker::new(synchronization.clone()).map_err(|e| {
            Failure::domain("provider_trust", "provider_trust_initialization_failed", e)
        })?;
    let assets = Assets::load(&config.frontend)
        .map_err(|e| Failure::domain("frontend", "frontend_assets_invalid", e))?;
    tracing::info!("frontend_ready");
    let report_cache = roisey_else::cache::ReportCache::new()
        .map_err(|e| Failure::domain("cache", "embedded_cache_initialization_failed", e))?;
    let draining = Arc::new(AtomicBool::new(false));
    let mut listener = Service::new(
        "roisey_else_http".into(),
        Application::new(
            Api {
                config: config.clone(),
                db,
                auth,
                vault,
                synchronization,
                report_cache,
            },
            assets,
            draining.clone(),
            redis.clone(),
        ),
    );
    listener.add_tcp(&config.address.to_string());
    let conf = ServerConf {
        daemon: false,
        threads: 4,
        grace_period_seconds: Some(0),
        graceful_shutdown_timeout_seconds: Some(10),
        ..ServerConf::default()
    };
    let mut server = Server::new_with_opt_and_conf(None, conf);
    server.bootstrap();
    server.add_service(listener);
    server.add_service(pingora_core::services::background::background_service(
        "provider_sync",
        worker,
    ));
    server.add_service(pingora_core::services::background::background_service(
        "embedded_redis",
        roisey_else::embedded_redis::Monitor {
            redis: redis.clone(),
            listen: config.address,
        },
    ));
    server.run(RunArgs {
        shutdown_signal: Box::new(GracefulShutdown {
            draining,
            redis: redis.clone(),
        }),
    });
    redis.stop();
    if redis.has_failed() {
        return Err(Failure::new("runtime", "embedded_redis_exited"));
    }
    tracing::info!("application_stopped");
    Ok(())
}

fn key_operation(command: &str, config: &Config, db: Database) -> Result<(), &'static str> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        actor_id: String,
        client_id: Option<String>,
        after: Option<String>,
        limit: Option<usize>,
        confirmed: Option<bool>,
    }
    let mut raw = zeroize::Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(4097)
        .read_to_end(&mut raw)
        .map_err(|_| "operator_input_unavailable")?;
    if raw.len() > 4096 {
        return Err("invalid_operator_input");
    }
    let input: Input = roisey_else::validation::json(&raw).map_err(|_| "invalid_operator_input")?;
    let actor = roisey_else::security::Actor::operator(input.actor_id).map_err(|e| e.code())?;
    let ring = roisey_else::credentials::Keyring::load(&config.key_file)
        .map_err(|_| "integration_key_startup_failed")?;
    let connection = roisey_else::db::connection(&config.database).map_err(|e| e.code())?;
    ring.preflight(
        &connection,
        config.key_restored,
        command == "rotate-credentials",
    )
    .map_err(|_| "integration_key_startup_failed")?;
    drop(connection);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| "runtime_failed")?;
    if command == "key-inventory" {
        if input.client_id.is_some()
            || input.after.is_some()
            || input.limit.is_some()
            || input.confirmed.is_some()
        {
            return Err("invalid_operator_input");
        }
        let result = runtime
            .block_on(roisey_else::key_operations::inventory(&db, actor, ring))
            .map_err(|e| e.code())?;
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|_| "operator_output_failed")?
        );
    } else {
        if input.confirmed != Some(true) {
            return Err("rotation_confirmation_required");
        }
        let client = input.client_id.ok_or("invalid_operator_input")?;
        let limit = input.limit.ok_or("invalid_operator_input")?;
        let result = runtime
            .block_on(roisey_else::key_operations::rotate(
                &db,
                actor,
                ring,
                client,
                input.after,
                limit,
            ))
            .map_err(|e| e.code())?;
        let value = serde_json::to_value(result).map_err(|_| "operator_output_failed")?;
        println!("{value}");
        if value.get("error_code").is_some() {
            return Err("rotation_requires_reconciliation");
        }
    }
    Ok(())
}
struct GracefulShutdown {
    draining: Arc<AtomicBool>,
    redis: Arc<EmbeddedRedis>,
}

#[async_trait]
impl ShutdownSignalWatch for GracefulShutdown {
    async fn recv(&self) -> ShutdownSignal {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("SIGINT handler");
        tokio::select! {_ = term.recv()=>{},_ = interrupt.recv()=>{}, _ = self.redis.failed()=>{}}
        self.draining.store(true, Ordering::Release);
        ShutdownSignal::GracefulTerminate
    }
}

fn health() -> Result<(), &'static str> {
    let mut address: SocketAddr = std::env::var("HTTP_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()
        .map_err(|_| "invalid_health_address")?;
    if address.ip().is_unspecified() {
        address.set_ip(if address.is_ipv6() {
            std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)
        } else {
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        });
    }
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|_| "not_ready")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "not_ready")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "not_ready")?;
    stream
        .write_all(b"GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .map_err(|_| "not_ready")?;
    let mut reply = [0u8; 64];
    let size = stream.read(&mut reply).map_err(|_| "not_ready")?;
    if size >= 12 && &reply[..12] == b"HTTP/1.1 200" {
        Ok(())
    } else {
        Err("not_ready")
    }
}
