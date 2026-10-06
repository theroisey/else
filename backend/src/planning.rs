use crate::{
    audit::{self, Snapshot},
    clients::ConfirmRevision,
    db::Database,
    error::{Error, Result},
    query::{Mutation, Query, next_revision, row_json},
    security::{self, Actor},
    tasks::Status,
    validation,
};
use rusqlite::{Transaction, params};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone)]
pub struct Scope {
    pub client: String,
    pub plan: Option<String>,
}

impl Scope {
    fn table(&self) -> &'static str {
        if self.plan.is_some() {
            "milestones"
        } else {
            "plans"
        }
    }
    fn kind(&self) -> &'static str {
        if self.plan.is_some() {
            "milestone"
        } else {
            "plan"
        }
    }
    fn states(&self) -> &[&str] {
        if self.plan.is_some() {
            &["planned", "in_progress", "completed", "cancelled"]
        } else {
            &["draft", "active", "completed", "cancelled"]
        }
    }
    fn columns(&self) -> &'static str {
        if self.plan.is_some() {
            "p.id,p.plan_id,p.client_id,p.created_by,p.title,p.status,NULL AS start_at,p.due_at,p.completed_at,p.cancelled_at,p.revision,p.created_at,p.updated_at,p.archived_at"
        } else {
            "p.id,p.client_id,p.created_by,p.title,p.status,p.start_at,p.due_at,p.completed_at,p.cancelled_at,p.revision,p.created_at,p.updated_at,p.archived_at"
        }
    }
}

