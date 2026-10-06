//! Bounded trusted-operator rewrapping and observation. Excluded rows and backup
//! key dependencies remain an operator responsibility; no retirement approval.
use crate::{
    credentials::Keyring,
    db::Database,
    error::{Error, Result},
    security::{self, Actor},
    validation,
    vault::{self, Checkpoint, Scope, Vault},
};
use rusqlite::params;
use serde::Serialize;
use std::time::Duration;
use tokio::time::{Instant, timeout_at};
#[derive(Serialize)]
pub struct Count {
    position: usize,
    active: bool,
    stored_rows: String,
    eligible_rows: String,
    excluded_rows: String,
}
pub async fn inventory(db: &Database, actor: Actor, ring: Keyring) -> Result<Vec<Count>> {
    db.read(move |tx|{
        require_global(tx,&actor,"clients.view")?;require_global(tx,&actor,"integrations.manage")?;
        ring.preflight(tx,false,false)?;let active=ring.active().0;
        let mut counts=Vec::new();
        for (index,(label,digest)) in ring.identities().into_iter().enumerate() {
            let total:i64=tx.query_row("SELECT count(*) FROM integration_credentials s JOIN integration_encryption_keys k ON k.id=s.key_id WHERE k.key_label=?1 AND k.fingerprint=?2",params![label,digest.as_slice()],|r|r.get(0))?;
            let eligible:i64=if label==active {0}else{tx.query_row("SELECT count(*) FROM integration_credentials s JOIN integration_encryption_keys k ON k.id=s.key_id JOIN integration_connections c ON c.id=s.connection_id JOIN clients a ON a.id=c.client_id WHERE k.key_label=?1 AND k.fingerprint=?2 AND s.generation=c.generation AND a.archived_at IS NULL AND c.state IN ('pending','connected','reauthorization_required')",params![label,digest.as_slice()],|r|r.get(0))?};
            counts.push(Count{position:index+1,active:label==active,stored_rows:total.to_string(),eligible_rows:eligible.to_string(),excluded_rows:(total-eligible).to_string()});
        }Ok(counts)
    }).await
}
fn require_global(tx: &rusqlite::Transaction<'_>, actor: &Actor, key: &str) -> Result<()> {
    security::fresh(tx, actor)?;
    let allowed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=?1 AND ur.scope_kind='global' AND ur.revoked_at IS NULL AND rp.permission_key=?2 AND rp.revoked_at IS NULL)",params![actor.user_id,key],|r|r.get(0))?;
    if allowed { Ok(()) } else { Err(Error::Denied) }
}
#[derive(Serialize)]
pub struct Progress {
    rewrapped: usize,
    resume_after: Option<String>,
    pending: Option<String>,
    page_complete: bool,
    more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}
