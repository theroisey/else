//! Versioned recurring templates generate the existing task model once per local date.
use super::*;
use crate::{
    audit::{self, Snapshot},
    db::Database,
    query::{Query, next_revision, row_json},
    tasks,
};
use chrono::Datelike;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
const COLUMNS: &str = "r.id,r.client_id,r.created_by,r.managed_by,u.display_name AS manager_name,r.status,r.next_date,CAST(r.revision AS TEXT) AS revision,CAST(r.generated_count AS TEXT) AS generated_count,CAST(r.current_version AS TEXT) AS current_version,r.created_at,r.updated_at,(SELECT json_object('error_code',f.error_code,'failed_at',f.failed_at,'retry_after',f.retry_after) FROM automation_failures f WHERE f.kind='task' AND f.resource_id=r.id) AS automation_failure_json,v.title,v.description,v.priority,v.website_id,w.name AS website_name,v.assignee_id,a.display_name AS assignee_name,v.supervisor_id,s.display_name AS supervisor_name,v.start_date,v.end_date,v.frequency,v.interval,v.anchor_day,v.due_time,v.timezone,v.occurrence_limit";
const JOIN: &str = "FROM recurring_tasks r JOIN recurring_task_versions v ON v.template_id=r.id AND v.number=r.current_version JOIN users u ON u.id=r.managed_by JOIN users a ON a.id=v.assignee_id LEFT JOIN users s ON s.id=v.supervisor_id LEFT JOIN client_websites w ON w.id=v.website_id";
fn authorize(tx: &Transaction<'_>, actor: &Actor, client: &str, write: bool) -> Result<()> {
    require(
        tx,
        actor,
        if write {
            "recurring.manage"
        } else {
            "recurring.view"
        },
        client,
        false,
    )
}
pub async fn supervisors(db: &Database, actor: Actor, client: String, q: Query) -> Result<Value> {
    let page = q.paging()?;
    let assignee = validation::id(q.get("assignee").ok_or(Error::Invalid("invalid_request"))?)?;
    db.read(move|tx|{
        require(tx,&actor,"recurring.manage",&client,false)?;
        tasks::assignment_scope(tx,&actor,&client,Some(&assignee))?;
        let readable=grant_sql("u.id","tasks.read_team","?1");let brand=grant_sql("u.id","clients.view","?1");
        let mut stmt=tx.prepare(&format!("SELECT DISTINCT u.id,u.display_name FROM users u JOIN teams t ON t.leader_id=u.id JOIN team_memberships m ON m.team_id=t.id JOIN brand_staff_assignments b ON b.team_id=t.id AND b.user_id=m.user_id WHERE u.status='active' AND t.archived_at IS NULL AND m.revoked_at IS NULL AND b.revoked_at IS NULL AND b.client_id=?1 AND m.user_id=?2 AND {readable} AND {brand} AND (?3 IS NULL OR u.id>?3) ORDER BY u.id LIMIT ?4"))?;
        page.page(stmt.query_map(params![client,assignee,page.cursor,(page.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub priority: String,
    pub website_id: Option<String>,
    pub assignee_id: String,
    pub supervisor_id: Option<String>,
    pub start_date: String,
    pub end_date: Option<String>,
    pub frequency: String,
    pub interval: u32,
    pub due_time: String,
    pub timezone: Option<String>,
    pub occurrence_limit: Option<i64>,
}
impl Profile {
    fn normalize(&mut self) -> Result<()> {
        self.title = validation::text(&self.title, 200, true, false)?;
        self.description = validation::text(&self.description, 8000, false, true)?;
        self.website_id = self
            .website_id
            .take()
            .map(|v| validation::id(&v))
            .transpose()?;
        self.assignee_id = validation::id(&self.assignee_id)?;
        self.supervisor_id = self
            .supervisor_id
            .take()
            .map(|v| validation::id(&v))
            .transpose()?;
        schedule::date(&self.start_date)?;
        self.end_date = self
            .end_date
            .take()
            .map(|v| validation::date(&v))
            .transpose()?;
        if !["low", "medium", "high", "urgent"].contains(&self.priority.as_str())
            || !["daily", "weekly", "monthly"].contains(&self.frequency.as_str())
            || !(1..=365).contains(&self.interval)
            || self
                .occurrence_limit
                .is_some_and(|v| !(1..=100000).contains(&v))
            || self.end_date.as_ref().is_some_and(|v| v < &self.start_date)
        {
            return Err(Error::Invalid("invalid_schedule"));
        }
        if self.due_time.len() != 5
            || chrono::NaiveTime::parse_from_str(&self.due_time, "%H:%M").is_err()
        {
            return Err(Error::Invalid("invalid_schedule"));
        }
        if let Some(zone) = &self.timezone {
            schedule::zone(zone)?;
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub command_id: String,
    pub profile: Profile,
}
fn insert_version(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    number: i64,
    p: &Profile,
    prospective: bool,
) -> Result<()> {
    security::require_any(tx, actor, &["tasks.create", "tasks.manage"], client)?;
    tasks::assignment_scope(tx, actor, client, Some(&p.assignee_id))?;
    let mut eligible = false;
    for key in tasks::READ_KEYS {
        eligible |= security::allowed_user(tx, &p.assignee_id, key, Some(client))?;
    }
    if !eligible {
        return Err(Error::Invalid("invalid_assignee"));
    }
    website(tx, client, p.website_id.as_deref())?;
    if let Some(supervisor) = &p.supervisor_id {
        let allowed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM teams tm JOIN team_memberships m ON m.team_id=tm.id JOIN brand_staff_assignments b ON b.team_id=tm.id AND b.user_id=m.user_id AND b.revoked_at IS NULL WHERE tm.leader_id=?1 AND tm.archived_at IS NULL AND m.user_id=?2 AND m.revoked_at IS NULL AND b.client_id=?3)",params![supervisor,p.assignee_id,client],|r|r.get(0))?;
        if !allowed || !security::allowed_user(tx, supervisor, "tasks.read_team", Some(client))? {
            return Err(Error::Invalid("invalid_supervisor"));
        }
    }
    let timezone = match &p.timezone {
        Some(v) => v.clone(),
        None => tx.query_row(
            "SELECT timezone FROM operation_settings WHERE id=1",
            [],
            |r| r.get(0),
        )?,
    };
    let start = schedule::date(&p.start_date)?;
    let today = schedule::today(&timezone)?;
    if start < today || (prospective && start == today) {
        return Err(Error::Invalid("future_schedule_required"));
    }
    tx.execute("INSERT INTO recurring_task_versions(id,template_id,client_id,number,title,description,priority,website_id,assignee_id,supervisor_id,start_date,end_date,frequency,interval,anchor_day,due_time,timezone,occurrence_limit,created_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",params![validation::new_id(),id,client,number,p.title,p.description,p.priority,p.website_id,p.assignee_id,p.supervisor_id,p.start_date,p.end_date,p.frequency,p.interval,start.day(),p.due_time,timezone,p.occurrence_limit,actor.user_id,validation::now()])?;
    Ok(())
}
fn audit_change(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    old: Option<i64>,
    next: i64,
) -> Result<()> {
    audit::mutation(
        tx,
        actor,
        "recurring_task",
        id,
        Some(client),
        if old.is_some() { "updated" } else { "created" },
        (old.map(Snapshot::revision), Snapshot::revision(next)),
    )
}
pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    mut input: Create,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    input.profile.normalize()?;
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;
        if let Some((id,user,old))=tx.query_row("SELECT id,created_by,command_hash FROM recurring_tasks WHERE client_id=?1 AND command_id=?2",params![client,input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?{
            if user!=actor.user_id||old!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":id,"replayed":true}));
        }
        security::client(tx,&client,true)?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO recurring_tasks(id,client_id,created_by,managed_by,next_date,status,command_id,command_hash,created_at,updated_at) VALUES (?1,?2,?3,?3,?4,'active',?5,?6,?7,?7)",params![id,client,actor.user_id,input.profile.start_date,input.command_id,digest,now])?;
        insert_version(tx,&actor,&client,&id,1,&input.profile,false)?;audit_change(tx,&actor,&client,&id,None,1)?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
}
fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(
        &format!("SELECT {COLUMNS} {JOIN} WHERE r.id=?1 AND r.client_id=?2"),
        params![id, client],
        row_json,
    )?)
}
pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, false)?;
        document(tx, &client, &id)
    })
    .await
}
pub async fn list(db: &Database, actor: Actor, client: String, q: Query) -> Result<Value> {
    let page = q.paging()?;
    let status = q
        .choice(
            "status",
            "all",
            &["all", "active", "paused", "cancelled", "expired"],
        )?
        .to_owned();
    db.read(move|tx|{authorize(tx,&actor,&client,false)?;
        let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} {JOIN} WHERE r.client_id=?1 AND (?2 IS NULL OR r.id>?2) AND (?3='all' OR r.status=?3) ORDER BY r.id LIMIT ?4"))?;
        page.page(stmt.query_map(params![client,page.cursor,status,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub command_id: String,
    pub expected_revision: String,
    pub status: Option<String>,
    pub managed_by: Option<String>,
    pub profile: Option<Profile>,
}
pub async fn change(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    mut input: Change,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    input.managed_by = input.managed_by.map(|v| validation::id(&v)).transpose()?;
    if let Some(profile) = &mut input.profile {
        profile.normalize()?;
    }
    if (input.status.is_some() as u8
        + input.managed_by.is_some() as u8
        + input.profile.is_some() as u8)
        != 1
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;let old=document(tx,&client,&id)?;
        if let Some((user,hash))=tx.query_row("SELECT actor_id,payload_hash FROM recurring_task_commands WHERE template_id=?1 AND command_id=?2",params![id,input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?{
            if user!=actor.user_id||hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":id,"replayed":true}));
        }
        security::client(tx,&client,true)?;
        let previous=validation::exact_integer(old["revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(previous,expected)?;
        if matches!(old["status"].as_str(),Some("cancelled"|"expired")){return Err(Error::Conflict("schedule_closed"))}
        if let Some(manager)=&input.managed_by{
            if !security::allowed_user(tx,manager,"recurring.manage",Some(&client))?||!security::allowed_user(tx,manager,"clients.view",Some(&client))?||!(security::allowed_user(tx,manager,"tasks.create",Some(&client))?||security::allowed_user(tx,manager,"tasks.manage",Some(&client))?){return Err(Error::Invalid("invalid_manager"))}
            let manager_actor=Actor::job(manager.clone())?;
            tasks::assignment_scope(tx,&manager_actor,&client,old["assignee_id"].as_str()).map_err(|error|if matches!(error,Error::Denied|Error::NotFound){Error::Invalid("invalid_manager")}else{error})?;
            tx.execute("UPDATE recurring_tasks SET managed_by=?1 WHERE id=?2",params![manager,id])?;
        }
        if let Some(profile)=&input.profile{
            let number=validation::exact_integer(old["current_version"].as_str().ok_or(Error::Internal)?,true)?.checked_add(1).ok_or(Error::Internal)?;
            if profile.occurrence_limit.is_some_and(|v|old["generated_count"].as_str().and_then(|v|v.parse::<i64>().ok()).is_some_and(|count|count>=v)){return Err(Error::Invalid("invalid_schedule"))}
            insert_version(tx,&actor,&client,&id,number,profile,true)?;
            tx.execute("UPDATE recurring_tasks SET current_version=?1,next_date=?2 WHERE id=?3",params![number,profile.start_date,id])?;
        }
        if let Some(status)=&input.status{
            if !["active","paused","cancelled"].contains(&status.as_str())||old["status"]==*status{return Err(Error::Invalid("invalid_transition"))}
            let next_date=if status=="active"{
                schedule::on_or_after(schedule::date(old["next_date"].as_str().ok_or(Error::Internal)?)?,schedule::today(old["timezone"].as_str().ok_or(Error::Internal)?)?,old["frequency"].as_str().ok_or(Error::Internal)?,old["interval"].as_u64().ok_or(Error::Internal)? as u32,old["anchor_day"].as_u64().ok_or(Error::Internal)? as u32)?.to_string()
            }else{old["next_date"].as_str().ok_or(Error::Internal)?.to_owned()};
            if status=="active"&&old["end_date"].as_str().is_some_and(|end|end<next_date.as_str()){return Err(Error::Conflict("schedule_expired"))}
            tx.execute("UPDATE recurring_tasks SET status=?1,next_date=?2 WHERE id=?3",params![status,next_date,id])?;
        }
        tx.execute("UPDATE recurring_tasks SET revision=?1,updated_at=?2 WHERE id=?3",params![next,validation::now(),id])?;
        tx.execute("INSERT INTO recurring_task_commands VALUES (?1,?2,?3,?4,?5)",params![id,input.command_id,actor.user_id,digest,validation::now()])?;
        tx.execute("DELETE FROM automation_failures WHERE kind='task' AND resource_id=?1",[&id])?;
        audit_change(tx,&actor,&client,&id,Some(previous),next)?;Ok(json!({"id":id,"replayed":false}))
    }).await
}
pub(crate) fn generate_in_transaction(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    date: &str,
) -> Result<Value> {
    let timezone:String=tx.query_row("SELECT v.timezone FROM recurring_tasks r JOIN recurring_task_versions v ON v.template_id=r.id AND v.number=r.current_version WHERE r.id=?1 AND r.client_id=?2",params![id,client],|r|r.get(0))?;
    generate_at(tx, actor, client, id, date, schedule::today(&timezone)?)
}
fn generate_at(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    date: &str,
    today: chrono::NaiveDate,
) -> Result<Value> {
    authorize(tx, actor, client, true)?;
    let template = document(tx, client, id)?;
    if let Some(task)=tx.query_row("SELECT task_id FROM recurring_task_occurrences WHERE template_id=?1 AND scheduled_date=?2",params![id,date],|r|r.get::<_,String>(0)).optional()? {return Ok(json!({"id":task,"replayed":true}))}
    security::client(tx, client, true)?;
    let at = schedule::date(date)?;
    let count = validation::exact_integer(
        template["generated_count"]
            .as_str()
            .ok_or(Error::Internal)?,
        false,
    )?;
    if template["status"] != "active"
        || template["next_date"] != date
        || at > today
        || (today - at).num_days() > 62
        || template["end_date"].as_str().is_some_and(|v| v < date)
        || template["occurrence_limit"]
            .as_i64()
            .is_some_and(|limit| count >= limit)
    {
        return Err(Error::Conflict("occurrence_not_due"));
    }
    website(tx, client, template["website_id"].as_str())?;
    let due = schedule::due(
        at,
        template["due_time"].as_str().ok_or(Error::Internal)?,
        template["timezone"].as_str().ok_or(Error::Internal)?,
    )?;
    let profile=validation::json(&serde_json::to_vec(&json!({"title":template["title"],"description":template["description"],"priority":template["priority"],"assignee_id":template["assignee_id"],"due_at":due,"status":"todo"})).map_err(|_|Error::Internal)?)?;
    let task = tasks::create_in_transaction(tx, actor, client, profile)?;
    let version: String = tx.query_row(
        "SELECT id FROM recurring_task_versions WHERE template_id=?1 AND number=?2",
        params![id, template["current_version"].as_str()],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO recurring_task_occurrences VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            validation::new_id(),
            id,
            client,
            version,
            task.id,
            date,
            validation::now()
        ],
    )?;
    let next_date = schedule::next(
        at,
        template["frequency"].as_str().ok_or(Error::Internal)?,
        template["interval"].as_u64().ok_or(Error::Internal)? as u32,
        template["anchor_day"].as_u64().ok_or(Error::Internal)? as u32,
    )?
    .to_string();
    validation::date(&next_date)?;
    let new_count = count.checked_add(1).ok_or(Error::Internal)?;
    let state = if template["end_date"]
        .as_str()
        .is_some_and(|v| v < next_date.as_str())
        || template["occurrence_limit"]
            .as_i64()
            .is_some_and(|limit| new_count >= limit)
    {
        "expired"
    } else {
        "active"
    };
    let previous =
        validation::exact_integer(template["revision"].as_str().ok_or(Error::Internal)?, true)?;
    let next = previous.checked_add(1).ok_or(Error::Internal)?;
    tx.execute("UPDATE recurring_tasks SET next_date=?1,status=?2,generated_count=?3,revision=?4,updated_at=?5 WHERE id=?6",params![next_date,state,new_count,next,validation::now(),id])?;
    notifications::emit_task(
        tx,
        &task.id,
        "recurring_generated",
        &format!("occurrence:{id}:{date}"),
        false,
    )?;
    audit_change(tx, actor, client, id, Some(previous), next)?;
    Ok(json!({"id":task.id,"replayed":false}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generate {
    pub scheduled_date: String,
}
pub async fn generate(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: Generate,
) -> Result<Value> {
    validation::date(&input.scheduled_date)?;
    db.write(move |tx| generate_in_transaction(tx, &actor, &client, &id, &input.scheduled_date))
        .await
}
pub async fn occurrences(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    q: Query,
) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{authorize(tx,&actor,&client,false)?;document(tx,&client,&id)?;
        let mut stmt=tx.prepare("SELECT o.id,o.template_id,o.client_id,o.version_id,o.task_id,o.scheduled_date,o.created_at,t.title,t.status,t.due_at,u.display_name AS assignee_name FROM recurring_task_occurrences o JOIN tasks t ON t.id=o.task_id LEFT JOIN users u ON u.id=t.assignee_id WHERE o.template_id=?1 AND (?2 IS NULL OR o.id>?2) ORDER BY o.id LIMIT ?3")?;
        page.page(stmt.query_map(params![id,page.cursor,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}

pub async fn versions(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    q: Query,
) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{
        authorize(tx,&actor,&client,false)?;document(tx,&client,&id)?;
        let mut stmt=tx.prepare("SELECT v.id,v.template_id,v.client_id,CAST(v.number AS TEXT) AS number,v.title,v.description,v.priority,v.website_id,w.name AS website_name,v.assignee_id,a.display_name AS assignee_name,v.supervisor_id,s.display_name AS supervisor_name,v.start_date,v.end_date,v.frequency,v.interval,v.anchor_day,v.due_time,v.timezone,v.occurrence_limit,v.created_at FROM recurring_task_versions v JOIN users a ON a.id=v.assignee_id LEFT JOIN users s ON s.id=v.supervisor_id LEFT JOIN client_websites w ON w.id=v.website_id WHERE v.template_id=?1 AND (?2 IS NULL OR v.id>?2) ORDER BY v.id LIMIT ?3")?;
        page.page(stmt.query_map(params![id,page.cursor,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
        validation::json(&serde_json::to_vec(&v).unwrap()).unwrap()
    }
    fn profile(f: &Fixture, frequency: &str, start: &str) -> Profile {
        input(
            json!({"title":"Synthetic recurring work","description":"Synthetic recurring task","priority":"medium","assignee_id":f.actor.user_id,"start_date":start,"frequency":frequency,"interval":1,"due_time":"17:00","timezone":"Europe/Bucharest"}),
        )
    }
    #[tokio::test]
    async fn daily_weekly_monthly_instances_are_idempotent_and_keep_original_month_end_anchor() {
        let f = Fixture::new().await;
        let year = schedule::today("Europe/Bucharest").unwrap().year() + 1;
        for (frequency, dates) in [
            (
                "daily",
                vec![
                    format!("{year}-01-31"),
                    format!("{year}-02-01"),
                    format!("{year}-02-02"),
                ],
            ),
            (
                "weekly",
                vec![
                    format!("{year}-01-31"),
                    format!("{year}-02-07"),
                    format!("{year}-02-14"),
                ],
            ),
            (
                "monthly",
                vec![
                    format!("{year}-01-31"),
                    format!(
                        "{year}-02-{}",
                        if chrono::NaiveDate::from_ymd_opt(year, 2, 29).is_some() {
                            29
                        } else {
                            28
                        }
                    ),
                    format!("{year}-03-31"),
                ],
            ),
        ] {
            let c = create(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                Create {
                    command_id: validation::new_id(),
                    profile: profile(&f, frequency, &dates[0]),
                },
            )
            .await
            .unwrap();
            let id = c["id"].as_str().unwrap().to_owned();
            for date in dates {
                let actor = f.actor.clone();
                let client = f.client.clone();
                let template = id.clone();
                let today = schedule::date(&date).unwrap();
                let task =
                    f.db.write(move |tx| {
                        let first = generate_at(tx, &actor, &client, &template, &date, today)?;
                        let second = generate_at(tx, &actor, &client, &template, &date, today)?;
                        assert_eq!(first["id"], second["id"]);
                        assert_eq!(second["replayed"], true);
                        Ok(first["id"].as_str().unwrap().to_owned())
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    tasks::read(&f.db, f.actor.clone(), f.client.clone(), task)
                        .await
                        .unwrap()["status"],
                    "todo"
                );
            }
            let count: i64 = f
                .connection()
                .query_row(
                    "SELECT count(*) FROM recurring_task_occurrences WHERE template_id=?1",
                    [&id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 3);
        }
    }
    #[tokio::test]
    async fn scheduler_retry_pause_preferences_and_current_authority_are_enforced() {
        let f = Fixture::new().await;
        let date = schedule::today("Europe/Bucharest").unwrap().to_string();
        let c = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Create {
                command_id: validation::new_id(),
                profile: profile(&f, "daily", &date),
            },
        )
        .await
        .unwrap();
        let id = c["id"].as_str().unwrap().to_owned();
        let (a, b) = tokio::join!(
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                Generate {
                    scheduled_date: date.clone()
                }
            ),
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                Generate {
                    scheduled_date: date
                }
            )
        );
        assert_eq!(a.unwrap()["id"], b.unwrap()["id"]);
        automation::tick(&f.db).await.unwrap();
        let notifications: i64 = f
            .connection()
            .query_row("SELECT count(*) FROM notifications", [], |r| r.get(0))
            .unwrap();
        automation::tick(&f.db).await.unwrap();
        assert_eq!(
            f.connection()
                .query_row("SELECT count(*) FROM notifications", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            notifications
        );
        let current = read(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        let body = json!({"command_id":validation::new_id(),"expected_revision":current["revision"],"status":"paused"});
        change(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            input(body.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            change(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                input(body)
            )
            .await
            .unwrap()["replayed"],
            true
        );
        assert!(
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                Generate {
                    scheduled_date: current["next_date"].as_str().unwrap().into()
                }
            )
            .await
            .is_err()
        );
        let current = read(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        assert_eq!(current["generated_count"], "1");
        preferences::update(
            &f.db,
            f.actor.clone(),
            input(json!({"workflow":false,"tasks":false,"finance":false,"expected_revision":"1"})),
        )
        .await
        .unwrap();
        assert_eq!(
            preferences::read(&f.db, f.actor.clone()).await.unwrap()["tasks"],
            false
        );
        // No automatic owner fallback: an inactive management identity stops generation.
        let c = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Create {
                command_id: validation::new_id(),
                profile: profile(
                    &f,
                    "daily",
                    &schedule::today("Europe/Bucharest").unwrap().to_string(),
                ),
            },
        )
        .await
        .unwrap();
        f.connection()
            .execute(
                "UPDATE users SET status='disabled' WHERE id=?1",
                [&f.actor.user_id],
            )
            .unwrap();
        assert!(!automation::tick(&f.db).await.unwrap());
        assert_eq!(
            f.connection()
                .query_row(
                    "SELECT generated_count FROM recurring_tasks WHERE id=?1",
                    [c["id"].as_str()],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert!(
            f.connection()
                .query_row("SELECT count(*) FROM automation_failures", [], |r| r
                    .get::<_, i64>(0))
                .unwrap()
                > 0
        );
    }
    #[tokio::test]
    async fn prospective_template_edit_preserves_completed_occurrences_and_history() {
        let f = Fixture::new().await;
        let today = schedule::today("Europe/Bucharest").unwrap();
        let c = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Create {
                command_id: validation::new_id(),
                profile: profile(&f, "daily", &today.to_string()),
            },
        )
        .await
        .unwrap();
        let id = c["id"].as_str().unwrap().to_owned();
        let generated = generate(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            Generate {
                scheduled_date: today.to_string(),
            },
        )
        .await
        .unwrap();
        let task = generated["id"].as_str().unwrap().to_owned();
        tasks::status(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            task.clone(),
            tasks::Status {
                status: "in_progress".into(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
        tasks::status(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            task.clone(),
            tasks::Status {
                status: "done".into(),
                expected_revision: 2,
            },
        )
        .await
        .unwrap();
        let current = read(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        let mut edited = profile(&f, "weekly", &today.succ_opt().unwrap().to_string());
        edited.title = "Synthetic new future title".into();
        change(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            id.clone(),
            Change {
                command_id: validation::new_id(),
                expected_revision: current["revision"].as_str().unwrap().into(),
                status: None,
                managed_by: None,
                profile: Some(edited),
            },
        )
        .await
        .unwrap();
        let historical = tasks::read(&f.db, f.actor.clone(), f.client.clone(), task)
            .await
            .unwrap();
        assert_eq!(historical["title"], "Synthetic recurring work");
        assert_eq!(historical["status"], "done");
        assert_eq!(
            f.connection()
                .query_row(
                    "SELECT count(*) FROM recurring_task_versions WHERE template_id=?1",
                    [&id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
    }
    #[tokio::test]
    async fn active_worker_generates_once_with_job_audit_and_respects_notification_preferences() {
        let f = Fixture::new().await;
        let date = schedule::today("Europe/Bucharest").unwrap().to_string();
        preferences::update(
            &f.db,
            f.actor.clone(),
            input(json!({"workflow":true,"tasks":false,"finance":true,"expected_revision":"1"})),
        )
        .await
        .unwrap();
        let c = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Create {
                command_id: validation::new_id(),
                profile: profile(&f, "daily", &date),
            },
        )
        .await
        .unwrap();
        assert!(automation::tick(&f.db).await.unwrap());
        assert!(!automation::tick(&f.db).await.unwrap());
        let db = f.connection();
        assert_eq!(
            db.query_row(
                "SELECT generated_count FROM recurring_tasks WHERE id=?1",
                [c["id"].as_str()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        assert_eq!(db.query_row("SELECT count(*) FROM notifications WHERE kind IN ('recurring_generated','task_due','task_overdue')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(
            db.query_row(
                "SELECT count(*) FROM audit_events WHERE json_extract(metadata,'$.source')='job'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
                > 0
        );
        super::super::integrity::verify(&db.unchecked_transaction().unwrap()).unwrap();
    }
}
