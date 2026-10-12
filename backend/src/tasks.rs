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
pub(crate) const READ_KEYS: &[&str] = &[
    "tasks.view",
    "tasks.read_own",
    "tasks.read_team",
    "tasks.read_development",
];

const COLUMNS: &str = "t.id,t.client_id,t.created_by,t.assignee_id,t.title,t.status,t.priority,t.start_at,t.due_at,t.completed_at,t.cancelled_at,t.revision,t.created_at,t.updated_at,t.archived_at,(SELECT coalesce(json_group_array(tag),'[]') FROM (SELECT tag FROM task_tags WHERE task_id=t.id ORDER BY tag)) AS tags_json,(SELECT u.display_name FROM users u WHERE u.id=t.created_by) AS creator_name,(SELECT u.display_name FROM users u WHERE u.id=t.assignee_id) AS assignee_name,(SELECT c.name FROM clients c WHERE c.id=t.client_id) AS brand_name,(SELECT r.id FROM technical_requests r WHERE r.task_id=t.id) AS request_id";

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

pub async fn queue(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let page = q.paging()?;
    let client = q.get("client_id").map(validation::id).transpose()?;
    let search = q.text("q", 100)?;
    let mut states = STATES.to_vec();
    states.extend(["all", "active"]);
    let status = q.choice("status", "active", &states)?.to_owned();
    let assignee = q.get("assignee").unwrap_or("").to_owned();
    if !assignee.is_empty() && !matches!(assignee.as_str(), "me" | "unassigned") {
        validation::id(&assignee)?;
    }
    let overdue = q.choice("overdue", "false", &["false", "true"])? == "true";
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        let visible=visibility_sql("?1");
        let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} FROM tasks t WHERE {visible} AND t.archived_at IS NULL AND (?2 IS NULL OR t.client_id=?2) AND (?3 IS NULL OR t.id>?3) AND (?4='all' OR (?4='active' AND t.status NOT IN ('done','cancelled')) OR t.status=?4) AND (?5='' OR (?5='me' AND t.assignee_id=?1) OR (?5='unassigned' AND t.assignee_id IS NULL) OR t.assignee_id=?5) AND instr(unicode_lower(t.title),unicode_lower(?6))>0 AND (NOT ?7 OR (t.due_at<?8 AND t.status NOT IN ('done','cancelled'))) ORDER BY t.id LIMIT ?9"))?;
        page.page(stmt.query_map(params![actor.user_id,client,page.cursor,status,assignee,search,overdue,validation::now(),(page.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
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
        let visible=visibility_sql("?10");
        let sql=format!("SELECT {COLUMNS} FROM tasks t WHERE t.client_id=?1 AND ({visible}) AND (?2 IS NULL OR t.id {} ?2) AND (?3='all' OR t.status=?3) AND (?4='all' OR t.priority=?4) AND (?5='all' OR (?5='false' AND t.archived_at IS NULL) OR (?5='true' AND t.archived_at IS NOT NULL)) AND (?6='' OR instr(unicode_lower(t.title),unicode_lower(?6))>0) AND (?7='' OR EXISTS(SELECT 1 FROM task_tags WHERE task_id=t.id AND tag=?7)) AND (?8='' OR (?8='unassigned' AND t.assignee_id IS NULL) OR t.assignee_id=?8) ORDER BY t.id {} LIMIT ?9",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![client,paging.cursor,status,priority,archived,search,tag,assignee,(paging.limit+1) as i64,actor.user_id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, None, false)?;
        own_read_scope(tx, &actor, &client, &id)?;
        document(tx, &client, &id)
    })
    .await
}

pub async fn assignees(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,None,true)?;
        security::require_any(tx,&actor,&["tasks.create","tasks.update","tasks.manage","tasks.assign_team"],&client).map_err(hidden)?;
        let scope=assignment_sql("?4","u.id","?2");
        let mut statement=tx.prepare(&format!("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND (?1 IS NULL OR u.id>?1) AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=u.id AND ur.revoked_at IS NULL AND rp.revoked_at IS NULL AND rp.permission_key IN ('tasks.view','tasks.read_own','tasks.read_team','tasks.read_development') AND (ur.scope_kind='global' OR ur.client_id=?2)) AND {scope} ORDER BY u.id LIMIT ?3"))?;
        let data=statement.query_map(params![paging.cursor,client,(paging.limit+1) as i64,actor.user_id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    db.write(move |tx| create_in_transaction(tx, &actor, &client, profile))
        .await
}

pub(crate) fn create_in_transaction(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    profile: Profile,
) -> Result<Mutation> {
    create_impl(tx, actor, client, profile, false)
}
pub(crate) fn create_development_in_transaction(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    profile: Profile,
) -> Result<Mutation> {
    security::require(tx, actor, "tickets.accept", Some(client))?;
    create_impl(tx, actor, client, profile, true)
}
fn create_impl(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    profile: Profile,
    development: bool,
) -> Result<Mutation> {
    let profile = profile.normalize(false)?;
    authorize(tx, actor, client, Some("tasks.create"), true)?;
    eligible(tx, client, profile.assignee_id.as_deref(), None)?;
    if !development {
        assignment_scope(tx, actor, client, profile.assignee_id.as_deref())?;
    }
    let id = validation::new_id();
    let now = validation::now();
    let status = profile.status.as_deref().ok_or(Error::Internal)?;
    tx.execute("INSERT INTO tasks(id,client_id,created_by,assignee_id,title,description,status,priority,start_at,due_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11)",params![id,client,actor.user_id,profile.assignee_id,profile.title,profile.description,status,profile.priority,profile.start_at,profile.due_at,now])?;
    tags(tx, &id, &profile)?;
    audit::mutation(
        tx,
        actor,
        "task",
        &id,
        Some(client),
        "created",
        (None, snapshot(1, status)),
    )?;
    if !development && actor.source() != "job" {
        crate::operations::notifications::emit_task(
            tx,
            &id,
            "task_assigned",
            &format!("task-assigned:{id}:1"),
            false,
        )?;
    }
    Ok(Mutation { id, revision: 1 })
}
fn independent(tx: &Transaction<'_>, id: &str) -> Result<()> {
    let linked: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM technical_requests WHERE task_id=?1)",
        [id],
        |r| r.get(0),
    )?;
    if linked {
        Err(Error::Conflict("linked_request_workflow"))
    } else {
        Ok(())
    }
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
        independent(tx,&id)?;let old=document(tx,&client,&id)?;writable(&old,true)?;
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub assignee_id: Option<String>,
    pub expected_revision: i64,
}
pub async fn assign(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    mut input: Assignment,
) -> Result<Mutation> {
    input.assignee_id = input.assignee_id.map(|v| validation::id(&v)).transpose()?;
    db.write(move |tx| {
        authorize(tx, &actor, &client, Some("tasks.assign_team"), true)?;
        own_read_scope(tx, &actor, &client, &id)?;
        independent(tx, &id)?;
        let old = document(tx, &client, &id)?;
        writable(&old, true)?;
        assignment_scope(tx, &actor, &client, input.assignee_id.as_deref())?;
        eligible(tx, &client, input.assignee_id.as_deref(), None)?;
        let previous = old["revision"].as_i64().ok_or(Error::Internal)?;
        let next = next_revision(previous, input.expected_revision)?;
        tx.execute(
            "UPDATE tasks SET assignee_id=?1,revision=?2,updated_at=?3 WHERE id=?4",
            params![input.assignee_id, next, validation::now(), id],
        )?;
        let status = old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(
            tx,
            &actor,
            "task",
            &id,
            Some(&client),
            "updated",
            (Some(snapshot(previous, status)), snapshot(next, status)),
        )?;
        crate::operations::notifications::emit_task(
            tx,
            &id,
            "task_assigned",
            &format!("task-assigned:{id}:{next}"),
            false,
        )?;
        Ok(Mutation { id, revision: next })
    })
    .await
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
        security::fresh(tx,&actor)?;
        let delegated=security::allowed_user(tx,&actor.user_id,"tasks.update",Some(&client))? || security::allowed_user(tx,&actor.user_id,"tasks.manage",Some(&client))?;
        if delegated {authorize(tx,&actor,&client,Some("tasks.update"),true)?;}else {
            security::require(tx,&actor,"tasks.update_own",Some(&client)).map_err(hidden)?;
            own_read_scope(tx,&actor,&client,&id)?;
            let own:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND client_id=?2 AND assignee_id=?3)",params![id,client,actor.user_id],|r|r.get(0))?;
            if !own{return Err(Error::NotFound)}
            security::client(tx,&client,true)?;
        }
        independent(tx,&id)?;let old=document(tx,&client,&id)?;writable(&old,false)?;
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
        independent(tx, &id)?;
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
        security::require_any(tx, actor, READ_KEYS, client).map_err(hidden)?;
    }
    security::client(tx, client, active)
}

