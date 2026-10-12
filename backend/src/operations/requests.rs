//! Decisions, linked development work and immutable delivery/review cycles.
use super::*;
use crate::{
    audit::{self, Snapshot},
    db::Database,
    query::{Query, next_revision, row_json},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const STATES: &[&str] = &[
    "new",
    "accepted",
    "rejected",
    "in_progress",
    "delivered",
    "revision_requested",
    "approved",
    "cancelled",
];
const COLUMNS: &str = "r.id,r.client_id,r.website_id,r.created_by,r.title,r.category,r.priority,r.status,r.assignee_id,r.task_id,r.due_at,CAST(r.revision AS TEXT) AS revision,r.delivery_count,r.created_at,r.updated_at,c.name AS brand_name,w.name AS website_name,w.domain AS website_domain,u.display_name AS requester_name,a.display_name AS assignee_name";
/// Caller identifiers are bound parameters; only fixed SQL expressions enter this helper.
pub(crate) fn visibility_sql(user: &str) -> String {
    let all = grant_sql(user, "tickets.read_all", "r.client_id");
    let own = grant_sql(user, "tickets.read_own", "r.client_id");
    let team = grant_sql(user, "tickets.read_team", "r.client_id");
    let brand = grant_sql(user, "clients.view", "r.client_id");
    format!(
        "({brand} AND ({all} OR ({own} AND r.created_by={user}) OR ({team} AND EXISTS(SELECT 1 FROM teams tm JOIN brand_staff_assignments bs ON bs.team_id=tm.id WHERE tm.leader_id={user} AND tm.archived_at IS NULL AND bs.client_id=r.client_id AND bs.user_id=r.created_by))))"
    )
}
pub(crate) fn visible(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
) -> Result<Value> {
    security::fresh(tx, actor)?;
    Ok(tx.query_row(&format!("SELECT {COLUMNS},r.description,r.reference_url FROM technical_requests r JOIN clients c ON c.id=r.client_id JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.assignee_id LEFT JOIN client_websites w ON w.id=r.website_id WHERE r.id=?2 AND r.client_id=?3 AND {}",visibility_sql("?1")),params![actor.user_id,id,client],row_json)?)
}
pub async fn list(db: &Database, actor: Actor, client: Option<String>, q: Query) -> Result<Value> {
    let paging = q.paging()?;
    let mut states = STATES.to_vec();
    states.push("all");
    let status = q.choice("status", "all", &states)?.to_owned();
    let priority = q
        .choice("priority", "all", &["all", "normal", "high", "critical"])?
        .to_owned();
    let search = q.text("q", 100)?;
    let assignee = q.get("assignee").unwrap_or("").to_owned();
    let requester = q.get("requester").map(validation::id).transpose()?;
    let website = q.get("website").map(validation::id).transpose()?;
    let from = q.get("from").map(validation::date).transpose()?;
    let to = q.get("to").map(validation::date).transpose()?;
    if from.as_ref().zip(to.as_ref()).is_some_and(|(a, b)| a > b) {
        return Err(Error::Invalid("invalid_dates"));
    }
    if !assignee.is_empty() && !["me", "unassigned"].contains(&assignee.as_str()) {
        validation::id(&assignee)?;
    }
    db.read(move|tx|{
        security::fresh(tx,&actor)?;
        let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} FROM technical_requests r JOIN clients c ON c.id=r.client_id JOIN users u ON u.id=r.created_by LEFT JOIN users a ON a.id=r.assignee_id LEFT JOIN client_websites w ON w.id=r.website_id WHERE {} AND (?2 IS NULL OR r.client_id=?2) AND (?3 IS NULL OR r.id {} ?3) AND (?4='all' OR r.status=?4) AND (?5='all' OR r.priority=?5) AND (?6='' OR instr(unicode_lower(r.title),unicode_lower(?6))>0 OR instr(unicode_lower(c.name),unicode_lower(?6))>0) AND (?7='' OR (?7='me' AND r.assignee_id=?1) OR (?7='unassigned' AND r.assignee_id IS NULL) OR r.assignee_id=?7) AND (?8 IS NULL OR r.created_by=?8) AND (?9 IS NULL OR r.website_id=?9) AND (?10 IS NULL OR substr(r.created_at,1,10)>=?10) AND (?11 IS NULL OR substr(r.created_at,1,10)<=?11) ORDER BY r.id {} LIMIT ?12",visibility_sql("?1"),paging.comparison(),paging.order()))?;
        let items=stmt.query_map(params![actor.user_id,client,paging.cursor,status,priority,search,assignee,requester,website,from,to,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(items)
    }).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub command_id: String,
    pub website_id: Option<String>,
    pub brand_wide: bool,
    pub title: String,
    pub description: String,
    pub category: String,
    pub priority: String,
    #[serde(default)]
    pub reference_url: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}
pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    mut input: Create,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    input.title = validation::text(&input.title, 200, true, false)?;
    input.description = validation::text(&input.description, 8000, true, true)?;
    input.reference_url = url(&input.reference_url)?;
    if input.brand_wide == input.website_id.is_some()
        || ![
            "bug",
            "design",
            "feature",
            "content",
            "performance",
            "integration",
            "support",
            "other",
        ]
        .contains(&input.category.as_str())
        || !["normal", "high", "critical"].contains(&input.priority.as_str())
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let fingerprint = hash(&input)?;
    db.write(move|tx|{
        require(tx,&actor,"tickets.create",&client,false)?;
        let old:Option<(String,String,String)>=tx.query_row("SELECT id,created_by,command_hash FROM technical_requests WHERE client_id=?1 AND command_id=?2",params![client,input.command_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id,user,digest))=old {if user!=actor.user_id || digest!=fingerprint{return Err(Error::Conflict("command_conflict"))}return receipt(tx,&id,true)}
        security::client(tx,&client,true)?;website(tx,&client,input.website_id.as_deref())?;
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO technical_requests(id,client_id,website_id,created_by,title,description,category,priority,reference_url,status,command_id,command_hash,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'new',?10,?11,?12,?12)",params![id,client,input.website_id,actor.user_id,input.title,input.description,input.category,input.priority,input.reference_url,input.command_id,fingerprint,now])?;
        evidence::bind(tx,&actor,&client,&id,None,&input.evidence_ids)?;
        event(tx,&actor,&id,&client,TimelineEvent{revision:1,action:"created",status:"new",text:"",delivery:None})?;
        notifications::emit_request(tx,&actor,&id,"created",1)?;
        receipt(tx,&id,false)
    }).await
}
fn receipt(tx: &Transaction<'_>, id: &str, replayed: bool) -> Result<Value> {
    let mut v = tx.query_row(
        "SELECT id,CAST(revision AS TEXT) AS revision,status FROM technical_requests WHERE id=?1",
        [id],
        row_json,
    )?;
    v["replayed"] = json!(replayed);
    Ok(v)
}
struct TimelineEvent<'a> {
    revision: i64,
    action: &'a str,
    status: &'a str,
    text: &'a str,
    delivery: Option<&'a str>,
}
fn event(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    client: &str,
    input: TimelineEvent<'_>,
) -> Result<String> {
    let TimelineEvent {
        revision,
        action,
        status,
        text,
        delivery,
    } = input;
    let event = validation::new_id();
    tx.execute("INSERT INTO request_events(id,request_id,sequence,actor_id,action,status,text,delivery_id,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![event,id,revision,actor.user_id,action,status,text,delivery,validation::now()])?;
    audit::mutation(
        tx,
        actor,
        "technical_request",
        id,
        Some(client),
        if action == "created" {
            "created"
        } else {
            "updated"
        },
        (
            if revision == 1 {
                None
            } else {
                Some(Snapshot::revision(revision - 1))
            },
            Snapshot::revision(revision),
        ),
    )?;
    Ok(event)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub command_id: String,
    pub expected_revision: String,
    #[serde(default)]
    pub reason: String,
    pub assignee_id: Option<String>,
    pub due_at: Option<String>,
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub test_notes: String,
    #[serde(default)]
    pub implementation_url: String,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}
fn capability(action: &str) -> Result<&'static str> {
    Ok(match action {
        "accept" => "tickets.accept",
        "reject" => "tickets.reject",
        "assign" => "tickets.assign",
        "start" | "deliver" => "tickets.deliver",
        "approve" => "tickets.approve",
        "revise" => "tickets.request_revision",
        "reopen" => "tickets.reopen",
        "cancel" => "tickets.cancel",
        "comment" => "",
        _ => return Err(Error::NotFound),
    })
}
pub fn transition(from: &str, action: &str) -> Option<&'static str> {
    match (from, action) {
        ("new", "accept") => Some("accepted"),
        ("new", "reject") => Some("rejected"),
        ("accepted" | "revision_requested", "start") => Some("in_progress"),
        ("in_progress", "deliver") => Some("delivered"),
        ("delivered", "approve") => Some("approved"),
        ("delivered", "revise") => Some("revision_requested"),
        ("rejected", "reopen") => Some("new"),
        ("new" | "accepted" | "in_progress" | "revision_requested" | "rejected", "cancel") => {
            Some("cancelled")
        }
        _ => None,
    }
}
fn reviewer(tx: &Transaction<'_>, actor: &Actor, old: &Value, delivery: &str) -> Result<()> {
    let author: String = tx.query_row(
        "SELECT delivered_by FROM request_deliveries WHERE id=?1 AND request_id=?2",
        params![delivery, old["id"].as_str()],
        |r| r.get(0),
    )?;
    if author == actor.user_id {
        return Err(Error::Denied);
    }
    if old["created_by"] == actor.user_id
        || security::allowed_user(
            tx,
            &actor.user_id,
            "tickets.read_all",
            old["client_id"].as_str(),
        )?
    {
        return Ok(());
    }
    let leader:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM teams t JOIN brand_staff_assignments bs ON bs.team_id=t.id WHERE t.leader_id=?1 AND t.archived_at IS NULL AND bs.client_id=?2 AND bs.user_id=?3)",params![actor.user_id,old["client_id"].as_str(),old["created_by"].as_str()],|r|r.get(0))?;
    if leader { Ok(()) } else { Err(Error::Denied) }
}
pub async fn act(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    action: String,
    mut input: Action,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    input.reason = validation::text(
        &input.reason,
        8000,
        ["reject", "deliver", "revise", "comment", "reopen", "cancel"].contains(&action.as_str()),
        true,
    )?;
    input.test_notes = validation::text(&input.test_notes, 4000, false, true)?;
    input.reference = validation::text(&input.reference, 300, false, false)?;
    input.implementation_url = url(&input.implementation_url)?;
    input.assignee_id = input.assignee_id.map(|v| validation::id(&v)).transpose()?;
    input.due_at = input.due_at.map(|v| validation::instant(&v)).transpose()?;
    if action != "deliver"
        && (!input.evidence_ids.is_empty()
            || !input.test_notes.is_empty()
            || !input.reference.is_empty()
            || !input.implementation_url.is_empty())
        || !["accept", "assign"].contains(&action.as_str())
            && (input.assignee_id.is_some() || input.due_at.is_some())
        || !["approve", "revise"].contains(&action.as_str()) && input.delivery_id.is_some()
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let cap = capability(&action)?;
    let fingerprint = hash(&(action.clone(), &input))?;
    db.write(move|tx|{
        let old=visible(tx,&actor,&client,&id)?;
        if !cap.is_empty(){require(tx,&actor,cap,&client,false)?;}
        let replay:Option<(String,String)>=tx.query_row("SELECT actor_id,payload_hash FROM request_commands WHERE request_id=?1 AND command_id=?2",params![id,input.command_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((user,digest))=replay {if user!=actor.user_id || digest!=fingerprint{return Err(Error::Conflict("command_conflict"))}return receipt(tx,&id,true)}
        security::client(tx,&client,true)?;
        let previous=validation::exact_integer(old["revision"].as_str().ok_or(Error::Internal)?,true)?;
        let revision=next_revision(previous,expected)?;
        let from=old["status"].as_str().ok_or(Error::Internal)?;
        let to=if action=="comment" || (action=="assign" && ["accepted","in_progress","revision_requested"].contains(&from)) {from} else {transition(from,&action).ok_or(Error::Conflict("invalid_transition"))?};
        let mut assignee=old["assignee_id"].as_str().map(str::to_owned);
        if ["accept","assign"].contains(&action.as_str()) {
            if let Some(new)=&input.assignee_id && (!security::allowed_user(tx,new,"tickets.deliver",Some(&client))? || !(security::allowed_user(tx,new,"tasks.view",Some(&client))? || security::allowed_user(tx,new,"tasks.read_development",Some(&client))?)) {return Err(Error::Invalid("invalid_assignee"))}
            assignee=input.assignee_id.clone();
            if action=="assign" && assignee.is_none(){return Err(Error::Invalid("invalid_assignee"))}
        }
        if ["start","deliver"].contains(&action.as_str()) && assignee.as_deref()!=Some(&actor.user_id){return Err(Error::Denied)}
        let now=validation::now();let mut task=old["task_id"].as_str().map(str::to_owned);
        if action=="accept" {
            let profile=validation::json(&serde_json::to_vec(&json!({"title":old["title"],"description":old["description"],"priority":match old["priority"].as_str(){Some("critical")=>"urgent",Some("high")=>"high",_=>"medium"},"assignee_id":assignee,"due_at":input.due_at,"status":"todo"})).map_err(|_|Error::Internal)?)?;
            task=Some(crate::tasks::create_development_in_transaction(tx,&actor,&client,profile)?.id);
        }
        let delivery_count=old["delivery_count"].as_i64().ok_or(Error::Internal)?;
        let mut delivery=None;
        if action=="deliver" {
            let did=validation::new_id();
            tx.execute("INSERT INTO request_deliveries(id,request_id,number,delivered_by,summary,test_notes,implementation_url,reference,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![did,id,delivery_count+1,actor.user_id,input.reason,input.test_notes,input.implementation_url,input.reference,now])?;
            evidence::bind(tx,&actor,&client,&id,Some(&did),&input.evidence_ids)?;
            delivery=Some(did);
        }
        if ["approve","revise"].contains(&action.as_str()) {
            let latest:String=tx.query_row("SELECT id FROM request_deliveries WHERE request_id=?1 AND number=?2",params![id,delivery_count],|r|r.get(0))?;
            if input.delivery_id.as_deref()!=Some(&latest){return Err(Error::Conflict("conflict"))}
            reviewer(tx,&actor,&old,&latest)?;
            tx.execute("INSERT INTO delivery_reviews(id,delivery_id,reviewed_by,decision,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6)",params![validation::new_id(),latest,actor.user_id,to,input.reason,now])?;
            delivery=Some(latest);
        }
        let due=if ["accept","assign"].contains(&action.as_str()){input.due_at.as_deref()}else{old["due_at"].as_str()};
        tx.execute("UPDATE technical_requests SET status=?1,assignee_id=?2,task_id=?3,due_at=?4,revision=?5,delivery_count=?6,updated_at=?7 WHERE id=?8",params![to,assignee,task,due,revision,delivery_count+i64::from(action=="deliver"),now,id])?;
        if action!="comment" && let Some(task)=task {
            let status=match to {"accepted"=>"todo","in_progress"|"revision_requested"=>"in_progress","delivered"=>"review","approved"=>"done","cancelled"=>"cancelled",_=>return Err(Error::Internal)};
            tx.execute("UPDATE tasks SET status=?1,assignee_id=?2,due_at=?3,completed_at=?4,cancelled_at=?5,revision=revision+1,updated_at=?6 WHERE id=?7",params![status,assignee,due,if status=="done"{Some(&now)}else{None},if status=="cancelled"{Some(&now)}else{None},now,task])?;
        }
        let label=match action.as_str(){"accept"=>"accepted","reject"=>"rejected","assign"=>"assigned","start"=>"started","deliver"=>"delivered","approve"=>"approved","revise"=>"revision_requested","reopen"=>"reopened","cancel"=>"cancelled",_=>"commented"};
        let event=event(tx,&actor,&id,&client,TimelineEvent{revision,action:label,status:to,text:&input.reason,delivery:delivery.as_deref()})?;
        tx.execute("INSERT INTO request_commands VALUES (?1,?2,?3,?4,?5)",params![id,input.command_id,actor.user_id,fingerprint,event])?;
        notifications::emit_request(tx,&actor,&id,label,revision)?;
        receipt(tx,&id,false)
    }).await
}
pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move|tx|{
        let mut v=visible(tx,&actor,&client,&id)?;
        let mut stmt=tx.prepare("SELECT d.id,d.request_id,d.number,d.delivered_by,u.display_name AS developer_name,d.summary,d.test_notes,d.implementation_url,d.reference,d.created_at FROM request_deliveries d JOIN users u ON u.id=d.delivered_by WHERE d.request_id=?1 ORDER BY d.number DESC LIMIT 25")?;
        v["deliveries"]=json!(stmt.query_map([&id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
        let mut stmt=tx.prepare("SELECT rv.id,rv.delivery_id,rv.reviewed_by,u.display_name AS reviewer_name,rv.decision,rv.reason,rv.created_at FROM delivery_reviews rv JOIN request_deliveries d ON d.id=rv.delivery_id JOIN users u ON u.id=rv.reviewed_by WHERE d.request_id=?1 ORDER BY d.number DESC LIMIT 25")?;
        v["reviews"]=json!(stmt.query_map([&id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
        let mut stmt=tx.prepare("SELECT id,client_id,request_id,delivery_id,filename,mime,size,created_at FROM request_evidence WHERE request_id=?1 ORDER BY created_at,id LIMIT 32")?;
        v["evidence"]=json!(stmt.query_map([&id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);
        let status=v["status"].as_str().ok_or(Error::Internal)?;let mut actions=Vec::new();
        let writable=match security::client(tx,&client,true){Ok(())=>true,Err(Error::Conflict(_))=>false,Err(error)=>return Err(error)};
        for action in ["accept","reject","assign","start","deliver","approve","revise","reopen","cancel","comment"] {
            if action!="comment" && action!="assign" && transition(status,action).is_none() || action=="assign" && !["accepted","in_progress","revision_requested"].contains(&status) {continue}
            if !writable{continue}
            let cap=capability(action)?;
            if !cap.is_empty() && !security::allowed_user(tx,&actor.user_id,cap,Some(&client))? {continue}
            if ["start","deliver"].contains(&action) && v["assignee_id"]!=actor.user_id {continue}
            if ["approve","revise"].contains(&action) {
                let delivery=v["deliveries"].as_array().and_then(|a|a.first()).and_then(|d|d["id"].as_str()).ok_or(Error::Internal)?;
                if reviewer(tx,&actor,&v,delivery).is_err() {continue}
            }
            actions.push(action);
        }
        if tx.query_row("SELECT archived_at IS NOT NULL FROM clients WHERE id=?1",[&client],|r|r.get::<_,bool>(0))?{actions.clear()}
        v["actions"]=json!(actions);Ok(v)
    }).await
}
pub async fn timeline(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    q: Query,
) -> Result<Value> {
    let limit = q.paging()?.limit;
    let after = q
        .get("after")
        .map(|v| validation::exact_integer(v, false))
        .transpose()?
        .unwrap_or(0);
    db.read(move|tx|{
        visible(tx,&actor,&client,&id)?;
        let mut stmt=tx.prepare("SELECT e.id,e.request_id,CAST(e.sequence AS TEXT) AS sequence,e.actor_id,u.display_name AS actor_name,e.action,e.status,e.text,e.delivery_id,e.created_at FROM request_events e JOIN users u ON u.id=e.actor_id WHERE e.request_id=?1 AND e.sequence>?2 ORDER BY e.sequence LIMIT ?3")?;
        let mut items=stmt.query_map(params![id,after,(limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        let more=items.len()>limit;items.truncate(limit);let next=if more{items.last().and_then(|v|v["sequence"].as_str()).map(str::to_owned)}else{None};
        Ok(json!({"data":items,"page":{"limit":limit,"next_after":next}}))
    }).await
}

/// Descending delivery versions, with reviews bound to this exact page.
pub async fn deliveries(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    q: Query,
) -> Result<Value> {
    let limit = q.paging()?.limit;
    let before = q
        .get("before")
        .map(|v| validation::exact_integer(v, true))
        .transpose()?
        .unwrap_or(i64::MAX);
    db.read(move|tx|{
  visible(tx,&actor,&client,&id)?;
  let mut stmt=tx.prepare("SELECT d.id,d.request_id,d.number,d.delivered_by,u.display_name AS developer_name,d.summary,d.test_notes,d.implementation_url,d.reference,d.created_at FROM request_deliveries d JOIN users u ON u.id=d.delivered_by WHERE d.request_id=?1 AND d.number<?2 ORDER BY d.number DESC LIMIT ?3")?;
  let mut data=stmt.query_map(params![id,before,(limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
  let more=data.len()>limit;data.truncate(limit);
  let lower=data.last().and_then(|v|v["number"].as_i64()).unwrap_or(before);
  let mut stmt=tx.prepare("SELECT rv.id,rv.delivery_id,rv.reviewed_by,u.display_name AS reviewer_name,rv.decision,rv.reason,rv.created_at FROM delivery_reviews rv JOIN request_deliveries d ON d.id=rv.delivery_id JOIN users u ON u.id=rv.reviewed_by WHERE d.request_id=?1 AND d.number<?2 AND d.number>=?3 ORDER BY d.number DESC LIMIT ?4")?;
  let reviews=stmt.query_map(params![id,before,lower,limit as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
  Ok(json!({"data":data,"reviews":reviews,"page":{"limit":limit,"next_before":if more{Some(lower.to_string())}else{None}}}))
 }).await
}