pub async fn rotate(
    db: &Database,
    actor: Actor,
    ring: Keyring,
    client: String,
    after: Option<String>,
    limit: usize,
) -> Result<Progress> {
    validation::id(&client)?;
    if let Some(id) = &after {
        validation::id(id)?;
    }
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid("invalid_request"));
    }
    let who = actor.clone();
    let target = client.clone();
    let keyring = ring.clone();
    let cursor = after.clone();
    let items=db.read(move |tx| {
        security::require(tx,&who,"clients.view",Some(&target))?;security::require(tx,&who,"integrations.manage",Some(&target))?;security::client(tx,&target,true)?;
        keyring.preflight(tx,false,true)?;let (label,digest)=keyring.active();
        let mut stmt=tx.prepare("SELECT c.id,c.revision,c.generation,s.revision,c.provider FROM integration_connections c JOIN integration_credentials s ON s.connection_id=c.id JOIN integration_encryption_keys k ON k.id=s.key_id WHERE c.client_id=?1 AND (?2 IS NULL OR c.id>?2) AND c.state IN ('pending','connected','reauthorization_required') AND s.generation=c.generation AND (k.key_label<>?3 OR k.fingerprint<>?4) ORDER BY c.id LIMIT ?5")?;
        Ok(stmt.query_map(params![target,cursor,label,digest.as_slice(),(limit+1)as i64],|r|Ok((r.get::<_,String>(0)?,Checkpoint{connection_revision:r.get(1)?,generation:r.get(2)?,credential_revision:r.get(3)?,provider:r.get(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await?;
    let mut progress = Progress {
        rewrapped: 0,
        resume_after: after,
        pending: None,
        page_complete: false,
        more: items.len() > limit,
        error_code: None,
    };
    let vault = Vault::new(db.clone(), ring);
    let deadline = Instant::now() + Duration::from_secs(30);
    for (connection, checkpoint) in items.into_iter().take(limit) {
        progress.pending = Some(connection.clone());
        let result = timeout_at(deadline, async {
            let prepared = vault
                .prepare(
                    actor.clone(),
                    Scope {
                        client: client.clone(),
                        connection: connection.clone(),
                        website: None,
                    },
                    checkpoint,
                    vault::Operation::Rewrap,
                )
                .await?;
            vault.persist(actor.clone(), prepared).await?;
            Ok::<_, Error>(())
        })
        .await;
        match result {
            Ok(Ok(())) => {
                progress.rewrapped += 1;
                progress.resume_after = Some(connection);
                progress.pending = None;
            }
            failure => {
                progress.error_code = Some(match failure {
                    Ok(Err(error)) => error.code(),
                    _ => "service_unavailable",
                });
                return Ok(progress);
            }
        }
    }
    progress.page_complete = true;
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{integrations, testing::Fixture};
    use base64::{Engine, engine::general_purpose::STANDARD};
    #[tokio::test]
    async fn bounded_rotation_reports_only_committed_progress_and_inventory_retains_exclusions() {
        let f = Fixture::new().await;
        let actor = Actor::operator(f.actor.user_id.clone()).unwrap();
        let old=Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"key-old","keys":[{"id":"key-old","key_base64":STANDARD.encode([0x6b;32])}]})).unwrap()).unwrap();
        let vault = Vault::new(f.db.clone(), old.clone());
        let mut scopes = Vec::new();
        for id in ["9001", "9002", "9003"] {
            let connection = integrations::create(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                "meta_ads".into(),
                id.into(),
            )
            .await
            .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let scope = Scope {
                client: f.client.clone(),
                connection,
                website: None,
            };
            let checkpoint = vault.inspect(actor.clone(), scope.clone()).await.unwrap();
            let prepared = vault
                .prepare(
                    actor.clone(),
                    scope.clone(),
                    checkpoint,
                    vault::Operation::Replace(zeroize::Zeroizing::new(
                        b"synthetic-private-retained-token".to_vec(),
                    )),
                )
                .await
                .unwrap();
            vault.persist(actor.clone(), prepared).await.unwrap();
            scopes.push(scope);
        }
        let disabled = scopes.pop().unwrap();
        integrations::disconnect(
            &f.db,
            f.actor.clone(),
            disabled,
            serde_json::from_value(serde_json::json!({"revision":"2","confirmed":true})).unwrap(),
        )
        .await
        .unwrap();
        let new=Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"key-new","keys":[{"id":"key-old","key_base64":STANDARD.encode([0x6b;32])},{"id":"key-new","key_base64":STANDARD.encode([0x73;32])}]})).unwrap()).unwrap();
        let before = inventory(&f.db, actor.clone(), new.clone()).await.unwrap();
        let retained = before.iter().find(|k| !k.active).unwrap();
        assert_eq!(
            (
                &*retained.stored_rows,
                &*retained.eligible_rows,
                &*retained.excluded_rows
            ),
            ("3", "2", "1")
        );
        let serialized = serde_json::to_string(&before).unwrap();
        assert!(
            !serialized.contains("key-old")
                && !serialized.contains("key-new")
                && !serialized.contains("fingerprint")
                && !serialized.contains("reservations")
        );
        f.connection().execute_batch("CREATE TRIGGER synthetic_rewrap_failure BEFORE INSERT ON audit_events WHEN NEW.resource_kind='integration_credential' BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        let failure = rotate(&f.db, actor.clone(), new.clone(), f.client.clone(), None, 1)
            .await
            .unwrap();
        assert_eq!(failure.rewrapped, 0);
        assert!(
            !failure.page_complete && failure.pending.is_some() && failure.error_code.is_some()
        );
        assert!(failure.resume_after.is_none());
        let conn = f.connection();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT reservations FROM integration_encryption_keys WHERE key_label='key-new'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            1
        );
        conn.execute_batch("DROP TRIGGER synthetic_rewrap_failure")
            .unwrap();
        let first = rotate(&f.db, actor.clone(), new.clone(), f.client.clone(), None, 1)
            .await
            .unwrap();
        assert_eq!(first.rewrapped, 1);
        assert!(first.page_complete && first.more && first.pending.is_none());
        let second = rotate(
            &f.db,
            actor.clone(),
            new.clone(),
            f.client.clone(),
            first.resume_after,
            1,
        )
        .await
        .unwrap();
        assert_eq!(second.rewrapped, 1);
        assert!(second.page_complete && !second.more);
        let final_counts = inventory(&f.db, actor.clone(), new.clone()).await.unwrap();
        let retained = final_counts.iter().find(|k| !k.active).unwrap();
        assert_eq!(
            (
                &*retained.stored_rows,
                &*retained.eligible_rows,
                &*retained.excluded_rows
            ),
            ("1", "0", "1")
        );
        let active = final_counts.iter().find(|k| k.active).unwrap();
        assert_eq!(active.stored_rows, "2");
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT reservations FROM integration_encryption_keys WHERE key_label='key-new'",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            3
        );
        new.preflight(&conn, false, true).unwrap();
        for scope in scopes {
            let checkpoint = Vault::new(f.db.clone(), new.clone())
                .inspect(actor.clone(), scope)
                .await
                .unwrap();
            assert_eq!(checkpoint.generation, 2);
            assert_eq!(checkpoint.credential_revision, 2);
        }
        conn.execute(
            "UPDATE user_roles SET scope_kind='client',client_id=?1 WHERE user_id=?2",
            params![f.client, actor.user_id],
        )
        .unwrap();
        assert!(matches!(
            inventory(&f.db, actor.clone(), new.clone()).await,
            Err(Error::Denied)
        ));
        assert!(
            rotate(
                &f.db,
                actor.clone(),
                new.clone(),
                f.client.clone(),
                None,
                100
            )
            .await
            .unwrap()
            .page_complete
        );
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='integrations.manage'",
            [validation::now()],
        )
        .unwrap();
        assert!(matches!(
            rotate(&f.db, actor, new, f.client, None, 1).await,
            Err(Error::Denied)
        ));
    }
}