fn hidden(error: Error) -> Error {
    match error {
        Error::Denied => Error::NotFound,
        _ => error,
    }
}

pub(crate) fn visibility_sql(user: &str) -> String {
    use crate::operations::grant_sql as grant;
    let full = grant(user, "tasks.view", "t.client_id");
    let own = READ_KEYS
        .iter()
        .map(|key| grant(user, key, "t.client_id"))
        .collect::<Vec<_>>()
        .join(" OR ");
    let team = grant(user, "tasks.read_team", "t.client_id");
    let development = grant(user, "tasks.read_development", "t.client_id");
    let requests = crate::operations::requests::visibility_sql(user);
    format!(
        "({full} OR (t.assignee_id={user} AND ({own})) OR ({team} AND (t.created_by={user} OR EXISTS(SELECT 1 FROM teams tm JOIN brand_staff_assignments b ON b.team_id=tm.id JOIN team_memberships m ON m.team_id=tm.id AND m.user_id=b.user_id AND m.revoked_at IS NULL WHERE tm.leader_id={user} AND tm.archived_at IS NULL AND b.user_id=t.assignee_id AND b.client_id=t.client_id AND b.revoked_at IS NULL))) OR ({development} AND EXISTS(SELECT 1 FROM technical_requests r WHERE r.task_id=t.id AND r.client_id=t.client_id AND {requests})))"
    )
}
fn own_read_scope(tx: &Transaction<'_>, actor: &Actor, client: &str, id: &str) -> Result<()> {
    security::fresh(tx, actor)?;
    let visible = visibility_sql("?3");
    let own: bool = tx.query_row(
        &format!(
            "SELECT EXISTS(SELECT 1 FROM tasks t WHERE t.id=?1 AND t.client_id=?2 AND {visible})"
        ),
        params![id, client, actor.user_id],
        |r| r.get(0),
    )?;
    if own { Ok(()) } else { Err(Error::NotFound) }
}
fn assignment_sql(actor: &str, user: &str, client: &str) -> String {
    use crate::operations::grant_sql as grant;
    let full = grant(actor, "tasks.view", client);
    let manage = grant(actor, "tasks.manage", client);
    let team = grant(actor, "tasks.assign_team", client);
    format!(
        "({full} OR {manage} OR {actor}={user} OR ({team} AND EXISTS(SELECT 1 FROM teams tm JOIN team_memberships m ON m.team_id=tm.id JOIN brand_staff_assignments b ON b.team_id=tm.id AND b.user_id=m.user_id AND b.revoked_at IS NULL WHERE tm.leader_id={actor} AND tm.archived_at IS NULL AND m.user_id={user} AND m.revoked_at IS NULL AND b.client_id={client})))"
    )
}
pub(crate) fn assignment_scope(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    user: Option<&str>,
) -> Result<()> {
    if let Some(user) = user {
        let scope = assignment_sql("?1", "?2", "?3");
        let allowed: bool = tx.query_row(
            &format!("SELECT {scope}"),
            params![actor.user_id, user, client],
            |r| r.get(0),
        )?;
        if !allowed {
            return Err(Error::Invalid("invalid_assignee"));
        }
    }
    Ok(())
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
        && !security::allowed_user(tx, user, "tasks.read_own", Some(client))?
        && !security::allowed_user(tx, user, "tasks.read_team", Some(client))?
        && !security::allowed_user(tx, user, "tasks.read_development", Some(client))?
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
