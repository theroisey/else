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
use std::collections::BTreeSet;

pub const STATES: &[&str] = &[
    "backlog",
    "todo",
    "in_progress",
    "blocked",
    "review",
    "done",
    "cancelled",
];
const PRIORITIES: &[&str] = &["low", "medium", "high", "urgent"];
const COLUMNS: &str = "t.id,t.client_id,t.created_by,t.assignee_id,t.title,t.status,t.priority,t.start_at,t.due_at,t.completed_at,t.cancelled_at,t.revision,t.created_at,t.updated_at,t.archived_at,(SELECT coalesce(json_group_array(tag),'[]') FROM (SELECT tag FROM task_tags WHERE task_id=t.id ORDER BY tag)) AS tags_json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    priority: String,
    assignee_id: Option<String>,
    start_at: Option<String>,
    due_at: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    status: Option<String>,
    expected_revision: Option<i64>,
}

impl Profile {
    fn normalize(mut self, updating: bool) -> Result<Self> {
        if self.expected_revision.is_some() != updating || (updating && self.status.is_some()) {
            return Err(Error::Invalid("invalid_request"));
        }
        self.title = validation::text(&self.title, 200, true, false)?;
        self.description = validation::text(&self.description, 8000, false, true)?;
        if self.priority.is_empty() {
            self.priority = "medium".into();
        }
        if !PRIORITIES.contains(&self.priority.as_str()) {
            return Err(Error::Invalid("invalid_request"));
        }
        if !updating {
            let status = self.status.get_or_insert_with(|| "todo".into());
            if !["todo", "backlog"].contains(&status.as_str()) {
                return Err(Error::Invalid("invalid_request"));
            }
        }
        self.assignee_id = self.assignee_id.map(|v| validation::id(&v)).transpose()?;
        self.start_at = self.start_at.map(|v| validation::instant(&v)).transpose()?;
        self.due_at = self.due_at.map(|v| validation::instant(&v)).transpose()?;
        if self
            .start_at
            .as_ref()
            .zip(self.due_at.as_ref())
            .is_some_and(|(start, due)| start > due)
        {
            return Err(Error::Invalid("invalid_dates"));
        }
        let tags = self.tags.get_or_insert_with(Vec::new);
        let mut distinct = BTreeSet::new();
        if tags.len() > 20 {
            return Err(Error::Invalid("invalid_request"));
        }
        for tag in tags.iter_mut() {
            *tag = validation::text(tag, 40, true, false)?.to_lowercase();
            if !distinct.insert(tag.clone()) {
                return Err(Error::Invalid("invalid_request"));
            }
        }
        Ok(self)
    }
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let mut states = STATES.to_vec();
    states.push("all");
    let status = query.choice("status", "all", &states)?.to_owned();
    let mut priorities = PRIORITIES.to_vec();
    priorities.push("all");
    let priority = query.choice("priority", "all", &priorities)?.to_owned();
    let archived = query
        .choice("archived", "false", &["false", "true", "all"])?
        .to_owned();
    let search = query.text("q", 100)?;
    let tag = query.text("tag", 40)?.to_lowercase();
    let assignee = query.get("assignee").unwrap_or("").to_owned();
    if !assignee.is_empty() && assignee != "unassigned" {
        validation::id(&assignee)?;
    }
    db.read(move |tx| {
        authorize(tx,&actor,&client,None,false)?;
        let sql=format!("SELECT {COLUMNS} FROM tasks t WHERE t.client_id=?1 AND (?2 IS NULL OR t.id {} ?2) AND (?3='all' OR t.status=?3) AND (?4='all' OR t.priority=?4) AND (?5='all' OR (?5='false' AND t.archived_at IS NULL) OR (?5='true' AND t.archived_at IS NOT NULL)) AND (?6='' OR instr(unicode_lower(t.title),unicode_lower(?6))>0) AND (?7='' OR EXISTS(SELECT 1 FROM task_tags WHERE task_id=t.id AND tag=?7)) AND (?8='' OR (?8='unassigned' AND t.assignee_id IS NULL) OR t.assignee_id=?8) ORDER BY t.id {} LIMIT ?9",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![client,paging.cursor,status,priority,archived,search,tag,assignee,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
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

pub async fn assignees(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,None,true)?;
        security::require_any(tx,&actor,&["tasks.create","tasks.update","tasks.manage"],&client).map_err(hidden)?;
        let mut statement=tx.prepare("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND (?1 IS NULL OR u.id>?1) AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key='tasks.view' AND (ur.scope_kind='global' OR ur.client_id=?2)) ORDER BY u.id LIMIT ?3")?;
        let data=statement.query_map(params![paging.cursor,client,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    let profile = profile.normalize(false)?;
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("tasks.create"),true)?;
        eligible(tx,&client,profile.assignee_id.as_deref(),None)?;
        let id=validation::new_id();let now=validation::now();let status=profile.status.as_deref().ok_or(Error::Internal)?;
        tx.execute("INSERT INTO tasks(id,client_id,created_by,assignee_id,title,description,status,priority,start_at,due_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![id,client,actor.user_id,profile.assignee_id,profile.title,profile.description,status,profile.priority,profile.start_at,profile.due_at,now])?;
        tags(tx,&id,&profile)?;
        audit::mutation(tx,&actor,"task",&id,Some(&client),"created",(None, snapshot(1,status)))?;
        Ok(Mutation {id,revision:1})
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
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("tasks.update"),true)?;
        let old=document(tx,&client,&id)?;writable(&old,true)?;
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;
        let revision=next_revision(previous,profile.expected_revision.ok_or(Error::Invalid("invalid_request"))?)?;
        eligible(tx,&client,profile.assignee_id.as_deref(),old["assignee_id"].as_str())?;
        tx.execute("UPDATE tasks SET title=?1,description=?2,priority=?3,assignee_id=?4,start_at=?5,due_at=?6,revision=?7,updated_at=?8 WHERE id=?9",params![profile.title,profile.description,profile.priority,profile.assignee_id,profile.start_at,profile.due_at,revision,validation::now(),id])?;
        tx.execute("DELETE FROM task_tags WHERE task_id=?1",[&id])?;tags(tx,&id,&profile)?;
        let status=old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(tx,&actor,"task",&id,Some(&client),"updated",(Some(snapshot(previous,status)), snapshot(revision,status)))?;
        Ok(Mutation{id,revision})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub status: String,
    pub expected_revision: i64,
}

pub async fn status(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: Status,
) -> Result<Mutation> {
    if !STATES.contains(&input.status.as_str()) {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("tasks.update"),true)?;
        let old=document(tx,&client,&id)?;writable(&old,false)?;
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;let status=old["status"].as_str().ok_or(Error::Internal)?;
        let revision=next_revision(previous,input.expected_revision)?;
        if !transition(status,&input.status) {return Err(Error::Conflict("invalid_transition"));}
        let now=validation::now();
        tx.execute("UPDATE tasks SET status=?1,completed_at=?2,cancelled_at=?3,revision=?4,updated_at=?5 WHERE id=?6",params![input.status,if input.status=="done"{Some(&now)}else{None},if input.status=="cancelled"{Some(&now)}else{None},revision,now,id])?;
        let action=match input.status.as_str(){"done"=>"completed","cancelled"=>"cancelled",_=>"updated"};
        audit::mutation(tx,&actor,"task",&id,Some(&client),action,(Some(snapshot(previous,status)), snapshot(revision,&input.status)))?;
        Ok(Mutation{id,revision})
    }).await
}

pub async fn archive(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: ConfirmRevision,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx, &actor, &client, Some("tasks.delete"), true)?;
        let old = document(tx, &client, &id)?;
        writable(&old, false)?;
        let previous = old["revision"].as_i64().ok_or(Error::Internal)?;
        let revision = next_revision(previous, input.expected_revision)?;
        let now = validation::now();
        tx.execute(
            "UPDATE tasks SET revision=?1,updated_at=?2,archived_at=?2 WHERE id=?3",
            params![revision, now, id],
        )?;
        let status = old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(
            tx,
            &actor,
            "task",
            &id,
            Some(&client),
            "archived",
            (Some(snapshot(previous, status)), snapshot(revision, status)),
        )?;
        Ok(Mutation { id, revision })
    })
    .await
}

