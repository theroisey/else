//! Team hierarchy extends retained role grants, never a parallel authority system.
use super::*;
use crate::{
    audit::{self, Snapshot},
    db::Database,
    query::{Query, row_json},
};
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
const LEADER_ROLE: &str = "00000000-0000-4000-8000-000000000005";
const EMPLOYEE_ROLE: &str = "00000000-0000-4000-8000-000000000006";
const TEAM_ROLE: &str = "00000000-0000-4000-8000-000000000007";
pub async fn people(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let page = q.paging()?;
    let search = q.text("q", 100)?;
    let client = q.get("client_id").map(validation::id).transpose()?;
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        let owner=security::allowed_actor(tx,&actor,"staff.manage",None)?;
        if !owner{security::require(tx,&actor,"staff.read_team",None)?;}
        let mut stmt=tx.prepare("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND (?1 OR EXISTS(SELECT 1 FROM teams t JOIN team_memberships m ON m.team_id=t.id WHERE t.leader_id=?2 AND t.archived_at IS NULL AND m.revoked_at IS NULL AND m.user_id=u.id)) AND (?3 IS NULL OR EXISTS(SELECT 1 FROM brand_staff_assignments b WHERE b.user_id=u.id AND b.client_id=?3 AND b.revoked_at IS NULL)) AND (?4 IS NULL OR u.id>?4) AND instr(unicode_lower(u.display_name),unicode_lower(?5))>0 ORDER BY u.id LIMIT ?6")?;
        page.page(stmt.query_map(params![owner,actor.user_id,client,page.cursor,search,(page.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
fn scope(tx: &Transaction<'_>, actor: &Actor, id: &str, write: bool) -> Result<Value> {
    security::fresh(tx, actor)?;
    let owner = security::allowed_actor(tx, actor, "staff.manage", None)?;
    if !owner {
        security::require(tx, actor, "staff.read_team", None).map_err(hidden)?;
    }
    let v=tx.query_row("SELECT t.id,t.name,t.leader_id,u.display_name AS leader_name,CAST(t.revision AS TEXT) AS revision,t.created_at,t.updated_at,t.archived_at FROM teams t JOIN users u ON u.id=t.leader_id WHERE t.id=?1 AND (?2 OR t.leader_id=?3)",params![id,owner,actor.user_id],row_json)?;
    if write && !v["archived_at"].is_null() {
        return Err(Error::Conflict("conflict"));
    }
    Ok(v)
}
fn active(tx: &Transaction<'_>, user: &str) -> Result<()> {
    if !tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id=?1 AND status='active')",
        [user],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(Error::Invalid("invalid_assignee"));
    }
    Ok(())
}
fn grant(
    tx: &Transaction<'_>,
    actor: &Actor,
    user: &str,
    role: &str,
    client: Option<&str>,
) -> Result<(String, bool)> {
    let old=tx.query_row("SELECT id FROM user_roles WHERE user_id=?1 AND role_id=?2 AND client_id IS ?3 AND revoked_at IS NULL",params![user,role,client],|r|r.get::<_,String>(0)).optional()?;
    if let Some(id) = old {
        return Ok((id, false));
    }
    let id = validation::new_id();
    tx.execute("INSERT INTO user_roles(id,user_id,role_id,scope_kind,client_id,assigned_at) VALUES (?1,?2,?3,?4,?5,?6)",params![id,user,role,if client.is_some(){"client"}else{"global"},client,validation::now()])?;
    audit::mutation(
        tx,
        actor,
        "role_assignment",
        &id,
        client,
        "created",
        (
            None,
            Snapshot {
                exists: Some(true),
                ..Snapshot::default()
            },
        ),
    )?;
    Ok((id, true))
}
fn bump(tx: &Transaction<'_>, actor: &Actor, team: &Value, expected: &str) -> Result<String> {
    let old = team["revision"].as_str().ok_or(Error::Internal)?;
    if old != expected {
        return Err(Error::Conflict("conflict"));
    }
    let previous = validation::exact_integer(old, true)?;
    let next = previous.checked_add(1).ok_or(Error::Internal)?;
    let id = team["id"].as_str().ok_or(Error::Internal)?;
    tx.execute(
        "UPDATE teams SET revision=?1,updated_at=?2 WHERE id=?3",
        params![next, validation::now(), id],
    )?;
    audit::mutation(
        tx,
        actor,
        "team",
        id,
        None,
        "updated",
        (Some(Snapshot::revision(previous)), Snapshot::revision(next)),
    )?;
    Ok(next.to_string())
}
pub async fn list(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let paging = q.paging()?;
    db.read(move|tx|{
  security::fresh(tx,&actor)?;
  let owner=security::allowed_actor(tx,&actor,"staff.manage",None)?;
  if !owner{security::require(tx,&actor,"staff.read_team",None)?;}
  let mut stmt=tx.prepare("SELECT t.id,t.name,t.leader_id,u.display_name AS leader_name,CAST(t.revision AS TEXT) AS revision,t.created_at,t.updated_at,t.archived_at FROM teams t JOIN users u ON u.id=t.leader_id WHERE t.archived_at IS NULL AND (?1 OR t.leader_id=?2) AND (?3 IS NULL OR t.id>?3) ORDER BY t.id LIMIT ?4")?;
  paging.page(stmt.query_map(params![owner,actor.user_id,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
 }).await
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub id: String,
    pub name: String,
    pub leader_id: String,
}
pub async fn create(db: &Database, actor: Actor, input: Create) -> Result<Value> {
    validation::id(&input.id)?;
    validation::id(&input.leader_id)?;
    let name = validation::text(&input.name, 100, true, false)?;
    db.write(move |tx| {
        security::require(tx, &actor, "staff.manage", None)?;
        active(tx, &input.leader_id)?;
        if let Some(old) = tx
            .query_row(
                "SELECT name,leader_id FROM teams WHERE id=?1",
                [&input.id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if old != (name, input.leader_id) {
                return Err(Error::Conflict("command_conflict"));
            }
            return scope(tx, &actor, &input.id, false);
        }
        grant(tx, &actor, &input.leader_id, TEAM_ROLE, None)?;
        let now = validation::now();
        tx.execute(
            "INSERT INTO teams(id,name,leader_id,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
            params![input.id, name, input.leader_id, now],
        )?;
        tx.execute("INSERT INTO team_leadership_history(id,team_id,leader_id,actor_id,revision,created_at) VALUES (?1,?2,?3,?4,1,?5)",params![validation::new_id(),input.id,input.leader_id,actor.user_id,now])?;
        audit::mutation(
            tx,
            &actor,
            "team",
            &input.id,
            None,
            "created",
            (None, Snapshot::revision(1)),
        )?;
        scope(tx, &actor, &input.id, false)
    })
    .await
}
pub async fn read(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move |tx| scope(tx, &actor, &id, false)).await
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub expected_revision: String,
    pub name: String,
    pub leader_id: String,
    pub archived: bool,
}
pub async fn update(db: &Database, actor: Actor, id: String, input: Profile) -> Result<Value> {
    let name = validation::text(&input.name, 100, true, false)?;
    validation::id(&input.leader_id)?;
    db.write(move|tx|{
  security::require(tx,&actor,"staff.manage",None)?;
  let old=scope(tx,&actor,&id,true)?;
  if !input.archived{active(tx,&input.leader_id)?;}else if old["leader_id"]!=input.leader_id{return Err(Error::Invalid("invalid_request"))}
  if old["leader_id"]!=input.leader_id {
    let mut stmt=tx.prepare("SELECT id FROM brand_staff_assignments WHERE team_id=?1 AND user_id=?2 AND revoked_at IS NULL LIMIT 501")?;
    let ids=stmt.query_map(params![id,old["leader_id"].as_str().ok_or(Error::Internal)?],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
    if ids.len()>500{return Err(Error::Conflict("team_too_large"))}
    for aid in ids{revoke_assignment(tx,&actor,&aid)?;}
  }
  if input.archived {
   let mut stmt=tx.prepare("SELECT id FROM brand_staff_assignments WHERE team_id=?1 AND revoked_at IS NULL LIMIT 501")?;
   let ids=stmt.query_map([&id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
   if ids.len()>500{return Err(Error::Conflict("team_too_large"))}
   for assignment in ids{revoke_assignment(tx,&actor,&assignment)?;}
   tx.execute("UPDATE team_memberships SET revoked_at=?1 WHERE team_id=?2 AND revoked_at IS NULL",params![validation::now(),id])?;
  }else{grant(tx,&actor,&input.leader_id,TEAM_ROLE,None)?;}
  let revision=bump(tx,&actor,&old,&input.expected_revision)?;
  if old["leader_id"]!=input.leader_id {tx.execute("INSERT INTO team_leadership_history(id,team_id,previous_leader_id,leader_id,actor_id,revision,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",params![validation::new_id(),id,old["leader_id"].as_str().ok_or(Error::Internal)?,input.leader_id,actor.user_id,validation::exact_integer(&revision,true)?,validation::now()])?;}
  tx.execute("UPDATE teams SET name=?1,leader_id=?2,archived_at=?3 WHERE id=?4",params![name,input.leader_id,if input.archived{Some(validation::now())}else{None},id])?;
  // Changing leader removes managed brand access; independent grants remain owner-controlled.
  scope(tx,&actor,&id,false)
 }).await
}
pub async fn members(db: &Database, actor: Actor, id: String, q: Query) -> Result<Value> {
    let paging = q.paging()?;
    db.read(move|tx|{
  scope(tx,&actor,&id,false)?;
  let visible=crate::mcp::access::predicate(&actor,"clients:read","b.client_id",grant_sql("?1","clients.view","b.client_id"))?;
  let work=crate::mcp::access::predicate(&actor,"tasks:read","t.client_id",super::today::task_visibility("?1"))?;
  let mut stmt=tx.prepare(&format!("SELECT m.id,m.team_id,m.user_id,u.display_name,u.status,m.assigned_at,m.revoked_at,CAST((SELECT count(*) FROM brand_staff_assignments b WHERE b.team_id=m.team_id AND b.user_id=m.user_id AND b.revoked_at IS NULL AND {visible}) AS TEXT) AS brands,CAST((SELECT count(*) FROM tasks t WHERE t.assignee_id=m.user_id AND t.archived_at IS NULL AND t.status NOT IN ('done','cancelled') AND {work}) AS TEXT) AS active_tasks FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=?2 AND m.revoked_at IS NULL AND (?3 IS NULL OR m.id>?3) ORDER BY m.id LIMIT ?4"))?;
  paging.page(stmt.query_map(params![actor.user_id,id,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
 }).await
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Membership {
    pub user_id: String,
    pub active: bool,
    pub expected_revision: String,
}
pub async fn membership(
    db: &Database,
    actor: Actor,
    id: String,
    input: Membership,
) -> Result<Value> {
    validation::id(&input.user_id)?;
    db.write(move|tx|{
  security::require(tx,&actor,"staff.manage",None)?;
  let team=scope(tx,&actor,&id,true)?;bump(tx,&actor,&team,&input.expected_revision)?;
  if input.active{
   active(tx,&input.user_id)?;
   let exists=tx.query_row("SELECT EXISTS(SELECT 1 FROM team_memberships WHERE team_id=?1 AND user_id=?2 AND revoked_at IS NULL)",params![id,input.user_id],|r|r.get::<_,bool>(0))?;
   if !exists{let mid=validation::new_id();tx.execute("INSERT INTO team_memberships(id,team_id,user_id,assigned_at) VALUES (?1,?2,?3,?4)",params![mid,id,input.user_id,validation::now()])?;audit::mutation(tx,&actor,"team_membership",&mid,None,"created",(None,Snapshot::revision(1)))?;}
  }else{
   let mut stmt=tx.prepare("SELECT id FROM brand_staff_assignments WHERE team_id=?1 AND user_id=?2 AND revoked_at IS NULL LIMIT 501")?;
   let ids=stmt.query_map(params![id,input.user_id],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
   if ids.len()>500{return Err(Error::Conflict("team_too_large"))}
   for assignment in ids{revoke_assignment(tx,&actor,&assignment)?;}
   let membership=tx.query_row("SELECT id FROM team_memberships WHERE team_id=?1 AND user_id=?2 AND revoked_at IS NULL",params![id,input.user_id],|r|r.get::<_,String>(0)).optional()?;
   if let Some(mid)=membership{tx.execute("UPDATE team_memberships SET revoked_at=?1 WHERE id=?2",params![validation::now(),mid])?;audit::mutation(tx,&actor,"team_membership",&mid,None,"archived",(Some(Snapshot::revision(1)),Snapshot::revision(2)))?;}
  }
  scope(tx,&actor,&id,false)
 }).await
}
fn revoke_assignment(tx: &Transaction<'_>, actor: &Actor, id: &str) -> Result<()> {
    let (client,user,grant,owns):(String,String,String,bool)=tx.query_row("SELECT client_id,user_id,user_role_id,owns_role FROM brand_staff_assignments WHERE id=?1 AND revoked_at IS NULL",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let now = validation::now();
    tx.execute(
        "UPDATE brand_staff_assignments SET revoked_at=?1 WHERE id=?2",
        params![now, id],
    )?;
    if owns {
        let changed = tx.execute(
            "UPDATE user_roles SET revoked_at=?1 WHERE id=?2 AND revoked_at IS NULL",
            params![now, grant],
        )?;
        if changed > 0 {
            audit::mutation(
                tx,
                actor,
                "role_assignment",
                &grant,
                Some(&client),
                "archived",
                (Some(Snapshot::revision(1)), Snapshot::revision(2)),
            )?;
        }
    }
    if !security::allowed_user(tx, &user, "tasks.view", Some(&client))?
        && !security::allowed_user(tx, &user, "tasks.read_own", Some(&client))?
        && !security::allowed_user(tx, &user, "tasks.read_team", Some(&client))?
        && !security::allowed_user(tx, &user, "tasks.read_development", Some(&client))?
    {
        let mut stmt=tx.prepare("SELECT id,revision FROM tasks WHERE client_id=?1 AND assignee_id=?2 AND archived_at IS NULL AND status NOT IN ('done','cancelled') AND NOT EXISTS(SELECT 1 FROM technical_requests r WHERE r.task_id=tasks.id) LIMIT 501")?;
        let tasks = stmt
            .query_map(params![client, user], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if tasks.len() > 500 {
            return Err(Error::Conflict("team_too_large"));
        }
        for (task, revision) in tasks {
            let next = revision.checked_add(1).ok_or(Error::Internal)?;
            tx.execute(
                "UPDATE tasks SET assignee_id=NULL,revision=?1,updated_at=?2 WHERE id=?3",
                params![next, now, task],
            )?;
            audit::mutation(
                tx,
                actor,
                "task",
                &task,
                Some(&client),
                "updated",
                (Some(Snapshot::revision(revision)), Snapshot::revision(next)),
            )?;
        }
    }
    audit::mutation(
        tx,
        actor,
        "brand_assignment",
        id,
        Some(&client),
        "archived",
        (Some(Snapshot::revision(1)), Snapshot::revision(2)),
    )?;
    Ok(())
}
pub async fn assignments(db: &Database, actor: Actor, id: String, q: Query) -> Result<Value> {
    let paging = q.paging()?;
    db.read(move|tx|{scope(tx,&actor,&id,false)?;
  let allowed=crate::mcp::access::predicate(&actor,"clients:read","b.client_id",grant_sql("?1","clients.view","b.client_id"))?;
  let mut stmt=tx.prepare(&format!("SELECT b.id,b.team_id,b.client_id,c.name AS brand_name,b.user_id,u.display_name,b.responsibility,b.assigned_at,b.revoked_at FROM brand_staff_assignments b JOIN clients c ON c.id=b.client_id JOIN users u ON u.id=b.user_id WHERE b.team_id=?2 AND b.revoked_at IS NULL AND {allowed} AND (?3 IS NULL OR b.id>?3) ORDER BY b.id LIMIT ?4"))?;
  paging.page(stmt.query_map(params![actor.user_id,id,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
 }).await
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Assignment {
    pub client_id: String,
    pub user_id: String,
    pub responsibility: String,
    pub active: bool,
    pub expected_revision: String,
}
pub async fn assign(db: &Database, actor: Actor, id: String, input: Assignment) -> Result<Value> {
    validation::id(&input.client_id)?;
    validation::id(&input.user_id)?;
    let responsibility = validation::text(&input.responsibility, 300, false, false)?;
    db.write(move|tx|{
  let team=scope(tx,&actor,&id,true)?;
  require(tx,&actor,"staff.assign_brands",&input.client_id,true)?;
  if !security::allowed_actor(tx,&actor,"staff.manage",None)? && team["leader_id"]!=actor.user_id{return Err(Error::NotFound)}
  bump(tx,&actor,&team,&input.expected_revision)?;
  if input.active{
   active(tx,&input.user_id)?;
   let leader=team["leader_id"]==input.user_id;
   if !leader&&!tx.query_row("SELECT EXISTS(SELECT 1 FROM team_memberships WHERE team_id=?1 AND user_id=?2 AND revoked_at IS NULL)",params![id,input.user_id],|r|r.get::<_,bool>(0))?{return Err(Error::NotFound)}
   if let Some((aid,team))=tx.query_row("SELECT id,team_id FROM brand_staff_assignments WHERE client_id=?1 AND user_id=?2 AND revoked_at IS NULL",params![input.client_id,input.user_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?{
    if team!=id{return Err(Error::Conflict("assignment_conflict"))}
    let previous:String=tx.query_row("SELECT responsibility FROM brand_staff_assignments WHERE id=?1",[&aid],|r|r.get(0))?;
    if previous!=responsibility{return Err(Error::Conflict("assignment_conflict"))}
   }else{
    let (rid,owns)=grant(tx,&actor,&input.user_id,if leader{LEADER_ROLE}else{EMPLOYEE_ROLE},Some(&input.client_id))?;
    let aid=validation::new_id();tx.execute("INSERT INTO brand_staff_assignments(id,client_id,user_id,team_id,user_role_id,owns_role,responsibility,assigned_by,assigned_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![aid,input.client_id,input.user_id,id,rid,owns,responsibility,actor.user_id,validation::now()])?;
    audit::mutation(tx,&actor,"brand_assignment",&aid,Some(&input.client_id),"created",(None,Snapshot::revision(1)))?;
   }
  }else{
   let aid=tx.query_row("SELECT id FROM brand_staff_assignments WHERE client_id=?1 AND user_id=?2 AND team_id=?3 AND revoked_at IS NULL",params![input.client_id,input.user_id,id],|r|r.get::<_,String>(0)).optional()?;
   if let Some(aid)=aid{revoke_assignment(tx,&actor,&aid)?;}
  }
  scope(tx,&actor,&id,false)
 }).await
}
pub async fn directory(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let paging = q.paging()?;
    let search = q.text("q", 100)?;
    db.read(move|tx|{
  security::require(tx,&actor,"staff.manage",None)?;
  let mut stmt=tx.prepare("SELECT id,display_name,status FROM users WHERE status='active' AND instr(lower(display_name),lower(?1))>0 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3")?;
  paging.page(stmt.query_map(params![search,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
 }).await
}

pub async fn leadership_history(
    db: &Database,
    actor: Actor,
    id: String,
    q: Query,
) -> Result<Value> {
    let limit = q.paging()?.limit;
    let before = q
        .get("before")
        .map(|v| validation::exact_integer(v, true))
        .transpose()?
        .unwrap_or(i64::MAX);
    db.read(move|tx|{scope(tx,&actor,&id,false)?;
  let mut stmt=tx.prepare("SELECT h.id,h.team_id,CAST(h.revision AS TEXT) AS revision,h.previous_leader_id,old.display_name AS previous_leader_name,h.leader_id,u.display_name AS leader_name,h.actor_id,a.display_name AS actor_name,h.created_at FROM team_leadership_history h JOIN users u ON u.id=h.leader_id JOIN users a ON a.id=h.actor_id LEFT JOIN users old ON old.id=h.previous_leader_id WHERE h.team_id=?1 AND h.revision<?2 ORDER BY h.revision DESC LIMIT ?3")?;
  let mut items=stmt.query_map(params![id,before,(limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
  let more=items.len()>limit;items.truncate(limit);
  let next=if more{items.last().and_then(|v|v["revision"].as_str()).map(str::to_owned)}else{None};
  Ok(serde_json::json!({"data":items,"page":{"limit":limit,"next_before":next}}))
 }).await
}
