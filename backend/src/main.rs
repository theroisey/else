use async_trait::async_trait;
use pingora_core::{
    server::{RunArgs, Server, ShutdownSignal, ShutdownSignalWatch, configuration::ServerConf},
    services::listening::Service,
};
use roisey_else::{
    api::Api, auth::Auth, config::Config, db::Database, server::Application, static_files::Assets,
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
    if let Err(code) = run() {
        tracing::error!(error_code = code, "application_failed");
        std::process::exit(1);
    }
}

fn run() -> Result<(), &'static str> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let command = arguments.first().map(String::as_str).unwrap_or("serve");
    if arguments.len() > 1 {
        return Err("invalid_command");
    }
    if command == "health" {
        return health();
    }
    if command == "help" {
        println!(
            "Roisey Else: serve | health | migrate | bootstrap | backup | restore | import-postgres | key-inventory | rotate-credentials\nBootstrap and key operations read bounded JSON from stdin. Backup/restore use BACKUP_DIRECTORY; import uses IMPORT_DIRECTORY."
        );
        return Ok(());
    }
    let config = Config::load()?;
    if command == "import-postgres" {
        let bundle = std::path::PathBuf::from(
            std::env::var_os("IMPORT_DIRECTORY").ok_or("import_directory_required")?,
        );
        let result =
            roisey_else::legacy_import::import(&bundle, &config.database, &config.key_file)
                .map_err(|e| e.code())?;
        println!(
            "{}",
            serde_json::to_string(&result).map_err(|_| "import_summary_failed")?
        );
        return Ok(());
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
        return Err("invalid_command");
    }
    let _runtime_lease = if command == "serve" {
        Some(
            roisey_else::private_files::RuntimeLease::acquire(&config.database)
                .map_err(|e| e.code())?,
        )
    } else {
        None
    };
    if command == "backup" {
        if config.database.symlink_metadata().is_err() {
            return Err("database_unavailable");
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
        return Err("database_unavailable");
    }
    let db = Database::open(&config.database, true).map_err(|e| e.code())?;
    if command == "serve" {
        tracing::info!(schema_version = 1, "database_ready_migrations_verified");
    }
    if matches!(command, "key-inventory" | "rotate-credentials") {
        return key_operation(command, &config, db);
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
            return Err("invalid_bootstrap_input");
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
    if command != "serve" {
        return Err("invalid_command");
    }
    let auth = Auth::new(db.clone()).map_err(|e| e.code())?;
    let key_connection = roisey_else::db::connection(&config.database)
        .map_err(|_| "integration_key_startup_failed")?;
    if config.key_provision {
        roisey_else::credentials::provision(&config.key_file, &key_connection)
            .map_err(|_| "integration_key_startup_failed")?;
    }
    let ring = roisey_else::credentials::Keyring::load(&config.key_file)
        .map_err(|_| "integration_key_startup_failed")?;
    ring.preflight(&key_connection, config.key_restored, true)
        .map_err(|_| "integration_key_startup_failed")?;
    drop(key_connection);
    let vault = roisey_else::vault::Vault::new(db.clone(), ring.clone());
    let synchronization =
        roisey_else::synchronization::Synchronization::new(db.clone(), vault.clone(), ring);
    let worker = roisey_else::provider_worker::Worker::new(synchronization.clone())
        .map_err(|_| "provider_trust_startup_failed")?;
    let assets = Assets::load(&config.frontend).map_err(|_| "frontend_artifact_invalid")?;
    let report_cache = roisey_else::cache::ReportCache::new(config.redis_url.as_deref())
        .map_err(|_| "invalid_cache_configuration")?;
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
    tracing::info!(listen_address = %config.address, cache_configured = config.redis_url.is_some(), "application_starting");
    server.run(RunArgs {
        shutdown_signal: Box::new(GracefulShutdown { draining }),
    });
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
}

#[async_trait]
impl ShutdownSignalWatch for GracefulShutdown {
    async fn recv(&self) -> ShutdownSignal {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("SIGINT handler");
        tokio::select! {_ = term.recv()=>{},_ = interrupt.recv()=>{}}
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
