//! Independent operating payables; never populated from pricing estimates.
use crate::{
    audit::{self, Snapshot},
    billing,
    db::Database,
    error::{Error, Result},
    operations::{self, grant_sql},
    query::{Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub const KEYS: &[&str] = &[
    "currency",
    "client_id",
    "category_id",
    "status",
    "q",
    "limit",
    "cursor",
];
fn authority(tx: &Transaction<'_>, actor: &Actor, write: bool) -> Result<()> {
    security::require(tx, actor, "expenses.view", None)?;
    if write {
        security::require(tx, actor, "expenses.manage", None)?;
    }
    Ok(())
}
fn client_authority(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: Option<&str>,
    write: bool,
) -> Result<()> {
    if let Some(c) = client {
        operations::require(tx, actor, "billing.view", c, write)?;
    }
    Ok(())
}
fn visibility(actor: &Actor) -> Result<String> {
    let client = crate::mcp::access::predicate(
        actor,
        "clients:read",
        "e.client_id",
        grant_sql("?1", "clients.view", "e.client_id"),
    )?;
    let original = format!(
        "(e.client_id IS NULL OR ({client} AND {}))",
        grant_sql("?1", "billing.view", "e.client_id")
    );
    crate::mcp::access::predicate(actor, "finance:read", "e.client_id", original)
}

const COLUMNS: &str = "e.id,e.client_id,c.name AS client_name,e.category_id,k.name AS category_name,e.title,e.vendor,e.description,e.currency,CAST(e.amount_minor AS TEXT) AS amount_minor,CAST(e.paid_minor AS TEXT) AS paid_minor,CAST(CASE WHEN e.cancelled_at IS NULL THEN e.amount_minor-e.paid_minor ELSE 0 END AS TEXT) AS outstanding_minor,e.expense_date,e.due_date,e.cancelled_at,CAST(e.revision AS TEXT) AS revision,e.created_at";
const JOINS: &str = "FROM expenses e JOIN expense_categories k ON k.id=e.category_id LEFT JOIN clients c ON c.id=e.client_id";
fn document(tx: &Transaction<'_>, actor: &Actor, id: &str) -> Result<Value> {
    let row = tx
        .query_row(
            &format!("SELECT {COLUMNS} {JOINS} WHERE e.id=?1"),
            [id],
            row_json,
        )
        .optional()?
        .ok_or(Error::NotFound)?;
    client_authority(tx, actor, row["client_id"].as_str(), false)?;
    Ok(row)
}
fn audit(
    tx: &Transaction<'_>,
    actor: &Actor,
    id: &str,
    client: Option<&str>,
    old: Option<i64>,
    new: i64,
) -> Result<()> {
    audit::mutation(
        tx,
        actor,
        "expense",
        id,
        client,
        if old.is_some() { "updated" } else { "created" },
        (old.map(Snapshot::revision), Snapshot::revision(new)),
    )
}
pub async fn categories(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let p = q.paging()?;
    db.read(move|tx|{authority(tx,&actor,false)?;let mut stmt=tx.prepare("SELECT id,name FROM expense_categories WHERE (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2")?;p.page(stmt.query_map(params![p.cursor,(p.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)}).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Category {
    pub id: String,
    pub name: String,
}
pub async fn category(db: &Database, actor: Actor, mut input: Category) -> Result<Value> {
    validation::id(&input.id)?;
    input.name = validation::text(&input.name, 100, true, false)?;
    db.write(move |tx| {
        authority(tx, &actor, true)?;
        if let Some((name, creator)) = tx
            .query_row(
                "SELECT name,created_by FROM expense_categories WHERE id=?1",
                [&input.id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if name != input.name || creator != actor.user_id {
                return Err(Error::Conflict("command_conflict"));
            }
            return Ok(json!({"id":input.id,"replayed":true}));
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM expense_categories WHERE name=?1)",
            [&input.name],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::Conflict("conflict"));
        }
        tx.execute(
            "INSERT INTO expense_categories VALUES(?1,?2,?3,?4)",
            params![input.id, input.name, actor.user_id, validation::now()],
        )?;
        audit(tx, &actor, &input.id, None, None, 1)?;
        Ok(json!({"id":input.id,"replayed":false}))
    })
    .await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub command_id: String,
    pub client_id: Option<String>,
    pub category_id: String,
    pub title: String,
    pub vendor: String,
    pub description: String,
    pub currency: String,
    pub amount_minor: String,
    pub expense_date: String,
    pub due_date: Option<String>,
}
pub async fn create(db: &Database, actor: Actor, mut input: Create) -> Result<Value> {
    validation::id(&input.command_id)?;
    validation::id(&input.category_id)?;
    input.client_id = input.client_id.map(|v| validation::id(&v)).transpose()?;
    input.title = validation::text(&input.title, 200, true, false)?;
    input.vendor = validation::text(&input.vendor, 200, false, false)?;
    input.description = validation::text(&input.description, 4000, false, true)?;
    let amount = validation::exact_integer(&input.amount_minor, true)?;
    billing::exponent(&input.currency)?;
    input.expense_date = validation::date(&input.expense_date)?;
    input.due_date = input.due_date.map(|v| validation::date(&v)).transpose()?;
    if input.expense_date > billing::today() {
        return Err(Error::Invalid("invalid_request"));
    }
    let digest = operations::hash(&input)?;
    db.write(move|tx|{authority(tx,&actor,true)?;client_authority(tx,&actor,input.client_id.as_deref(),false)?;
 if let Some((id,creator,hash))=tx.query_row("SELECT id,created_by,payload_hash FROM expenses WHERE command_id=?1",[&input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?{if creator!=actor.user_id||hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"expense":document(tx,&actor,&id)?,"event_id":null,"replayed":true}))}
 client_authority(tx,&actor,input.client_id.as_deref(),true)?;
 if !tx.query_row("SELECT EXISTS(SELECT 1 FROM expense_categories WHERE id=?1)",[&input.category_id],|r|r.get::<_,bool>(0))?{return Err(Error::Invalid("invalid_request"))}
 let id=validation::new_id();tx.execute("INSERT INTO expenses(id,client_id,category_id,title,vendor,description,currency,amount_minor,expense_date,due_date,created_by,created_at,command_id,payload_hash) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",params![id,input.client_id,input.category_id,input.title,input.vendor,input.description,input.currency,amount,input.expense_date,input.due_date,actor.user_id,validation::now(),input.command_id,digest])?;
 audit(tx,&actor,&id,input.client_id.as_deref(),None,1)?;Ok(json!({"expense":document(tx,&actor,&id)?,"event_id":null,"replayed":false}))}).await
}
pub async fn list(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    let p = q.paging()?;
    if p.descending {
        return Err(Error::Invalid("invalid_request"));
    }
    let currency = q.get("currency").map(str::to_owned);
    if let Some(c) = &currency {
        billing::exponent(c)?;
    }
    let client = q.get("client_id").map(validation::id).transpose()?;
    let category = q.get("category_id").map(validation::id).transpose()?;
    let status = q
        .choice(
            "status",
            "all",
            &["all", "open", "paid", "overdue", "cancelled"],
        )?
        .to_owned();
    let search = q.text("q", 100)?;
    db.read(move|tx|{authority(tx,&actor,false)?;client_authority(tx,&actor,client.as_deref(),false)?;let visible=visibility(&actor)?;
 let mut stmt=tx.prepare(&format!("SELECT {COLUMNS} {JOINS} WHERE {visible} AND (?2 IS NULL OR e.currency=?2) AND (?3 IS NULL OR e.client_id=?3) AND (?4 IS NULL OR e.category_id=?4) AND (?5 IS NULL OR e.id>?5) AND (?6='all' OR (?6='open' AND e.cancelled_at IS NULL AND e.paid_minor<e.amount_minor) OR (?6='paid' AND e.cancelled_at IS NULL AND e.paid_minor=e.amount_minor) OR (?6='overdue' AND e.cancelled_at IS NULL AND e.paid_minor<e.amount_minor AND e.due_date<?7) OR (?6='cancelled' AND e.cancelled_at IS NOT NULL)) AND (?8='' OR instr(unicode_lower(e.title||' '||e.vendor),unicode_lower(?8))>0) ORDER BY e.id LIMIT ?9"))?;
 p.page(stmt.query_map(params![actor.user_id,currency,client,category,p.cursor,status,billing::today(),search,(p.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)}).await
}
pub async fn read(db: &Database, actor: Actor, id: String) -> Result<Value> {
    db.read(move |tx| {
        authority(tx, &actor, false)?;
        document(tx, &actor, &id)
    })
    .await
}
pub async fn events(db: &Database, actor: Actor, id: String, q: Query) -> Result<Value> {
    let p = q.paging()?;
    db.read(move|tx|{authority(tx,&actor,false)?;document(tx,&actor,&id)?;let mut stmt=tx.prepare("SELECT id,expense_id,payment_id,kind,CAST(amount_minor AS TEXT) AS amount_minor,occurred_on,method,reason,recorded_at,CAST(expected_revision AS TEXT) AS expected_revision FROM expense_events WHERE expense_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3")?;p.page(stmt.query_map(params![id,p.cursor,(p.limit+1)as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)}).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub command_id: String,
    pub expected_revision: String,
    pub payment_id: Option<String>,
    pub amount_minor: String,
    pub occurred_on: String,
    pub method: String,
    pub reason: String,
}
pub async fn event(db: &Database, actor: Actor, id: String, mut input: Event) -> Result<Value> {
    validation::id(&input.command_id)?;
    input.payment_id = input.payment_id.map(|v| validation::id(&v)).transpose()?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    let amount = validation::exact_integer(&input.amount_minor, true)?;
    input.occurred_on = validation::date(&input.occurred_on)?;
    input.reason = validation::text(&input.reason, 2000, input.payment_id.is_some(), true)?;
    if input.occurred_on > billing::today()
        || !["bank_transfer", "cash", "card", "other"].contains(&input.method.as_str())
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let digest = operations::hash(&input)?;
    db.write(move|tx|{authority(tx,&actor,true)?;let expense=document(tx,&actor,&id)?;
 if let Some((event,expense_id,creator,hash))=tx.query_row("SELECT id,expense_id,recorded_by,payload_hash FROM expense_events WHERE command_id=?1",[&input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?{if expense_id!=id||creator!=actor.user_id||hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"expense":expense,"event_id":event,"replayed":true}))}
 client_authority(tx,&actor,expense["client_id"].as_str(),true)?;let revision=validation::exact_integer(expense["revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(revision,expected)?;
 if expense["cancelled_at"].is_string(){return Err(Error::Conflict("conflict"))}
 if let Some(payment)=&input.payment_id {let original=tx.query_row("SELECT occurred_on,amount_minor,coalesce((SELECT exact_sum(r.amount_minor) FROM expense_events r WHERE r.payment_id=p.id),'0'),p.method FROM expense_events p WHERE p.id=?1 AND p.expense_id=?2 AND p.kind='payment'",params![payment,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?.ok_or(Error::Invalid("invalid_reversal"))?;
 if input.method!=original.3||input.occurred_on<original.0||i128::from(amount)>i128::from(original.1)-original.2.parse::<i128>().map_err(|_|Error::Internal)?{return Err(Error::Invalid("invalid_reversal"))}
 }else if i128::from(amount)>super::reporting::integer(&expense["outstanding_minor"])?{return Err(Error::Invalid("invalid_request"))}
 let event=validation::new_id();tx.execute("INSERT INTO expense_events(id,expense_id,payment_id,kind,amount_minor,occurred_on,method,reason,recorded_by,recorded_at,command_id,payload_hash,expected_revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![event,id,input.payment_id,if input.payment_id.is_some(){"reversal"}else{"payment"},amount,input.occurred_on,input.method,input.reason,actor.user_id,validation::now(),input.command_id,digest,expected])?;
 audit(tx,&actor,&id,expense["client_id"].as_str(),Some(revision),next)?;Ok(json!({"expense":document(tx,&actor,&id)?,"event_id":event,"replayed":false}))}).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cancel {
    pub command_id: String,
    pub expected_revision: String,
}
pub async fn cancel(db: &Database, actor: Actor, id: String, input: Cancel) -> Result<Value> {
    validation::id(&input.command_id)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    let digest = operations::hash(&input)?;
    db.write(move |tx| {
        authority(tx, &actor, true)?;
        let expense = document(tx, &actor, &id)?;
        if let Some((parent, creator, hash)) = tx
            .query_row(
                "SELECT expense_id,actor_id,payload_hash FROM expense_commands WHERE command_id=?1",
                [&input.command_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if parent != id || creator != actor.user_id || hash != digest {
                return Err(Error::Conflict("command_conflict"));
            }
            return Ok(json!({"expense":expense,"event_id":null,"replayed":true}));
        }
        client_authority(tx, &actor, expense["client_id"].as_str(), true)?;
        let revision =
            validation::exact_integer(expense["revision"].as_str().ok_or(Error::Internal)?, true)?;
        let next = next_revision(revision, expected)?;
        if expense["cancelled_at"].is_string()
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM expense_events WHERE expense_id=?1)",
                [&id],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(Error::Conflict("expense_has_transactions"));
        }
        tx.execute(
            "UPDATE expenses SET cancelled_at=?1,revision=?2 WHERE id=?3",
            params![validation::now(), next, id],
        )?;
        tx.execute(
            "INSERT INTO expense_commands VALUES(?1,?2,?3,?4,?5)",
            params![
                input.command_id,
                id,
                actor.user_id,
                digest,
                validation::now()
            ],
        )?;
        audit(
            tx,
            &actor,
            &id,
            expense["client_id"].as_str(),
            Some(revision),
            next,
        )?;
        Ok(json!({"expense":document(tx,&actor,&id)?,"event_id":null,"replayed":false}))
    })
    .await
}
pub fn analytics(
    tx: &Transaction<'_>,
    actor: &Actor,
    ctx: &super::reporting::Context,
) -> Result<Value> {
    if !security::allowed_actor(tx, actor, "expenses.view", None)? {
        return Ok(Value::Null);
    }
    let visible = visibility(actor)?;
    let cte = format!(
        ", expense_source AS MATERIALIZED (SELECT e.*,k.name AS category_name FROM expenses e JOIN expense_categories k ON k.id=e.category_id WHERE {visible} AND e.currency=?2 AND (?3 IS NULL OR e.client_id=?3) LIMIT 50001) "
    );
    let run = |sql: &str| ctx.rows(tx, &(cte.clone() + sql));
    let count = run("SELECT count(*) AS count FROM expense_source")?;
    if count[0]["count"].as_i64().is_some_and(|n| n > 50000) {
        return Err(Error::Invalid("report_range_too_large"));
    }
    let position=run("SELECT coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND expense_date BETWEEN ?4 AND ?5 THEN amount_minor ELSE 0 END),'0') AS recorded_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor-paid_minor ELSE 0 END),'0') AS outstanding_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND due_date<?6 THEN amount_minor-paid_minor ELSE 0 END),'0') AS overdue_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND due_date BETWEEN ?6 AND date(?6,'+30 days') THEN amount_minor-paid_minor ELSE 0 END),'0') AS upcoming_minor FROM expense_source")?.remove(0);
    let cap = run(
        "SELECT count(*) AS count FROM (SELECT p.id FROM expense_events p JOIN expense_source e ON e.id=p.expense_id WHERE p.occurred_on BETWEEN ?4 AND ?5 LIMIT 50001)",
    )?;
    if cap[0]["count"].as_i64().is_some_and(|n| n > 50000) {
        return Err(Error::Invalid("report_range_too_large"));
    }
    let activity=run("SELECT coalesce(exact_sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE 0 END),'0') AS gross_minor,coalesce(exact_sum(CASE p.kind WHEN 'reversal' THEN p.amount_minor ELSE 0 END),'0') AS reversed_minor,coalesce(exact_sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE -p.amount_minor END),'0') AS net_minor FROM expense_events p JOIN expense_source e ON e.id=p.expense_id WHERE p.occurred_on BETWEEN ?4 AND ?5")?.remove(0);
    let categories = run(
        "SELECT e.category_id AS id,e.category_name AS label,coalesce(exact_sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE -p.amount_minor END),'0') AS amount_minor FROM expense_events p JOIN expense_source e ON e.id=p.expense_id WHERE p.occurred_on BETWEEN ?4 AND ?5 GROUP BY e.category_id,e.category_name ORDER BY e.category_id LIMIT 101",
    )?;
    if categories.len() > 100 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    let trends = run(
        "SELECT substr(p.occurred_on,1,7) AS period,coalesce(exact_sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE -p.amount_minor END),'0') AS net_minor FROM expense_events p JOIN expense_source e ON e.id=p.expense_id WHERE p.occurred_on BETWEEN ?4 AND ?5 GROUP BY period ORDER BY period LIMIT 367",
    )?;
    if trends.len() > 366 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    let vendors = run(
        "SELECT e.vendor AS label,coalesce(exact_sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE -p.amount_minor END),'0') AS amount_minor FROM expense_events p JOIN expense_source e ON e.id=p.expense_id WHERE p.occurred_on BETWEEN ?4 AND ?5 GROUP BY e.vendor ORDER BY e.vendor LIMIT 101",
    )?;
    if vendors.len() > 100 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    Ok(
        json!({"position":position,"activity":activity,"categories":categories,"trends":trends,"vendors":vendors}),
    )
}
pub(crate) fn verify(tx: &Transaction<'_>) -> Result<()> {
    let bad:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM expenses e WHERE e.paid_minor<>CAST(coalesce((SELECT exact_sum(CASE kind WHEN 'payment' THEN amount_minor ELSE -amount_minor END) FROM expense_events WHERE expense_id=e.id),'0') AS INTEGER) OR (e.cancelled_at IS NOT NULL AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=e.id))) OR EXISTS(SELECT 1 FROM expense_events p WHERE p.kind='payment' AND p.amount_minor<CAST(coalesce((SELECT exact_sum(r.amount_minor) FROM expense_events r WHERE r.payment_id=p.id),'0') AS INTEGER)) OR EXISTS(SELECT 1 FROM expense_events r LEFT JOIN expense_events p ON p.id=r.payment_id WHERE r.kind='reversal' AND (p.id IS NULL OR p.kind<>'payment' OR p.expense_id<>r.expense_id OR r.occurred_on<p.occurred_on OR r.method<>p.method))",[],|r|r.get(0))?;
    if bad {
        Err(Error::Invalid("invalid_expense_ledger"))
    } else {
        Ok(())
    }
}