pub struct Profile {
    title: String,
    description: String,
    start: Option<String>,
    due: Option<String>,
    expected: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    title: String,
    #[serde(default)]
    description: String,
    start_at: Option<String>,
    due_at: Option<String>,
    expected_revision: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MilestoneInput {
    title: String,
    #[serde(default)]
    description: String,
    due_at: Option<String>,
    expected_revision: Option<i64>,
}

impl Profile {
    pub fn parse(body: &[u8], scope: &Scope, updating: bool) -> Result<Self> {
        let mut profile = if scope.plan.is_some() {
            let input: MilestoneInput = validation::json(body)?;
            Self {
                title: input.title,
                description: input.description,
                start: None,
                due: input.due_at,
                expected: input.expected_revision,
            }
        } else {
            let input: PlanInput = validation::json(body)?;
            Self {
                title: input.title,
                description: input.description,
                start: input.start_at,
                due: input.due_at,
                expected: input.expected_revision,
            }
        };
        if profile.expected.is_some() != updating {
            return Err(Error::Invalid("invalid_request"));
        }
        profile.title = validation::text(&profile.title, 200, true, false)?;
        profile.description = validation::text(&profile.description, 8000, false, true)?;
        profile.start = profile.start.map(|v| validation::instant(&v)).transpose()?;
        profile.due = profile.due.map(|v| validation::instant(&v)).transpose()?;
        if profile
            .start
            .as_ref()
            .zip(profile.due.as_ref())
            .is_some_and(|(start, due)| start > due)
        {
            return Err(Error::Invalid("invalid_dates"));
        }
        Ok(profile)
    }
}

pub async fn list(db: &Database, actor: Actor, scope: Scope, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let mut states = scope.states().to_vec();
    states.push("all");
    let status = query.choice("status", "all", &states)?.to_owned();
    let archived = query
        .choice("archived", "false", &["false", "true", "all"])?
        .to_owned();
    let search = query.text("q", 100)?;
    db.read(move |tx| {
        authorize(tx,&actor,&scope,None)?;
        let parent=if scope.plan.is_some(){"AND p.plan_id=?7"}else{"AND ?7 IS NULL"};
        let sql=format!("SELECT {} FROM {} p WHERE p.client_id=?1 AND (?2 IS NULL OR p.id {} ?2) AND (?3='all' OR p.status=?3) AND (?4='all' OR (?4='false' AND p.archived_at IS NULL) OR (?4='true' AND p.archived_at IS NOT NULL)) AND (?5='' OR instr(unicode_lower(p.title),unicode_lower(?5))>0) {parent} ORDER BY p.id {} LIMIT ?6",scope.columns(),scope.table(),paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![scope.client,paging.cursor,status,archived,search,(paging.limit+1) as i64,scope.plan],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn read(db: &Database, actor: Actor, scope: Scope, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &scope, None)?;
        document(tx, &scope, &id)
    })
    .await
}

pub async fn create(
    db: &Database,
    actor: Actor,
    scope: Scope,
    profile: Profile,
) -> Result<Mutation> {
    db.write(move |tx| {
        authorize(tx,&actor,&scope,Some("planning.create"))?;dates(tx,&scope,None,&profile)?;
        let id=validation::new_id();let now=validation::now();let status=scope.states()[0];
        if let Some(plan)=&scope.plan {
            tx.execute("INSERT INTO milestones(id,plan_id,client_id,created_by,title,description,status,due_at,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?9)",params![id,plan,scope.client,actor.user_id,profile.title,profile.description,status,profile.due,now])?;
        }else {
            tx.execute("INSERT INTO plans(id,client_id,created_by,title,description,status,start_at,due_at,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?9)",params![id,scope.client,actor.user_id,profile.title,profile.description,status,profile.start,profile.due,now])?;
        }
        audit::mutation(tx,&actor,scope.kind(),&id,Some(&scope.client),"created",(None, snapshot(1,status)))?;
        Ok(Mutation {id,revision:1})
    }).await
}

pub async fn update(
    db: &Database,
    actor: Actor,
    scope: Scope,
    id: String,
    profile: Profile,
) -> Result<Mutation> {
    db.write(move |tx| {
        authorize(tx,&actor,&scope,Some("planning.update"))?;
        let old=document(tx,&scope,&id)?;writable(&old,true)?;
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;
        let revision=next_revision(previous,profile.expected.ok_or(Error::Invalid("invalid_request"))?)?;dates(tx,&scope,Some(&id),&profile)?;
        if scope.plan.is_some() {
            tx.execute("UPDATE milestones SET title=?1,description=?2,due_at=?3,revision=?4,updated_at=?5 WHERE id=?6",params![profile.title,profile.description,profile.due,revision,validation::now(),id])?;
        }else {
            tx.execute("UPDATE plans SET title=?1,description=?2,start_at=?3,due_at=?4,revision=?5,updated_at=?6 WHERE id=?7",params![profile.title,profile.description,profile.start,profile.due,revision,validation::now(),id])?;
        }
        let status=old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(tx,&actor,scope.kind(),&id,Some(&scope.client),"updated",(Some(snapshot(previous,status)), snapshot(revision,status)))?;
        Ok(Mutation{id,revision})
    }).await
}

pub async fn status(
    db: &Database,
    actor: Actor,
    scope: Scope,
    id: String,
    input: Status,
) -> Result<Mutation> {
    if !scope.states().contains(&input.status.as_str()) {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx,&actor,&scope,Some("planning.update"))?;
        let old=document(tx,&scope,&id)?;writable(&old,false)?;
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;let status=old["status"].as_str().ok_or(Error::Internal)?;
        let revision=next_revision(previous,input.expected_revision)?;
        if !transition(scope.plan.is_some(),status,&input.status) {return Err(Error::Conflict("invalid_transition"));}
        let now=validation::now();
        tx.execute(&format!("UPDATE {} SET status=?1,completed_at=?2,cancelled_at=?3,revision=?4,updated_at=?5 WHERE id=?6",scope.table()),params![input.status,if input.status=="completed"{Some(&now)}else{None},if input.status=="cancelled"{Some(&now)}else{None},revision,now,id])?;
        audit::mutation(tx,&actor,scope.kind(),&id,Some(&scope.client),"updated",(Some(snapshot(previous,status)), snapshot(revision,&input.status)))?;
        Ok(Mutation{id,revision})
    }).await
}

pub async fn archive(
    db: &Database,
    actor: Actor,
    scope: Scope,
    id: String,
    input: ConfirmRevision,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx, &actor, &scope, Some("planning.archive"))?;
        let old = document(tx, &scope, &id)?;
        writable(&old, false)?;
        let previous = old["revision"].as_i64().ok_or(Error::Internal)?;
        let revision = next_revision(previous, input.expected_revision)?;
        let now = validation::now();
        tx.execute(
            &format!(
                "UPDATE {} SET revision=?1,updated_at=?2,archived_at=?2 WHERE id=?3",
                scope.table()
            ),
            params![revision, now, id],
        )?;
        let status = old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(
            tx,
            &actor,
            scope.kind(),
            &id,
            Some(&scope.client),
            "archived",
            (Some(snapshot(previous, status)), snapshot(revision, status)),
        )?;
        Ok(Mutation { id, revision })
    })
    .await
}