pub fn transition(from: &str, to: &str) -> bool {
    match from {
        "backlog" => ["todo", "cancelled"].contains(&to),
        "todo" => ["backlog", "in_progress", "blocked", "cancelled"].contains(&to),
        "in_progress" => ["todo", "blocked", "review", "done", "cancelled"].contains(&to),
        "blocked" => ["todo", "in_progress", "cancelled"].contains(&to),
        "review" => ["in_progress", "blocked", "done", "cancelled"].contains(&to),
        "done" => to == "in_progress",
        "cancelled" => ["backlog", "todo"].contains(&to),
        _ => false,
    }
}

fn snapshot(revision: i64, status: &str) -> Snapshot {
    Snapshot {
        task_status: Some(status.into()),
        ..Snapshot::revision(revision)
    }
}

fn authorize(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    write: Option<&str>,
    active: bool,
) -> Result<()> {
    if let Some(key) = write {
        security::require_any(tx, actor, &[key, "tasks.manage"], client).map_err(hidden)?;
    } else {
        security::require(tx, actor, "tasks.view", Some(client)).map_err(hidden)?;
    }
    security::client(tx, client, active)
}

fn hidden(error: Error) -> Error {
    match error {
        Error::Denied => Error::NotFound,
        _ => error,
    }
}

fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS},t.description FROM tasks t WHERE t.id=?1 AND t.client_id=?2"),
        params![id, client],
        row_json,
    )?)
}

fn writable(old: &Value, metadata: bool) -> Result<()> {
    if !old["archived_at"].is_null()
        || (metadata && matches!(old["status"].as_str(), Some("done" | "cancelled")))
    {
        return Err(Error::Conflict("conflict"));
    }
    Ok(())
}

fn eligible(
    tx: &Transaction<'_>,
    client: &str,
    new: Option<&str>,
    old: Option<&str>,
) -> Result<()> {
    if new != old
        && let Some(user) = new
        && !security::allowed_user(tx, user, "tasks.view", Some(client))?
    {
        return Err(Error::Invalid("invalid_assignee"));
    }
    Ok(())
}

fn tags(tx: &Transaction<'_>, id: &str, profile: &Profile) -> Result<()> {
    for tag in profile.tags.as_ref().ok_or(Error::Internal)? {
        tx.execute("INSERT INTO task_tags VALUES (?1,?2)", params![id, tag])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_state_pairs_preserve_the_reviewed_task_lifecycle() {
        let edges = [
            ("backlog", "todo"),
            ("backlog", "cancelled"),
            ("todo", "backlog"),
            ("todo", "in_progress"),
            ("todo", "blocked"),
            ("todo", "cancelled"),
            ("in_progress", "todo"),
            ("in_progress", "blocked"),
            ("in_progress", "review"),
            ("in_progress", "done"),
            ("in_progress", "cancelled"),
            ("blocked", "todo"),
            ("blocked", "in_progress"),
            ("blocked", "cancelled"),
            ("review", "in_progress"),
            ("review", "blocked"),
            ("review", "done"),
            ("review", "cancelled"),
            ("done", "in_progress"),
            ("cancelled", "backlog"),
            ("cancelled", "todo"),
        ];
        for from in STATES {
            for to in STATES {
                assert_eq!(
                    transition(from, to),
                    edges.contains(&(*from, *to)),
                    "{from}->{to}"
                );
            }
        }
    }
}
