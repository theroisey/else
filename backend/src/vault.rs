//! Audited durable nonce reservations and fresh, fenced credential persistence.
//! A committed reservation survives failed crypto, cancellation and rollback.
use crate::{
    audit::{self, Event, Snapshot},
    credentials::{self, Binding, Envelope, Keyring, MAX_RESERVATIONS},
    db::Database,
    error::{Error, Result},
    security::{self, Actor},
    validation, websites,
};
use rusqlite::{OptionalExtension, Transaction, params};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Scope {
    pub client: String,
    pub connection: String,
    pub website: Option<String>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub connection_revision: i64,
    pub generation: i64,
    pub credential_revision: i64,
    pub provider: String,
}
pub struct Prepared {
    scope: Scope,
    actor: String,
    checkpoint: Checkpoint,
    key_id: String,
    envelope: Envelope,
    rewrap: bool,
}
#[derive(Clone)]
pub struct Vault {
    db: Database,
    ring: Keyring,
}
pub enum Operation {
    Replace(Zeroizing<Vec<u8>>),
    Rewrap,
}

fn authorize(tx: &Transaction<'_>, actor: &Actor, scope: &Scope) -> Result<()> {
    security::fresh(tx, actor)?;
    if !security::allowed_user(tx, &actor.user_id, "clients.view", Some(&scope.client))?
        || !security::allowed_user(
            tx,
            &actor.user_id,
            "integrations.manage",
            Some(&scope.client),
        )?
    {
        return Err(Error::NotFound);
    }
    security::client(tx, &scope.client, false)?;
    let active: bool = tx.query_row(
        "SELECT archived_at IS NULL FROM clients WHERE id=?1",
        [&scope.client],
        |r| r.get(0),
    )?;
    if !active {
        return Err(Error::NotFound);
    }
    if let Some(website) = &scope.website {
        websites::check_binding(tx, actor, &scope.client, website, &scope.connection, true)?;
    }
    Ok(())
}
pub(crate) fn inspect(tx: &Transaction<'_>, actor: &Actor, scope: &Scope) -> Result<Checkpoint> {
    authorize(tx, actor, scope)?;
    Ok(tx.query_row("SELECT c.revision,c.generation,coalesce(s.revision,0),c.provider FROM integration_connections c LEFT JOIN integration_credentials s ON s.connection_id=c.id WHERE c.id=?1 AND c.client_id=?2 AND c.state IN ('pending','connected','reauthorization_required')",params![scope.connection,scope.client],|r|Ok(Checkpoint{connection_revision:r.get(0)?,generation:r.get(1)?,credential_revision:r.get(2)?,provider:r.get(3)?}))?)
}
fn match_checkpoint(
    tx: &Transaction<'_>,
    actor: &Actor,
    scope: &Scope,
    expected: &Checkpoint,
) -> Result<()> {
    if inspect(tx, actor, scope)? != *expected
        || expected.connection_revision == i64::MAX
        || expected.credential_revision == i64::MAX
    {
        return Err(Error::Conflict("conflict"));
    }
    Ok(())
}
impl Vault {
    pub fn new(db: Database, ring: Keyring) -> Self {
        Self { db, ring }
    }
    pub async fn inspect(&self, actor: Actor, scope: Scope) -> Result<Checkpoint> {
        self.db.read(move |tx| inspect(tx, &actor, &scope)).await
    }