pub async fn links(
    db: &Database,
    actor: Actor,
    scope: Scope,
    id: String,
    query: Query,
) -> Result<Value> {
    if scope.plan.is_none() {
        return Err(Error::NotFound);
    }
    let paging = query.paging()?;
    let archived = query
        .choice("archived", "false", &["false", "true", "all"])?
        .to_owned();
    db.read(move |tx| {
        authorize(tx,&actor,&scope,None)?;document(tx,&scope,&id)?;
        let sql=format!("SELECT id,task_id,linked_at,unlinked_at FROM milestone_task_links WHERE milestone_id=?1 AND (?2 IS NULL OR id {} ?2) AND (?3='all' OR (?3='false' AND unlinked_at IS NULL) OR (?3='true' AND unlinked_at IS NOT NULL)) ORDER BY id {} LIMIT ?4",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![id,paging.cursor,archived,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Links {
    task_ids: Vec<String>,
    expected_revision: i64,
}

pub async fn replace_links(
    db: &Database,
    actor: Actor,
    scope: Scope,
    id: String,
    input: Links,
) -> Result<Mutation> {
    if scope.plan.is_none() || input.task_ids.len() > 50 {
        return Err(Error::Invalid("invalid_request"));
    }
    let mut selected = BTreeSet::new();
    for task in input.task_ids {
        if !selected.insert(validation::id(&task)?) {
            return Err(Error::Invalid("invalid_request"));
        }
    }
    db.write(move |tx| {
        authorize(tx,&actor,&scope,Some("planning.update"))?;
        let old=document(tx,&scope,&id)?;writable(&old,true)?;
        let previous=old["revision"].as_i64().ok_or(Error::Internal)?;let revision=next_revision(previous,input.expected_revision)?;
        let mut statement=tx.prepare("SELECT task_id FROM milestone_task_links WHERE milestone_id=?1 AND unlinked_at IS NULL")?;
        let current=statement.query_map([&id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<BTreeSet<_>,_>>()?;
        let now=validation::now();
        for task in selected.difference(&current) {
            if !security::allowed_user(tx,&actor.user_id,"tasks.view",Some(&scope.client))? {return Err(Error::Invalid("invalid_task_link"));}
            let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM tasks WHERE id=?1 AND client_id=?2 AND archived_at IS NULL)",params![task,scope.client],|r|r.get(0))?;
            if !valid {return Err(Error::Invalid("invalid_task_link"));}
            tx.execute("INSERT INTO milestone_task_links VALUES (?1,?2,?3,?4,?5,?6,NULL)",params![validation::new_id(),id,scope.plan,scope.client,task,now])?;
        }
        for task in current.difference(&selected) {
            tx.execute("UPDATE milestone_task_links SET unlinked_at=?1 WHERE milestone_id=?2 AND task_id=?3 AND unlinked_at IS NULL",params![now,id,task])?;
        }
        tx.execute("UPDATE milestones SET revision=?1,updated_at=?2 WHERE id=?3",params![revision,now,id])?;
        let status=old["status"].as_str().ok_or(Error::Internal)?;
        audit::mutation(tx,&actor,"milestone",&id,Some(&scope.client),"updated",(Some(snapshot(previous,status)), snapshot(revision,status)))?;
        Ok(Mutation{id,revision})
    }).await
}

pub async fn candidates(
    db: &Database,
    actor: Actor,
    client: String,
    plan: String,
    query: Query,
) -> Result<Value> {
    let paging = query.paging()?;
    let search = query.text("q", 100)?;
    db.read(move |tx| {
        let scope=Scope{client,plan:Some(plan)};authorize(tx,&actor,&scope,None)?;
        security::client(tx,&scope.client,true)?;parent(tx,&scope,true)?;
        security::require_any(tx,&actor,&["planning.create","planning.update"],&scope.client).map_err(hidden)?;
        security::require(tx,&actor,"tasks.view",Some(&scope.client)).map_err(hidden)?;
        let sql=format!("SELECT id,title,status FROM tasks WHERE client_id=?1 AND archived_at IS NULL AND (?2 IS NULL OR id {} ?2) AND (?3='' OR instr(unicode_lower(title),unicode_lower(?3))>0) ORDER BY id {} LIMIT ?4",paging.comparison(),paging.order());
        let mut statement=tx.prepare(&sql)?;
        let data=statement.query_map(params![scope.client,paging.cursor,search,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

fn authorize(
    tx: &Transaction<'_>,
    actor: &Actor,
    scope: &Scope,
    write: Option<&str>,
) -> Result<()> {
    security::require(tx, actor, "planning.view", Some(&scope.client)).map_err(hidden)?;
    if let Some(key) = write {
        security::require(tx, actor, key, Some(&scope.client)).map_err(hidden)?;
    }
    security::client(tx, &scope.client, write.is_some())?;
    parent(tx, scope, write.is_some())
}

fn parent(tx: &Transaction<'_>, scope: &Scope, writing: bool) -> Result<()> {
    if let Some(plan) = &scope.plan {
        let (archived, status): (Option<String>, String) = tx.query_row(
            "SELECT archived_at,status FROM plans WHERE id=?1 AND client_id=?2",
            params![plan, scope.client],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if writing && (archived.is_some() || matches!(status.as_str(), "completed" | "cancelled")) {
            return Err(Error::Conflict("conflict"));
        }
    }
    Ok(())
}

fn dates(tx: &Transaction<'_>, scope: &Scope, id: Option<&str>, profile: &Profile) -> Result<()> {
    if let Some(plan) = &scope.plan {
        let (start, due): (Option<String>, Option<String>) = tx.query_row(
            "SELECT start_at,due_at FROM plans WHERE id=?1 AND client_id=?2",
            params![plan, scope.client],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if profile.due.as_ref().is_some_and(|d| {
            start.as_ref().is_some_and(|s| d < s) || due.as_ref().is_some_and(|u| d > u)
        }) {
            return Err(Error::Invalid("invalid_dates"));
        }
    } else if let Some(id) = id {
        let invalid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM milestones WHERE plan_id=?1 AND archived_at IS NULL AND due_at IS NOT NULL AND ((?2 IS NOT NULL AND due_at<?2) OR (?3 IS NOT NULL AND due_at>?3)))",params![id,profile.start,profile.due],|r|r.get(0))?;
        if invalid {
            return Err(Error::Invalid("invalid_dates"));
        }
    }
    Ok(())
}

fn document(tx: &Transaction<'_>, scope: &Scope, id: &str) -> Result<Value> {
    let parent = if scope.plan.is_some() {
        "AND p.plan_id=?3"
    } else {
        "AND ?3 IS NULL"
    };
    let links = if scope.plan.is_some() {
        ",(SELECT coalesce(json_group_array(task_id),'[]') FROM (SELECT task_id FROM milestone_task_links WHERE milestone_id=p.id AND unlinked_at IS NULL ORDER BY task_id)) AS task_ids_json"
    } else {
        ""
    };
    Ok(tx.query_row(
        &format!(
            "SELECT {},p.description {links} FROM {} p WHERE p.id=?1 AND p.client_id=?2 {parent}",
            scope.columns(),
            scope.table()
        ),
        params![id, scope.client, scope.plan],
        row_json,
    )?)
}

fn hidden(error: Error) -> Error {
    match error {
        Error::Denied => Error::NotFound,
        _ => error,
    }
}
fn writable(old: &Value, metadata: bool) -> Result<()> {
    if !old["archived_at"].is_null()
        || (metadata && matches!(old["status"].as_str(), Some("completed" | "cancelled")))
    {
        return Err(Error::Conflict("conflict"));
    }
    Ok(())
}
fn snapshot(revision: i64, status: &str) -> Snapshot {
    Snapshot {
        planning_status: Some(status.into()),
        ..Snapshot::revision(revision)
    }
}

pub fn transition(milestone: bool, from: &str, to: &str) -> bool {
    if milestone {
        match from {
            "planned" => ["in_progress", "completed", "cancelled"].contains(&to),
            "in_progress" => ["planned", "completed", "cancelled"].contains(&to),
            "completed" => to == "in_progress",
            "cancelled" => ["planned", "in_progress"].contains(&to),
            _ => false,
        }
    } else {
        match from {
            "draft" => ["active", "cancelled"].contains(&to),
            "active" => ["draft", "completed", "cancelled"].contains(&to),
            "completed" => to == "active",
            "cancelled" => ["draft", "active"].contains(&to),
            _ => false,
        }
    }
}
