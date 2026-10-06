//! Disposable synthetic fixtures; never compiled into the application.
use crate::{
    audit,
    auth::{Auth, Login},
    clients,
    db::Database,
    security::Actor,
    validation,
};

pub struct Fixture {
    pub directory: tempfile::TempDir,
    pub db: Database,
    pub auth: Auth,
    pub actor: Actor,
    pub client: String,
}

impl Fixture {
    pub async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(&directory.path().join("else.sqlite3"), true).unwrap();
        let auth = Auth::new(db.clone()).unwrap();
        auth.bootstrap(
            "admin@example.com".into(),
            "Synthetic administrator".into(),
            "synthetic-password".into(),
        )
        .await
        .unwrap();
        let actor = auth
            .login(
                Login {
                    email: "admin@example.com".into(),
                    password: "synthetic-password".into(),
                },
                audit::request_id(),
            )
            .await
            .unwrap()
            .session
            .actor;
        let client = clients::create(
            &db,
            actor.clone(),
            validation::json(br#"{"name":"Synthetic client"}"#).unwrap(),
        )
        .await
        .unwrap()
        .id;
        Self {
            directory,
            db,
            auth,
            actor,
            client,
        }
    }
    pub fn connection(&self) -> rusqlite::Connection {
        crate::db::connection(&self.directory.path().join("else.sqlite3")).unwrap()
    }
}
