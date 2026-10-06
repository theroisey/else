use crate::{
    audit::{self, Snapshot},
    db::Database,
    error::{Error, Result},
    query::{Mutation, Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{Transaction, params};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contact {
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    phone: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    name: String,
    #[serde(default)]
    legal_name: String,
    #[serde(default)]
    website: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    contacts: Option<Vec<Contact>>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    expected_revision: Option<i64>,
}

impl Profile {
    fn normalize(mut self, updating: bool) -> Result<Self> {
        if self.expected_revision.is_some() != updating {
            return Err(Error::Invalid("invalid_request"));
        }
        self.name = validation::text(&self.name, 200, true, false)?;
        self.legal_name = validation::text(&self.legal_name, 200, false, false)?;
        self.website = validation::text(&self.website, 2048, false, false)?;
        self.notes = validation::text(&self.notes, 4000, false, false)?;
        if !self.website.is_empty() {
            let parsed =
                url::Url::parse(&self.website).map_err(|_| Error::Invalid("invalid_request"))?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.fragment().is_some()
            {
                return Err(Error::Invalid("invalid_request"));
            }
        }
        let contacts = self.contacts.get_or_insert_with(Vec::new);
        if contacts.len() > 20 {
            return Err(Error::Invalid("invalid_request"));
        }
        for contact in contacts {
            contact.name = validation::text(&contact.name, 100, true, false)?;
            contact.phone = validation::text(&contact.phone, 40, false, false)?;
            contact.email = if contact.email.trim().is_empty() {
                String::new()
            } else {
                validation::email(&contact.email)?
            };
        }
        let tags = self.tags.get_or_insert_with(Vec::new);
        if tags.len() > 20 {
            return Err(Error::Invalid("invalid_request"));
        }
        let mut distinct = BTreeSet::new();
        for tag in tags.iter_mut() {
            *tag = validation::text(tag, 40, true, false)?.to_lowercase();
            if !distinct.insert(tag.clone()) {
                return Err(Error::Invalid("invalid_request"));
            }
        }
        Ok(self)
    }
}

const SUMMARY: &str = "c.id,c.name,c.legal_name,CASE WHEN c.archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,c.revision,c.created_at,c.updated_at,c.archived_at,(SELECT coalesce(json_group_array(tag),'[]') FROM (SELECT tag FROM client_tags WHERE client_id=c.id ORDER BY tag)) AS tags_json";
const DETAILS: &str = ",c.website,c.notes,(SELECT coalesce(json_group_array(json_object('name',name,'email',email,'phone',phone)),'[]') FROM (SELECT name,email,phone FROM client_contacts WHERE client_id=c.id ORDER BY position)) AS contacts_json";

pub async fn list(db: &Database, actor: Actor, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let status = query
        .choice("status", "active", &["active", "archived", "all"])?
        .to_owned();
    let search = query.text("q", 100)?;
    let tag = query.text("tag", 40)?.to_lowercase();
    db.read(move |tx| {
        security::fresh(tx,&actor)?;
        let any:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=?1 AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='clients.view')",[&actor.user_id],|r|r.get(0))?;
        if !any {return Err(Error::Denied);}
        let sql=format!("SELECT {SUMMARY} FROM clients c WHERE (?1 IS NULL OR c.id {} ?1) AND (?2='all' OR (?2='active' AND c.archived_at IS NULL) OR (?2='archived' AND c.archived_at IS NOT NULL)) AND (?3='' OR instr(unicode_lower(c.name),unicode_lower(?3))>0) AND (?4='' OR EXISTS(SELECT 1 FROM client_tags WHERE client_id=c.id AND tag=?4)) AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=?5 AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='clients.view' AND (ur.scope_kind='global' OR ur.client_id=c.id)) ORDER BY c.id {} LIMIT ?6",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![paging.cursor,status,search,tag,actor.user_id,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn read(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move |tx| {
        security::require(tx, &actor, "clients.view", Some(&id)).map_err(|e| match e {
            Error::Denied => Error::NotFound,
            _ => e,
        })?;
        document(tx, &id, true)
    })
    .await
}

pub async fn create(db: &Database, actor: Actor, profile: Profile) -> Result<Mutation> {
    let profile = profile.normalize(false)?;
    db.write(move |tx| {
        security::require(tx,&actor,"clients.create",None)?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO client_scopes VALUES (?1)",[&id])?;
        tx.execute("INSERT INTO clients(id,name,legal_name,website,notes,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?6)",params![id,profile.name,profile.legal_name,profile.website,profile.notes,now])?;
        children(tx,&id,&profile)?;
        audit::mutation(tx,&actor,"client",&id,Some(&id),"created",(None, Snapshot::revision(1)))?;
        crate::websites::legacy_create(tx,&actor,&id,&profile.name,&profile.website,&now)?;
        Ok(Mutation {id,revision:1})
    }).await
}

pub async fn update(db: &Database, actor: Actor, id: String, profile: Profile) -> Result<Mutation> {
    let profile = profile.normalize(true)?;
    db.write(move |tx| {
        security::require(tx,&actor,"clients.update",Some(&id)).map_err(|e|match e {Error::Denied=>Error::NotFound,_=>e})?;
        security::client(tx,&id,true)?;
        let previous:i64=tx.query_row("SELECT revision FROM clients WHERE id=?1",[&id],|r|r.get(0))?;
        let revision=next_revision(previous,profile.expected_revision.ok_or(Error::Invalid("invalid_request"))?)?;
        tx.execute("UPDATE clients SET name=?1,legal_name=?2,website=?3,notes=?4,revision=?5,updated_at=?6 WHERE id=?7",params![profile.name,profile.legal_name,profile.website,profile.notes,revision,validation::now(),id])?;
        tx.execute("DELETE FROM client_contacts WHERE client_id=?1",[&id])?;
        tx.execute("DELETE FROM client_tags WHERE client_id=?1",[&id])?;
        children(tx,&id,&profile)?;
        audit::mutation(tx,&actor,"client",&id,Some(&id),"updated",(Some(Snapshot::revision(previous)), Snapshot::revision(revision)))?;
        Ok(Mutation {id,revision})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfirmRevision {
    pub expected_revision: i64,
    pub confirm: bool,
}

pub async fn archive(
    db: &Database,
    actor: Actor,
    id: String,
    input: ConfirmRevision,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        security::require(tx, &actor, "clients.archive", Some(&id)).map_err(|e| match e {
            Error::Denied => Error::NotFound,
            _ => e,
        })?;
        security::client(tx, &id, true)?;
        let previous: i64 =
            tx.query_row("SELECT revision FROM clients WHERE id=?1", [&id], |r| {
                r.get(0)
            })?;
        let revision = next_revision(previous, input.expected_revision)?;
        let now = validation::now();
        tx.execute(
            "UPDATE clients SET revision=?1,updated_at=?2,archived_at=?2 WHERE id=?3",
            params![revision, now, id],
        )?;
        audit::mutation(
            tx,
            &actor,
            "client",
            &id,
            Some(&id),
            "archived",
            (
                Some(Snapshot::revision(previous)),
                Snapshot::revision(revision),
            ),
        )?;
        Ok(Mutation { id, revision })
    })
    .await
}

fn children(tx: &Transaction<'_>, id: &str, profile: &Profile) -> Result<()> {
    for (position, contact) in profile
        .contacts
        .as_ref()
        .ok_or(Error::Internal)?
        .iter()
        .enumerate()
    {
        tx.execute(
            "INSERT INTO client_contacts VALUES (?1,?2,?3,?4,?5)",
            params![
                id,
                position as i64,
                contact.name,
                contact.email,
                contact.phone
            ],
        )?;
    }
    for tag in profile.tags.as_ref().ok_or(Error::Internal)? {
        tx.execute("INSERT INTO client_tags VALUES (?1,?2)", params![id, tag])?;
    }
    Ok(())
}

fn document(tx: &Transaction<'_>, id: &str, detail: bool) -> Result<Value> {
    Ok(tx.query_row(
        &format!(
            "SELECT {SUMMARY} {} FROM clients c WHERE c.id=?1",
            if detail { DETAILS } else { "" }
        ),
        [id],
        row_json,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{Auth, Login};

    #[tokio::test]
    async fn revisions_scopes_archive_and_audit_rollback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("else.sqlite3");
        let db = Database::open(&path, true).unwrap();
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
        let profile = || {
            validation::json::<Profile>(r#"{"name":"Synthetic Äccount","contacts":[{"name":"Synthetic Contact"}],"tags":["TAG"]}"#.as_bytes()).unwrap()
        };
        let created = create(&db, actor.clone(), profile()).await.unwrap();
        let page = list(
            &db,
            actor.clone(),
            Query::parse("q=äccount", &["q"]).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(page["data"][0]["id"], created.id);
        assert!(page["data"][0].get("contacts").is_none());
        let conn = crate::db::connection(&path).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        assert!(
            archive(
                &db,
                actor.clone(),
                created.id.clone(),
                ConfirmRevision {
                    expected_revision: 1,
                    confirm: true
                }
            )
            .await
            .is_err()
        );
        assert_eq!(
            read(&db, actor.clone(), created.id.clone()).await.unwrap()["revision"],
            1
        );
        conn.execute_batch("DROP TRIGGER reject_audit;").unwrap();
        archive(
            &db,
            actor.clone(),
            created.id.clone(),
            ConfirmRevision {
                expected_revision: 1,
                confirm: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read(&db, actor.clone(), created.id.clone()).await.unwrap()["status"],
            "archived"
        );
        assert!(
            archive(
                &db,
                actor.clone(),
                created.id.clone(),
                ConfirmRevision {
                    expected_revision: 2,
                    confirm: true
                }
            )
            .await
            .is_err()
        );
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='clients.view'",
            [validation::now()],
        )
        .unwrap();
        assert!(read(&db, actor, created.id).await.is_err());
    }
}