    pub async fn prepare(
        &self,
        actor: Actor,
        scope: Scope,
        expected: Checkpoint,
        operation: Operation,
    ) -> Result<Prepared> {
        if matches!(&operation,Operation::Replace(data) if data.is_empty()||data.len()>16_384) {
            return Err(Error::Invalid("invalid_request"));
        }
        let rewrap = matches!(operation, Operation::Rewrap);
        if expected.connection_revision < 1
            || expected.generation < 1
            || expected.credential_revision < 0
            || expected.connection_revision == i64::MAX
            || expected.credential_revision == i64::MAX
            || (!rewrap && expected.generation == i64::MAX)
        {
            return Err(Error::Conflict("conflict"));
        }
        let ring = self.ring.clone();
        let who = actor.clone();
        let target = scope.clone();
        let checkpoint = expected.clone();
        let key_id=self.db.write(move|tx| {
            match_checkpoint(tx,&who,&target,&checkpoint)?;
            ring.preflight(tx,false,true)?;
            let (label,fingerprint)=ring.active();
            let saved:Option<(String,Vec<u8>,i64)>=tx.query_row("SELECT id,fingerprint,reservations FROM integration_encryption_keys WHERE key_label=?1",[label],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
            let id=if let Some((id,digest,used))=saved {
                if digest!=fingerprint||used>=MAX_RESERVATIONS{return Err(Error::Internal);}id
            }else{
                let id=validation::new_id();tx.execute("INSERT INTO integration_encryption_keys VALUES (?1,?2,?3,0,?4)",params![id,label,fingerprint.as_slice(),validation::now()])?;id
            };
            tx.execute("UPDATE integration_encryption_keys SET reservations=reservations+1 WHERE id=?1",[&id])?;
            let reservation=validation::new_id();
            audit::append(tx,Event{actor:Some(&who),request_id:&who.request_id,kind:"integration_encryption",id:&reservation,client:Some(&target.client),action:"created",before:Some(Snapshot{exists:Some(false),..Default::default()}),after:Some(Snapshot{exists:Some(true),..Default::default()}),source:"cli"})?;
            Ok(id)
        }).await?;
        // A separate snapshot rechecks access after the reservation commits.
        // No network request occurs while this transaction is open.
        let ring = self.ring.clone();
        let who = actor.clone();
        let target = scope.clone();
        let checkpoint = expected.clone();
        let envelope=self.db.read(move|tx| {
            match_checkpoint(tx,&who,&target,&checkpoint)?;
            let binding=Binding{client:&target.client,connection:&target.connection,provider:&checkpoint.provider,purpose:credentials::purpose(&checkpoint.provider)?};
            let plaintext=match operation {
                Operation::Replace(data)=>data,
                Operation::Rewrap=> {
                    let (generation,raw):(i64,Vec<u8>)=tx.query_row("SELECT generation,envelope FROM integration_credentials WHERE connection_id=?1",[&target.connection],|r|Ok((r.get(0)?,r.get(1)?)))?;
                    if generation!=checkpoint.generation{return Err(Error::Conflict("conflict"));}
                    ring.open(&binding,&Envelope::parse(raw)?)?
                },
            };
            ring.seal(&binding,&plaintext)
        }).await?;
        Ok(Prepared {
            scope,
            actor: actor.user_id,
            checkpoint: expected,
            key_id,
            envelope,
            rewrap,
        })
    }
    pub async fn persist(&self, actor: Actor, prepared: Prepared) -> Result<Checkpoint> {
        self.db.write(move |tx| store(tx, &actor, &prepared)).await
    }
}

/// Provider setup invokes this within its queue transaction, so credential,
/// connection fencing, cancellation, replacement jobs and audits commit together.
pub fn store(tx: &Transaction<'_>, actor: &Actor, prepared: &Prepared) -> Result<Checkpoint> {
    if actor.user_id != prepared.actor {
        return Err(Error::Denied);
    }
    let scope = &prepared.scope;
    let expected = &prepared.checkpoint;
    match_checkpoint(tx, actor, scope, expected)?;
    let next = Checkpoint {
        connection_revision: expected
            .connection_revision
            .checked_add(1)
            .ok_or(Error::Conflict("conflict"))?,
        generation: expected
            .generation
            .checked_add(i64::from(!prepared.rewrap))
            .ok_or(Error::Conflict("conflict"))?,
        credential_revision: expected
            .credential_revision
            .checked_add(1)
            .ok_or(Error::Conflict("conflict"))?,
        provider: expected.provider.clone(),
    };
    let now = validation::now();
    tx.execute("INSERT INTO integration_credentials(connection_id,purpose,key_id,envelope,revision,generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(connection_id) DO UPDATE SET key_id=excluded.key_id,envelope=excluded.envelope,revision=excluded.revision,generation=excluded.generation,updated_at=excluded.updated_at",params![scope.connection,credentials::purpose(&expected.provider)?,prepared.key_id,prepared.envelope.bytes(),next.credential_revision,next.generation,now])?;
    tx.execute(
        "UPDATE integration_connections SET revision=?1,generation=?2,updated_at=?3 WHERE id=?4",
        params![
            next.connection_revision,
            next.generation,
            now,
            scope.connection
        ],
    )?;
    audit::mutation(
        tx,
        actor,
        "integration_credential",
        &scope.connection,
        Some(&scope.client),
        if expected.credential_revision == 0 {
            "created"
        } else {
            "updated"
        },
        (
            Some(Snapshot {
                exists: Some(expected.credential_revision != 0),
                revision: if expected.credential_revision == 0 {
                    None
                } else {
                    Some(expected.credential_revision)
                },
                ..Default::default()
            }),
            Snapshot::revision(next.credential_revision),
        ),
    )?;
    audit::mutation(
        tx,
        actor,
        "integration_connection",
        &scope.connection,
        Some(&scope.client),
        "updated",
        (
            Some(Snapshot::revision(expected.connection_revision)),
            Snapshot::revision(next.connection_revision),
        ),
    )?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    fn ring() -> Keyring {
        use base64::Engine;
        Keyring::parse(&serde_json::to_vec(&serde_json::json!({"active_key_id":"synthetic-one","keys":[{"id":"synthetic-one","key_base64":base64::engine::general_purpose::STANDARD.encode([0x6b;32])}]})).unwrap()).unwrap()
    }
    async fn fixture() -> (Fixture, Scope, Vault) {
        let f = Fixture::new().await;
        let connection = validation::new_id();
        let now = validation::now();
        f.connection().execute("INSERT INTO integration_connections VALUES (?1,?2,'ga4','123456','pending',1,1,?3,?3)",params![connection,f.client,now]).unwrap();
        let scope = Scope {
            client: f.client.clone(),
            connection,
            website: None,
        };
        let vault = Vault::new(f.db.clone(), ring());
        (f, scope, vault)
    }
    #[tokio::test]
    async fn failed_persistence_burns_capacity_and_revocation_fences_prepared_ciphertext() {
        let (f, scope, vault) = fixture().await;
        let current = vault.inspect(f.actor.clone(), scope.clone()).await.unwrap();
        let prepared = vault
            .prepare(
                f.actor.clone(),
                scope.clone(),
                current.clone(),
                Operation::Replace(Zeroizing::new(b"synthetic-first-credential".to_vec())),
            )
            .await
            .unwrap();
        f.connection().execute_batch("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
        assert!(vault.persist(f.actor.clone(), prepared).await.is_err());
        assert_eq!(
            vault
                .inspect(f.actor.clone(), scope.clone())
                .await
                .unwrap()
                .credential_revision,
            0
        );
        f.connection()
            .execute_batch("DROP TRIGGER synthetic_audit_failure")
            .unwrap();
        let prepared = vault
            .prepare(
                f.actor.clone(),
                scope.clone(),
                current.clone(),
                Operation::Replace(Zeroizing::new(b"synthetic-second-credential".to_vec())),
            )
            .await
            .unwrap();
        f.connection().execute("UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='integrations.manage'",[validation::now()]).unwrap();
        assert!(vault.persist(f.actor.clone(), prepared).await.is_err());
        let conn = f.connection();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT reservations FROM integration_encryption_keys",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM integration_credentials", [], |r| r
                .get(0))
                .unwrap(),
            0
        );
        let audit: String = conn
            .query_row(
                "SELECT group_concat(before_state||after_state||metadata) FROM audit_events",
                [],
                |r| r.get(0),
            )
            .unwrap();
        for private in [
            "synthetic-one",
            "synthetic-first-credential",
            "synthetic-second-credential",
            "fingerprint",
            "reservations",
        ] {
            assert!(!audit.contains(private));
        }
    }
    #[tokio::test]
    async fn replacement_advances_generation_and_retained_key_rotation_preserves_it() {
        let (f, scope, vault) = fixture().await;
        let expected = vault.inspect(f.actor.clone(), scope.clone()).await.unwrap();
        let prepared = vault
            .prepare(
                f.actor.clone(),
                scope.clone(),
                expected,
                Operation::Replace(Zeroizing::new(b"synthetic-credential".to_vec())),
            )
            .await
            .unwrap();
        let next = vault.persist(f.actor.clone(), prepared).await.unwrap();
        assert_eq!(next.generation, 2);
        assert_eq!(next.connection_revision, 2);
        assert_eq!(next.credential_revision, 1);
        let prepared = vault
            .prepare(
                f.actor.clone(),
                scope.clone(),
                next.clone(),
                Operation::Rewrap,
            )
            .await
            .unwrap();
        let rotated = vault.persist(f.actor.clone(), prepared).await.unwrap();
        assert_eq!(rotated.generation, 2);
        assert_eq!(rotated.connection_revision, 3);
        assert_eq!(rotated.credential_revision, 2);
        assert!(
            vault
                .prepare(f.actor.clone(), scope, next, Operation::Rewrap)
                .await
                .is_err()
        );
    }
}
