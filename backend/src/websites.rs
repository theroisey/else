use crate::{
    audit::{self, Snapshot},
    clients::ConfirmRevision,
    db::Database,
    error::{Error, Result},
    query::{Mutation, Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{Transaction, params};
use serde::Deserialize;
use serde_json::Value;
use url::{Host, Url};

const COLUMNS: &str = "id,client_id,name,url,domain,description,is_primary,needs_review,revision,created_at,updated_at,archived_at,CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS status";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    name: String,
    url: String,
    #[serde(default)]
    description: String,
    // Accepted for compatibility, but the server always derives the domain.
    #[serde(default)]
    domain: String,
    #[serde(default)]
    expected_revision: Option<i64>,
}
impl Profile {
    fn normalize(mut self, updating: bool) -> Result<Self> {
        if self.expected_revision.is_some() != updating {
            return Err(Error::Invalid("invalid_request"));
        }
        self.name = validation::text(&self.name, 200, true, false)?;
        self.description = validation::text(&self.description, 4000, false, false)?;
        let raw = validation::text(&self.url, 2048, true, false)?;
        let raw = if raw.contains("://") {
            raw
        } else {
            format!("https://{raw}")
        };
        let mut parsed = Url::parse(&raw).map_err(|_| Error::Invalid("invalid_request"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(Error::Invalid("invalid_request"));
        }
        let Some(Host::Domain(domain)) = parsed.host() else {
            return Err(Error::Invalid("invalid_request"));
        };
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        if !valid_domain(&domain) || parsed.port() == Some(0) {
            return Err(Error::Invalid("invalid_request"));
        }
        parsed
            .set_host(Some(&domain))
            .map_err(|_| Error::Invalid("invalid_request"))?;
        self.domain = domain;
        self.url = parsed.to_string();
        if parsed.path() == "/" {
            self.url.pop();
        }
        if self.url.len() > 2048 {
            return Err(Error::Invalid("invalid_request"));
        }
        Ok(self)
    }
}
fn valid_domain(raw: &str) -> bool {
    raw.len() <= 253
        && raw.len() >= 3
        && raw.contains('.')
        && raw.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn authorize(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    permission: Option<&str>,
    writing: bool,
) -> Result<()> {
    security::fresh(tx, actor)?;
    if !security::allowed_user(tx, &actor.user_id, "clients.view", Some(client))? {
        return Err(Error::NotFound);
    }
    if let Some(permission) = permission
        && !security::allowed_user(tx, &actor.user_id, permission, Some(client))?
    {
        return Err(Error::NotFound);
    }
    security::client(tx, client, writing)
}
fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS} FROM client_websites WHERE id=?1 AND client_id=?2"),
        params![id, client],
        row_json,
    )?)
}
fn state(tx: &Transaction<'_>, client: &str, id: &str, expected: i64) -> Result<i64> {
    let (previous, archived): (i64, Option<String>) = tx.query_row(
        "SELECT revision,archived_at FROM client_websites WHERE id=?1 AND client_id=?2",
        params![id, client],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if archived.is_some() {
        return Err(Error::Conflict("conflict"));
    }
    next_revision(previous, expected)
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let status = query
        .choice("status", "active", &["active", "archived", "all"])?
        .to_owned();
    db.read(move|tx| {
        authorize(tx,&actor,&client,None,false)?;
        let mut statement=tx.prepare(&format!("SELECT {COLUMNS} FROM client_websites WHERE client_id=?1 AND (?2 IS NULL OR id>?2) AND (?3='all' OR (?3='active' AND archived_at IS NULL) OR (?3='archived' AND archived_at IS NOT NULL)) ORDER BY id LIMIT ?4"))?;
        let data=statement.query_map(params![client,paging.cursor,status,(paging.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}
pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, None, false)?;
        document(tx, &client, &id)
    })
    .await
}
pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    let profile = profile.normalize(false)?;
    db.write(move|tx| {
        authorize(tx,&actor,&client,Some("clients.update"),true)?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO client_websites(id,client_id,name,url,domain,description,is_primary,needs_review,legacy_source,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,0,0,0,1,?7,?7)",params![id,client,profile.name,profile.url,profile.domain,profile.description,now])?;
        audit::mutation(tx,&actor,"website",&id,Some(&client),"created",(None, Snapshot::revision(1)))?;
        Ok(Mutation{id,revision:1})
    }).await
}
pub async fn update(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    profile: Profile,
) -> Result<Mutation> {
    let profile = profile.normalize(true)?;
    db.write(move|tx| {
        authorize(tx,&actor,&client,Some("clients.update"),true)?;
        let previous=profile.expected_revision.ok_or(Error::Invalid("invalid_request"))?;
        let revision=state(tx,&client,&id,previous)?;
        tx.execute("UPDATE client_websites SET name=?1,url=?2,domain=?3,description=?4,needs_review=0,revision=?5,updated_at=?6 WHERE id=?7",params![profile.name,profile.url,profile.domain,profile.description,revision,validation::now(),id])?;
        audit::mutation(tx,&actor,"website",&id,Some(&client),"updated",(Some(Snapshot::revision(previous)), Snapshot::revision(revision)))?;
        Ok(Mutation{id,revision})
    }).await
}
pub async fn select_or_archive(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: ConfirmRevision,
    archive: bool,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move|tx| {
        authorize(tx,&actor,&client,Some(if archive{"clients.archive"}else{"clients.update"}),true)?;
        let revision=state(tx,&client,&id,input.expected_revision)?;let now=validation::now();
        if archive {
            tx.execute("UPDATE client_websites SET archived_at=?1,updated_at=?1,is_primary=0,revision=?2 WHERE id=?3",params![now,revision,id])?;
        }else{
            let review:bool=tx.query_row("SELECT needs_review FROM client_websites WHERE id=?1",[&id],|r|r.get(0))?;
            if review{return Err(Error::Invalid("invalid_request"));}
            let mut statement=tx.prepare("SELECT id,revision FROM client_websites WHERE client_id=?1 AND is_primary=1 AND id<>?2")?;
            let prior=statement.query_map(params![client,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
            for (other,previous) in prior {
                let next=next_revision(previous,previous)?;
                tx.execute("UPDATE client_websites SET is_primary=0,revision=?1,updated_at=?2 WHERE id=?3",params![next,now,other])?;
                audit::mutation(tx,&actor,"website",&other,Some(&client),"updated",(Some(Snapshot::revision(previous)), Snapshot::revision(next)))?;
            }
            tx.execute("UPDATE client_websites SET is_primary=1,revision=?1,updated_at=?2 WHERE id=?3",params![revision,now,id])?;
        }
        audit::mutation(tx,&actor,"website",&id,Some(&client),if archive{"archived"}else{"updated"},(Some(Snapshot::revision(input.expected_revision)), Snapshot::revision(revision)))?;
        Ok(Mutation{id,revision})
    }).await
}

/// Preserve the compatibility field byte for byte. Only the old conservative
/// hostname-only syntax may become primary automatically; ambiguous paths or
/// legacy identifiers require explicit review in the independent workspace.
pub(crate) fn legacy_create(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    name: &str,
    url: &str,
    now: &str,
) -> Result<()> {
    if url.is_empty() {
        return Ok(());
    }
    let domain = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or("")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    let safe = !domain.is_empty()
        && domain.len() <= 253
        && domain
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && domain
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && domain
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && !url.ends_with("//");
    let id = validation::new_id();
    tx.execute("INSERT INTO client_websites(id,client_id,name,url,domain,is_primary,needs_review,legacy_source,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",params![id,client,name,url,if safe{&domain}else{""},safe,!safe,now])?;
    audit::mutation(
        tx,
        actor,
        "website",
        &id,
        Some(client),
        "created",
        (None, Snapshot::revision(1)),
    )
}

pub async fn connections(
    db: &Database,
    actor: Actor,
    client: String,
    website: String,
    query: Query,
) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move|tx| {
        authorize(tx,&actor,&client,None,false)?;document(tx,&client,&website)?;
        if !security::allowed_user(tx,&actor.user_id,"integrations.view",Some(&client))? && !security::allowed_user(tx,&actor.user_id,"analytics.view",Some(&client))? {return Err(Error::NotFound);}
        let mut stmt=tx.prepare("SELECT c.id,c.client_id,c.provider,c.state,CAST(c.revision AS TEXT) AS revision,c.created_at,c.updated_at FROM integration_connections c JOIN website_integrations b ON b.connection_id=c.id AND b.client_id=c.client_id WHERE b.client_id=?1 AND b.website_id=?2 AND (?3 IS NULL OR c.id>?3) ORDER BY c.id LIMIT ?4")?;
        let data=stmt.query_map(params![client,website,paging.cursor,(paging.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    expected_revision: i64,
    connection_id: String,
    attach: bool,
    confirm: bool,
}
pub async fn bind(
    db: &Database,
    actor: Actor,
    client: String,
    website: String,
    input: Binding,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    validation::id(&input.connection_id)?;
    db.write(move|tx| {
        authorize(tx,&actor,&client,Some("integrations.manage"),true)?;
        let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM client_websites w JOIN integration_connections c ON c.client_id=w.client_id WHERE w.id=?1 AND w.client_id=?2 AND w.archived_at IS NULL AND c.id=?3)",params![website,client,input.connection_id],|r|r.get(0))?;
        if !exists {return Err(Error::NotFound);}
        let revision=state(tx,&client,&website,input.expected_revision)?;
        if input.attach {tx.execute("INSERT INTO website_integrations VALUES (?1,?2,?3)",params![input.connection_id,website,client])?;}
        else if tx.execute("DELETE FROM website_integrations WHERE connection_id=?1 AND website_id=?2 AND client_id=?3",params![input.connection_id,website,client])?!=1{return Err(Error::Conflict("conflict"));}
        tx.execute("UPDATE client_websites SET revision=?1,updated_at=?2 WHERE id=?3",params![revision,validation::now(),website])?;
        audit::mutation(tx,&actor,"website",&website,Some(&client),"updated",(Some(Snapshot::revision(input.expected_revision)), Snapshot::revision(revision)))?;
        audit::mutation(tx,&actor,"website_integration",&input.connection_id,Some(&client),if input.attach{"created"}else{"deleted"},(Some(Snapshot{exists:Some(!input.attach),..Default::default()}), Snapshot{exists:Some(input.attach),..Default::default()}))?;
        Ok(Mutation{id:website,revision})
    }).await
}
pub async fn activity(
    db: &Database,
    actor: Actor,
    client: String,
    website: String,
    query: Query,
) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move|tx| {
        authorize(tx,&actor,&client,Some("activity.view"),false)?;document(tx,&client,&website)?;
        let boundary=if let Some(cursor)=&paging.cursor {
            let time:Option<String>=tx.query_row("SELECT occurred_at FROM audit_events WHERE id=?1 AND client_id=?2 AND resource_kind='website' AND resource_id=?3",params![cursor,client,website],|r|r.get(0)).optional()?;
            Some(time.ok_or(Error::Invalid("invalid_request"))?)
        }else{None};
        let mut stmt=tx.prepare("SELECT id,client_id,occurred_at,event_name AS event_type,resource_kind,resource_id,CASE event_name WHEN 'website.created' THEN 'Website created.' WHEN 'website.updated' THEN 'Website updated.' ELSE 'Website archived.' END AS summary FROM audit_events WHERE client_id=?1 AND resource_kind='website' AND resource_id=?2 AND event_name IN ('website.created','website.updated','website.archived') AND (?3 IS NULL OR (occurred_at,id)<(?3,?4)) ORDER BY occurred_at DESC,id DESC LIMIT ?5")?;
        let data=stmt.query_map(params![client,website,boundary,paging.cursor,(paging.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}
use rusqlite::OptionalExtension;

/// Providers must call this inside their own fresh read/write transaction.
pub fn check_binding(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    website: &str,
    connection: &str,
    writing: bool,
) -> Result<()> {
    authorize(tx, actor, client, None, writing)?;
    let linked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM website_integrations b JOIN client_websites w ON w.id=b.website_id AND w.client_id=b.client_id WHERE b.client_id=?1 AND b.website_id=?2 AND b.connection_id=?3 AND (?4=0 OR w.archived_at IS NULL))",params![client,website,connection,writing],|r|r.get(0))?;
    if linked { Ok(()) } else { Err(Error::NotFound) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{clients, testing::Fixture};
    fn profile(name: &str, url: &str) -> Profile {
        serde_json::from_value(serde_json::json!({"name":name,"url":url})).unwrap()
    }
    fn confirm(revision: i64) -> ConfirmRevision {
        ConfirmRevision {
            expected_revision: revision,
            confirm: true,
        }
    }

    #[test]
    fn website_identifiers_are_normalized_without_fetching_or_trusting_domain() {
        let input = profile("Synthetic site", "EXAMPLE.com/path")
            .normalize(false)
            .unwrap();
        assert_eq!(input.url, "https://example.com/path");
        assert_eq!(input.domain, "example.com");
        for raw in [
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
            "https://user:secret@example.com",
            "https://example.com?",
            "https://example.com#fragment",
            "https://bad-.example.com",
            "https://example.com:0",
            "ftp://example.com",
        ] {
            assert!(
                profile("Synthetic site", raw).normalize(false).is_err(),
                "{raw}"
            );
        }
    }

    #[tokio::test]
    async fn primary_changes_associations_and_audits_are_atomic_and_owned() {
        let f = Fixture::new().await;
        let first = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            profile("Synthetic first", "first.example.com"),
        )
        .await
        .unwrap();
        let second = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            profile("Synthetic second", "second.example.com"),
        )
        .await
        .unwrap();
        select_or_archive(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            first.id.clone(),
            confirm(1),
            false,
        )
        .await
        .unwrap();
        select_or_archive(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            second.id.clone(),
            confirm(1),
            false,
        )
        .await
        .unwrap();
        let current = read(&f.db, f.actor.clone(), f.client.clone(), first.id.clone())
            .await
            .unwrap();
        assert_eq!(current["revision"], 3);
        assert_eq!(current["is_primary"], false);
        assert_eq!(
            read(&f.db, f.actor.clone(), f.client.clone(), second.id.clone())
                .await
                .unwrap()["is_primary"],
            true
        );
        assert!(matches!(
            select_or_archive(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                first.id.clone(),
                confirm(2),
                false
            )
            .await,
            Err(Error::Conflict(_))
        ));
        let conn = f.connection();
        conn.execute_batch("CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic'); END;").unwrap();
        assert!(
            select_or_archive(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                first.id.clone(),
                confirm(3),
                false
            )
            .await
            .is_err()
        );
        assert_eq!(
            read(&f.db, f.actor.clone(), f.client.clone(), second.id.clone())
                .await
                .unwrap()["is_primary"],
            true
        );
        conn.execute_batch("DROP TRIGGER synthetic_audit_failure")
            .unwrap();
        let connection = validation::new_id();
        let now = validation::now();
        conn.execute("INSERT INTO integration_connections VALUES (?1,?2,'ga4','123456','connected',1,1,?3,?3)",params![connection,f.client,now]).unwrap();
        let binding = |revision, attach| Binding {
            expected_revision: revision,
            connection_id: connection.clone(),
            attach,
            confirm: true,
        };
        bind(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            first.id.clone(),
            binding(3, true),
        )
        .await
        .unwrap();
        assert!(matches!(
            bind(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                second.id.clone(),
                binding(2, true)
            )
            .await,
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            connections(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                first.id.clone(),
                Query::default()
            )
            .await
            .unwrap()["data"][0]["revision"],
            "1"
        );
        let other = clients::create(
            &f.db,
            f.actor.clone(),
            validation::json(br#"{"name":"Synthetic other"}"#).unwrap(),
        )
        .await
        .unwrap();
        assert!(matches!(
            read(&f.db, f.actor.clone(), other.id, first.id.clone()).await,
            Err(Error::NotFound)
        ));
        select_or_archive(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            first.id.clone(),
            confirm(4),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            connections(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                first.id.clone(),
                Query::default()
            )
            .await
            .unwrap()["data"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let actor = f.actor.clone();
        let client = f.client.clone();
        let website = first.id.clone();
        let id = connection.clone();
        f.db.read(move |tx| check_binding(tx, &actor, &client, &website, &id, false))
            .await
            .unwrap();
        let actor = f.actor.clone();
        let client = f.client.clone();
        let website = first.id.clone();
        assert!(
            f.db.read(move |tx| check_binding(tx, &actor, &client, &website, &connection, true))
                .await
                .is_err()
        );
        let feed = activity(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            first.id.clone(),
            Query::parse("limit=1", &["limit", "cursor"]).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(feed["data"][0]["summary"], "Website archived.");
        assert!(feed["page"]["next_cursor"].is_string());
        let raw:String=conn.query_row("SELECT group_concat(before_state||after_state) FROM audit_events WHERE resource_kind='website'",[],|r|r.get(0)).unwrap();
        assert!(!raw.contains("example.com"));
        assert!(!raw.contains("Synthetic"));
    }

    #[tokio::test]
    async fn initial_profile_url_is_preserved_and_independent_edits_do_not_replace_it() {
        let f = Fixture::new().await;
        let client = clients::create(
            &f.db,
            f.actor.clone(),
            validation::json(
                br#"{"name":"Synthetic legacy","website":"https://example.com/path"}"#,
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let page = list(&f.db, f.actor.clone(), client.id.clone(), Query::default())
            .await
            .unwrap();
        let item = &page["data"][0];
        assert_eq!(item["url"], "https://example.com/path");
        assert_eq!(item["needs_review"], true);
        let id = item["id"].as_str().unwrap().to_owned();
        assert!(
            select_or_archive(
                &f.db,
                f.actor.clone(),
                client.id.clone(),
                id.clone(),
                confirm(1),
                false
            )
            .await
            .is_err()
        );
        let mut input = profile("Synthetic repaired", "https://repaired.example.com");
        input.expected_revision = Some(1);
        update(&f.db, f.actor.clone(), client.id.clone(), id, input)
            .await
            .unwrap();
        assert_eq!(
            clients::read(&f.db, f.actor.clone(), client.id)
                .await
                .unwrap()["website"],
            "https://example.com/path"
        );
    }
}
