//! Commercial agreements extend the existing receivable and append-only payment ledger.
use super::{allocation, hash, hidden, notifications, require, schedule};
use crate::{
    audit::{self, Snapshot},
    billing,
    db::Database,
    error::{Error, Result},
    query::{Query, next_revision, row_json},
    security::{self, Actor},
    validation,
};
use chrono::{Datelike, Duration};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const AGREEMENT: &str = "a.id,a.client_id,a.created_by,a.managed_by,u.display_name AS manager_name,a.title,a.service_type,a.frequency,a.start_date,a.end_date,a.due_offset_days,a.timezone,a.anchor_day,a.next_date,a.status,CAST(a.revision AS TEXT) AS revision,a.created_at,a.updated_at,(SELECT json_object('error_code',f.error_code,'failed_at',f.failed_at,'retry_after',f.retry_after) FROM automation_failures f WHERE f.kind='agreement' AND f.resource_id=a.id) AS automation_failure_json,(SELECT json_object('amount_minor',CAST(v.amount_minor AS TEXT),'currency',v.currency,'roise_share_minor',CAST(v.roise_share_minor AS TEXT),'partner_id',v.partner_id,'collector',v.collector,'allocation_policy',v.allocation_policy) FROM agreement_versions v WHERE v.agreement_id=a.id ORDER BY v.number DESC LIMIT 1) AS latest_terms_json,(SELECT v.effective_from FROM agreement_versions v WHERE v.agreement_id=a.id ORDER BY v.number DESC LIMIT 1) AS latest_effective_from";
const VERSION: &str = "v.id,v.agreement_id,v.client_id,CAST(v.number AS TEXT) AS number,CAST(v.amount_minor AS TEXT) AS amount_minor,v.currency,CAST(v.roise_share_minor AS TEXT) AS roise_share_minor,v.partner_id,p.name AS partner_name,v.collector,v.allocation_policy,v.effective_from,v.created_at";
pub(crate) const PERIOD_SQL: &str = "SELECT b.id,b.client_id,b.agreement_id,b.version_id,b.collection_id,b.currency,b.period_key,b.billing_date,b.voided_at,b.voided_by,b.void_reason,a.title,v.partner_id,p.name AS partner_name,v.collector,v.allocation_policy,CAST(c.revision AS TEXT) AS collection_revision,c.due_date,CAST((SELECT count(*)+1 FROM internal_settlements s WHERE s.period_id=b.id) AS TEXT) AS settlement_revision,c.amount_minor,c.paid_minor,v.roise_share_minor,(SELECT exact_sum(amount) FROM (SELECT pm.amount_minor AS amount FROM payments pm WHERE pm.collection_id=b.collection_id AND pm.collector='roise' UNION ALL SELECT -rv.amount_minor FROM payment_reversals rv JOIN payments pm ON pm.id=rv.payment_id WHERE rv.collection_id=b.collection_id AND pm.collector='roise')) AS net_roise,(SELECT exact_sum(CASE s.direction WHEN 'partner_to_roise' THEN s.amount_minor ELSE -s.amount_minor END) FROM internal_settlements s WHERE s.period_id=b.id) AS net_settled FROM billing_periods b JOIN service_agreements a ON a.id=b.agreement_id JOIN agreement_versions v ON v.id=b.version_id JOIN collections c ON c.id=b.collection_id LEFT JOIN commercial_partners p ON p.id=v.partner_id";
fn authorize(tx: &Transaction<'_>, actor: &Actor, client: &str, write: bool) -> Result<()> {
    require(
        tx,
        actor,
        if write {
            "agreements.manage"
        } else {
            "agreements.view"
        },
        client,
        false,
    )?;
    security::require(tx, actor, "billing.view", Some(client)).map_err(hidden)
}
fn audit_revision(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    kind: &str,
    action: &str,
    change: (Option<i64>, i64),
) -> Result<()> {
    let (old, revision) = change;
    audit::mutation(
        tx,
        actor,
        kind,
        id,
        Some(client),
        action,
        (old.map(Snapshot::revision), Snapshot::revision(revision)),
    )
}
pub async fn partners(db: &Database, actor: Actor, client: String, q: Query) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{
        authorize(tx,&actor,&client,false)?;
        let mut stmt=tx.prepare("SELECT id,name,archived_at FROM commercial_partners WHERE archived_at IS NULL AND (?1 IS NULL OR id>?1) ORDER BY id LIMIT ?2")?;
        page.page(stmt.query_map(params![page.cursor,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Partner {
    pub id: String,
    pub name: String,
}
pub async fn create_partner(
    db: &Database,
    actor: Actor,
    client: String,
    mut input: Partner,
) -> Result<Value> {
    validation::id(&input.id)?;
    input.name = validation::text(&input.name, 100, true, false)?;
    db.write(move |tx| {
        authorize(tx, &actor, &client, true)?;
        security::require(tx, &actor, "finance.read_company", None)?;
        if let Some(old) = tx
            .query_row(
                "SELECT id,name,created_by,archived_at FROM commercial_partners WHERE id=?1",
                [&input.id],
                row_json,
            )
            .optional()?
        {
            if old["name"] != input.name || old["created_by"] != actor.user_id {
                return Err(Error::Conflict("command_conflict"));
            }
            return Ok(json!({"id":input.id,"replayed":true}));
        }
        security::client(tx, &client, true)?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM commercial_partners WHERE name=?1)",
            [&input.name],
            |r| r.get(0),
        )?;
        if exists {
            return Err(Error::Conflict("partner_exists"));
        }
        tx.execute(
            "INSERT INTO commercial_partners(id,name,created_by,created_at) VALUES (?1,?2,?3,?4)",
            params![input.id, input.name, actor.user_id, validation::now()],
        )?;
        audit_revision(
            tx,
            &actor,
            &client,
            &input.id,
            "commercial_partner",
            "created",
            (None, 1),
        )?;
        Ok(json!({"id":input.id,"replayed":false}))
    })
    .await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    pub amount_minor: String,
    pub currency: String,
    pub roise_share_minor: String,
    pub partner_id: Option<String>,
    pub collector: String,
    pub allocation_policy: String,
}
impl Terms {
    fn normalize(&mut self) -> Result<(i64, i64)> {
        let amount = validation::exact_integer(&self.amount_minor, true)?;
        let share = validation::exact_integer(&self.roise_share_minor, false)?;
        billing::exponent(&self.currency)?;
        self.partner_id = self
            .partner_id
            .take()
            .map(|v| validation::id(&v))
            .transpose()?;
        if share > amount
            || !["roise", "partner"].contains(&self.collector.as_str())
            || !["proportional", "contractual"].contains(&self.allocation_policy.as_str())
            || (self.partner_id.is_none() && (share != amount || self.collector != "roise"))
        {
            return Err(Error::Invalid("invalid_allocation"));
        }
        Ok((amount, share))
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    pub command_id: String,
    pub title: String,
    pub service_type: String,
    pub frequency: String,
    pub start_date: String,
    pub end_date: Option<String>,
    pub due_offset_days: i64,
    pub timezone: Option<String>,
    pub terms: Terms,
}
fn insert_terms(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    version: (i64, &str),
    terms: &Terms,
    amounts: (i64, i64),
) -> Result<()> {
    let (number, effective) = version;
    let (amount, share) = amounts;
    if let Some(partner) = &terms.partner_id {
        let active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM commercial_partners WHERE id=?1 AND archived_at IS NULL)",
            [partner],
            |r| r.get(0),
        )?;
        if !active {
            return Err(Error::Invalid("invalid_partner"));
        }
    }
    tx.execute("INSERT INTO agreement_versions(id,agreement_id,client_id,number,amount_minor,currency,roise_share_minor,partner_id,collector,allocation_policy,effective_from,created_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![validation::new_id(),id,client,number,amount,terms.currency,share,terms.partner_id,terms.collector,terms.allocation_policy,effective,actor.user_id,validation::now()])?;
    Ok(())
}
pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    mut input: Create,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    input.title = validation::text(&input.title, 200, true, false)?;
    let start = schedule::date(&input.start_date)?;
    input.end_date = input.end_date.map(|v| validation::date(&v)).transpose()?;
    if ![
        "software_maintenance",
        "software_development",
        "advertising_consulting",
        "other",
    ]
    .contains(&input.service_type.as_str())
        || !["once", "monthly"].contains(&input.frequency.as_str())
        || !(0..=90).contains(&input.due_offset_days)
        || input
            .end_date
            .as_ref()
            .is_some_and(|v| v < &input.start_date)
    {
        return Err(Error::Invalid("invalid_agreement"));
    }
    if let Some(zone) = &input.timezone {
        schedule::zone(zone)?;
    }
    let (amount, share) = input.terms.normalize()?;
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;
        if let Some(old)=tx.query_row("SELECT id,created_by,command_hash FROM service_agreements WHERE client_id=?1 AND command_id=?2",params![client,input.command_id],row_json).optional()? {
            if old["created_by"]!=actor.user_id || old["command_hash"]!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":old["id"],"replayed":true}));
        }
        security::client(tx,&client,true)?;
        security::require_any(tx,&actor,&["billing.create","billing.manage"],&client)?;
        let timezone=match input.timezone{Some(v)=>v,None=>tx.query_row("SELECT timezone FROM operation_settings WHERE id=1",[],|r|r.get(0))?};
        if start<schedule::today(&timezone)?{return Err(Error::Invalid("historical_billing_requires_reconciliation"))}
        let id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO service_agreements(id,client_id,created_by,managed_by,title,service_type,frequency,start_date,end_date,due_offset_days,timezone,anchor_day,next_date,status,command_id,command_hash,created_at,updated_at) VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8,?9,?10,?11,?7,'active',?12,?13,?14,?14)",params![id,client,actor.user_id,input.title,input.service_type,input.frequency,input.start_date,input.end_date,input.due_offset_days,timezone,start.day(),input.command_id,digest,now])?;
        insert_terms(tx,&actor,&client,&id,(1,&input.start_date),&input.terms,(amount,share))?;
        audit_revision(tx,&actor,&client,&id,"service_agreement","created",(None,1))?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
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
    db.read(move|tx|{
        authorize(tx,&actor,&client,false)?;
        let mut stmt=tx.prepare(&format!("SELECT {AGREEMENT} FROM service_agreements a JOIN users u ON u.id=a.managed_by WHERE a.client_id=?1 AND (?2 IS NULL OR a.id>?2) AND (?3='all' OR a.status=?3) ORDER BY a.id LIMIT ?4"))?;
        page.page(stmt.query_map(params![client,page.cursor,status,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
fn document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    Ok(tx.query_row(&format!("SELECT {AGREEMENT} FROM service_agreements a JOIN users u ON u.id=a.managed_by WHERE a.id=?1 AND a.client_id=?2"),params![id,client],row_json)?)
}
pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, false)?;
        document(tx, &client, &id)
    })
    .await
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
        let mut stmt=tx.prepare(&format!("SELECT {VERSION} FROM agreement_versions v LEFT JOIN commercial_partners p ON p.id=v.partner_id WHERE v.agreement_id=?1 AND (?2 IS NULL OR v.id>?2) ORDER BY v.id LIMIT ?3"))?;
        page.page(stmt.query_map(params![id,page.cursor,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub command_id: String,
    pub expected_revision: String,
    pub status: Option<String>,
    pub managed_by: Option<String>,
    pub effective_from: Option<String>,
    pub terms: Option<Terms>,
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
    input.effective_from = input
        .effective_from
        .map(|v| validation::date(&v))
        .transpose()?;
    let amounts = input.terms.as_mut().map(Terms::normalize).transpose()?;
    if input.terms.is_some() != input.effective_from.is_some()
        || (input.status.is_some() as u8
            + input.managed_by.is_some() as u8
            + input.terms.is_some() as u8)
            != 1
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;let old=document(tx,&client,&id)?;
        let replay:Option<(String,String)>=tx.query_row("SELECT actor_id,payload_hash FROM agreement_commands WHERE agreement_id=?1 AND command_id=?2",params![id,input.command_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((user,hash))=replay {if user!=actor.user_id || hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":id,"replayed":true}));}
        security::client(tx,&client,true)?;
        let previous=validation::exact_integer(old["revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(previous,expected)?;
        if matches!(old["status"].as_str(),Some("cancelled"|"expired")){return Err(Error::Conflict("agreement_closed"))}
        let zone=old["timezone"].as_str().ok_or(Error::Internal)?;let today=schedule::today(zone)?;
        if let Some(status)=&input.status{
            if !["active","paused","cancelled"].contains(&status.as_str()) || old["status"]==*status{return Err(Error::Invalid("invalid_transition"))}
            let next_date=if status=="active"{
                let start=schedule::date(old["next_date"].as_str().ok_or(Error::Internal)?)?;
                if old["frequency"]=="monthly"{schedule::on_or_after(start,today,"monthly",1,old["anchor_day"].as_u64().ok_or(Error::Internal)? as u32)?}else{today.max(start)}.to_string()
            }else{old["next_date"].as_str().ok_or(Error::Internal)?.to_owned()};
            if status=="active" && old["end_date"].as_str().is_some_and(|end|end<next_date.as_str()){return Err(Error::Conflict("agreement_expired"))}
            tx.execute("UPDATE service_agreements SET status=?1,next_date=?2 WHERE id=?3",params![status,next_date,id])?;
        }
        if let Some(manager)=&input.managed_by{
            if !security::allowed_user(tx,manager,"agreements.manage",Some(&client))? || !(security::allowed_user(tx,manager,"billing.create",Some(&client))? || security::allowed_user(tx,manager,"billing.manage",Some(&client))?) || !security::allowed_user(tx,manager,"clients.view",Some(&client))? || !security::allowed_user(tx,manager,"billing.view",Some(&client))?{return Err(Error::Invalid("invalid_manager"))}
            tx.execute("UPDATE service_agreements SET managed_by=?1 WHERE id=?2",params![manager,id])?;
        }
        if let (Some(terms),Some(effective),Some((amount,share)))=(&input.terms,&input.effective_from,amounts){
            let last:Value=tx.query_row("SELECT currency,effective_from,number FROM agreement_versions WHERE agreement_id=?1 ORDER BY number DESC LIMIT 1",[&id],row_json)?;
            if *effective<=today.to_string() || last["effective_from"].as_str().is_some_and(|v|v>=effective.as_str()) || last["currency"]!=terms.currency{return Err(Error::Invalid("future_terms_required"))}
            insert_terms(tx,&actor,&client,&id,(last["number"].as_i64().ok_or(Error::Internal)?.checked_add(1).ok_or(Error::Internal)?,effective),terms,(amount,share))?;
        }
        tx.execute("UPDATE service_agreements SET revision=?1,updated_at=?2 WHERE id=?3",params![next,validation::now(),id])?;
        tx.execute("INSERT INTO agreement_commands VALUES (?1,?2,?3,?4,?5)",params![id,input.command_id,actor.user_id,digest,validation::now()])?;
        tx.execute("DELETE FROM automation_failures WHERE kind='agreement' AND resource_id=?1",[&id])?;
        audit_revision(tx,&actor,&client,&id,"service_agreement","updated",(Some(previous),next))?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
}
pub(crate) fn generate_in_transaction(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    id: &str,
    date: &str,
) -> Result<Value> {
    let timezone: String = tx.query_row(
        "SELECT timezone FROM service_agreements WHERE id=?1 AND client_id=?2",
        params![id, client],
        |r| r.get(0),
    )?;
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
    let agreement = document(tx, client, id)?;
    let billing_date = schedule::date(date)?;
    let period_key = if agreement["frequency"] == "monthly" {
        date[..7].to_owned()
    } else {
        date.to_owned()
    };
    if let Some(period) = tx
        .query_row(
            "SELECT id FROM billing_periods WHERE agreement_id=?1 AND period_key=?2",
            params![id, period_key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(json!({"id":period,"replayed":true}));
    }
    security::client(tx, client, true)?;
    if agreement["status"] != "active"
        || agreement["next_date"] != date
        || billing_date > today
        || (today - billing_date).num_days() > 62
        || agreement["end_date"].as_str().is_some_and(|end| end < date)
    {
        return Err(Error::Conflict("period_not_due"));
    }
    let version:Value=tx.query_row("SELECT id,amount_minor,currency FROM agreement_versions WHERE agreement_id=?1 AND effective_from<=?2 ORDER BY effective_from DESC LIMIT 1",params![id,date],row_json)?;
    let due = billing_date
        .checked_add_signed(Duration::days(
            agreement["due_offset_days"]
                .as_i64()
                .ok_or(Error::Internal)?,
        ))
        .ok_or(Error::Invalid("invalid_schedule"))?
        .to_string();
    validation::date(&due)?;
    let collection = billing::create_in_transaction(
        tx,
        actor,
        client,
        billing::Terms {
            description: format!(
                "{} · {}",
                agreement["title"].as_str().ok_or(Error::Internal)?,
                period_key
            ),
            note: String::new(),
            amount: version["amount_minor"].as_i64().ok_or(Error::Internal)?,
            currency: version["currency"].as_str().ok_or(Error::Internal)?.into(),
            due: Some(due),
        },
    )?;
    let period = validation::new_id();
    let now = validation::now();
    tx.execute("INSERT INTO billing_periods(id,agreement_id,client_id,version_id,collection_id,currency,period_key,billing_date,created_by,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![period,id,client,version["id"].as_str(),collection.id,version["currency"].as_str(),period_key,date,actor.user_id,now])?;
    let previous =
        validation::exact_integer(agreement["revision"].as_str().ok_or(Error::Internal)?, true)?;
    let next = previous.checked_add(1).ok_or(Error::Internal)?;
    let (state, next_date) = if agreement["frequency"] == "once" {
        ("expired", date.to_owned())
    } else {
        let next_date = schedule::next(
            billing_date,
            "monthly",
            1,
            agreement["anchor_day"].as_u64().ok_or(Error::Internal)? as u32,
        )?
        .to_string();
        validation::date(&next_date)?;
        (
            if agreement["end_date"]
                .as_str()
                .is_some_and(|end| end < next_date.as_str())
            {
                "expired"
            } else {
                "active"
            },
            next_date,
        )
    };
    tx.execute("UPDATE service_agreements SET status=?1,next_date=?2,revision=?3,updated_at=?4 WHERE id=?5",params![state,next_date,next,now,id])?;
    audit_revision(
        tx,
        actor,
        client,
        id,
        "service_agreement",
        "updated",
        (Some(previous), next),
    )?;
    notifications::emit_period(
        tx,
        &period,
        "period_generated",
        &format!("period-generated:{period}"),
    )?;
    Ok(json!({"id":period,"replayed":false}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generate {
    pub billing_date: String,
}
pub async fn generate(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: Generate,
) -> Result<Value> {
    validation::date(&input.billing_date)?;
    db.write(move |tx| generate_in_transaction(tx, &actor, &client, &id, &input.billing_date))
        .await
}
pub(crate) fn period_document(tx: &Transaction<'_>, client: &str, id: &str) -> Result<Value> {
    let period = tx.query_row(
        &format!("{PERIOD_SQL} WHERE b.id=?1 AND b.client_id=?2"),
        params![id, client],
        row_json,
    )?;
    period_position(period)
}
pub(crate) fn period_position(mut period: Value) -> Result<Value> {
    let collected = period["paid_minor"].as_i64().ok_or(Error::Internal)?;
    let total = period["amount_minor"].as_i64().ok_or(Error::Internal)?;
    let share = period["roise_share_minor"]
        .as_i64()
        .ok_or(Error::Internal)?;
    let roise = period["net_roise"]
        .as_str()
        .ok_or(Error::Internal)?
        .to_owned();
    let transferred = period["net_settled"]
        .as_str()
        .ok_or(Error::Internal)?
        .to_owned();
    period
        .as_object_mut()
        .ok_or(Error::Internal)?
        .remove("net_roise");
    period
        .as_object_mut()
        .ok_or(Error::Internal)?
        .remove("net_settled");
    let position = allocation::position(allocation::Funds {
        total,
        roise_share: share,
        collected,
        roise_collected: validation::exact_integer(&roise, false)?,
        collector_is_roise: period["collector"] == "roise",
        contractual: period["allocation_policy"] == "contractual",
        transferred_to_roise: transferred.parse().map_err(|_| Error::Internal)?,
    })?;
    for (key, value) in [
        ("amount_minor", position.contracted),
        ("paid_minor", position.collected),
        ("outstanding_minor", position.customer_outstanding),
        ("roise_share_minor", position.roise_contract),
        ("partner_share_minor", position.partner_contract),
        ("roise_recognized_minor", position.roise_recognized),
        ("partner_recognized_minor", position.partner_recognized),
    ] {
        period[key] = json!(value.to_string());
    }
    period["internal_due_to_roise_minor"] = json!(position.internal_due_to_roise.to_string());
    period["settled_to_roise_minor"] = json!(position.transferred_to_roise.to_string());
    period["internal_remaining_to_roise_minor"] = json!(position.remaining_to_roise.to_string());
    if period["voided_at"].is_string() {
        if collected != 0 || transferred != "0" {
            return Err(Error::Internal);
        }
        for key in [
            "outstanding_minor",
            "roise_recognized_minor",
            "partner_recognized_minor",
            "internal_due_to_roise_minor",
            "internal_remaining_to_roise_minor",
        ] {
            period[key] = json!("0");
        }
    }
    Ok(period)
}
pub(crate) const PERIOD_FILTERS: &[&str] = &[
    "limit",
    "cursor",
    "currency",
    "from",
    "to",
    "q",
    "service_type",
    "collector",
    "payment_status",
    "partner_id",
    "payment_collector",
];
pub async fn periods(
    db: &Database,
    actor: Actor,
    client: String,
    agreement: Option<String>,
    q: Query,
) -> Result<Value> {
    let page = q.paging()?;
    let currency = q.get("currency").unwrap_or("").to_owned();
    if !currency.is_empty() {
        billing::exponent(&currency)?;
    }
    let from = q.get("from").map(validation::date).transpose()?;
    let to = q.get("to").map(validation::date).transpose()?;
    if from.as_ref().zip(to.as_ref()).is_some_and(|(a, b)| a > b) {
        return Err(Error::Invalid("invalid_dates"));
    }
    let service = q
        .choice(
            "service_type",
            "",
            &[
                "",
                "software_maintenance",
                "software_development",
                "advertising_consulting",
                "other",
            ],
        )?
        .to_owned();
    let collector = q
        .choice("collector", "", &["", "roise", "partner"])?
        .to_owned();
    let payment_collector = q
        .choice("payment_collector", "", &["", "roise", "partner"])?
        .to_owned();
    let status = q
        .choice(
            "payment_status",
            "",
            &[
                "",
                "pending",
                "partially_paid",
                "paid",
                "overdue",
                "cancelled",
            ],
        )?
        .to_owned();
    let search = q.text("q", 100)?;
    let partner = q.get("partner_id").unwrap_or("").to_owned();
    if !partner.is_empty() && partner != "none" {
        validation::id(&partner)?;
    }
    db.read(move|tx|{
        authorize(tx,&actor,&client,false)?;
        if let Some(agreement)=&agreement{document(tx,&client,agreement)?;}
        let mut stmt=tx.prepare(&format!("{PERIOD_SQL} WHERE b.client_id=?1 AND (?2 IS NULL OR b.agreement_id=?2) AND (?3 IS NULL OR b.id>?3) AND (?4='' OR b.currency=?4) AND (?5 IS NULL OR b.billing_date>=?5) AND (?6 IS NULL OR b.billing_date<=?6) AND (?8='' OR a.service_type=?8) AND (?9='' OR v.collector=?9) AND (?10='' OR CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled' WHEN c.paid_minor>=c.amount_minor THEN 'paid' WHEN c.due_date<?13 THEN 'overdue' WHEN c.paid_minor>0 THEN 'partially_paid' ELSE 'pending' END=?10) AND (?11='' OR instr(unicode_lower(a.title),unicode_lower(?11))>0) AND (?12='' OR (?12='none' AND v.partner_id IS NULL) OR v.partner_id=?12) AND (?14='' OR EXISTS(SELECT 1 FROM payments pm WHERE pm.collection_id=b.collection_id AND pm.collector=?14 AND pm.amount_minor>CAST((SELECT exact_sum(rv.amount_minor) FROM payment_reversals rv WHERE rv.payment_id=pm.id) AS INTEGER))) ORDER BY b.id LIMIT ?7"))?;
        let rows=stmt.query_map(params![client,agreement,page.cursor,currency,from,to,(page.limit+1) as i64,service,collector,status,search,partner,billing::today(),payment_collector],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        page.page(rows.into_iter().map(period_position).collect::<Result<Vec<_>>>()?)
    }).await
}
pub async fn period(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, false)?;
        period_document(tx, &client, &id)
    })
    .await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settlement {
    pub command_id: String,
    pub expected_revision: String,
    pub direction: String,
    pub amount_minor: String,
    pub currency: String,
    pub settled_on: String,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub note: String,
}
pub async fn settle(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    mut input: Settlement,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    let amount = validation::exact_integer(&input.amount_minor, true)?;
    billing::exponent(&input.currency)?;
    input.settled_on = validation::date(&input.settled_on)?;
    if input.settled_on > billing::today()
        || !["partner_to_roise", "roise_to_partner"].contains(&input.direction.as_str())
    {
        return Err(Error::Invalid("invalid_request"));
    }
    input.reference = validation::text(&input.reference, 200, false, false)?;
    input.note = validation::text(&input.note, 2000, false, true)?;
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;let old=period_document(tx,&client,&id)?;
        if let Some((user,hash))=tx.query_row("SELECT recorded_by,command_hash FROM internal_settlements WHERE period_id=?1 AND command_id=?2",params![id,input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
            if user!=actor.user_id || hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":id,"replayed":true}));
        }
        security::client(tx,&client,true)?;
        if old["currency"]!=input.currency || !old["voided_at"].is_null() || old["partner_id"].is_null(){return Err(Error::Conflict("invalid_settlement"))}
        let previous=validation::exact_integer(old["settlement_revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(previous,expected)?;
        let remaining:i128=old["internal_remaining_to_roise_minor"].as_str().ok_or(Error::Internal)?.parse().map_err(|_|Error::Internal)?;
        if (remaining>0)!=(input.direction=="partner_to_roise") || i128::from(amount)>remaining.abs(){return Err(Error::Conflict("invalid_settlement"))}
        let sid=validation::new_id();
        tx.execute("INSERT INTO internal_settlements(id,period_id,client_id,currency,direction,amount_minor,settled_on,reference,note,recorded_by,command_id,command_hash,recorded_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![sid,id,client,input.currency,input.direction,amount,input.settled_on,input.reference,input.note,actor.user_id,input.command_id,digest,validation::now()])?;
        audit_revision(tx,&actor,&client,&sid,"internal_settlement","created",(None,next))?;
        notifications::emit_period(tx,&id,"settlement_recorded",&format!("settlement-recorded:{sid}"))?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
}
pub async fn settlements(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    q: Query,
) -> Result<Value> {
    let page = q.paging()?;
    db.read(move|tx|{authorize(tx,&actor,&client,false)?;period_document(tx,&client,&id)?;
        let mut stmt=tx.prepare("SELECT id,period_id,client_id,currency,direction,CAST(amount_minor AS TEXT) AS amount_minor,settled_on,reference,note,recorded_by,recorded_at FROM internal_settlements WHERE period_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3")?;
        page.page(stmt.query_map(params![id,page.cursor,(page.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoidPeriod {
    command_id: String,
    expected_revision: String,
    reason: String,
}
pub async fn void_period(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    mut input: VoidPeriod,
) -> Result<Value> {
    validation::id(&input.command_id)?;
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    input.reason = validation::text(&input.reason, 2000, true, true)?;
    let digest = hash(&input)?;
    db.write(move|tx|{
        authorize(tx,&actor,&client,true)?;
        security::require(tx,&actor,"billing.delete",Some(&client)).map_err(hidden)?;
        security::require(tx,&actor,"finance.approve_adjustment",Some(&client)).map_err(hidden)?;
        let old=period_document(tx,&client,&id)?;
        if let Some((user,old_hash))=tx.query_row("SELECT actor_id,payload_hash FROM period_commands WHERE period_id=?1 AND command_id=?2",params![id,input.command_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?{
            if user!=actor.user_id || old_hash!=digest{return Err(Error::Conflict("command_conflict"))}return Ok(json!({"id":id,"replayed":true}));
        }
        security::client(tx,&client,true)?;
        let collection=old["collection_id"].as_str().ok_or(Error::Internal)?;
        if old["voided_at"].is_string() || tx.query_row("SELECT EXISTS(SELECT 1 FROM payments WHERE collection_id=?1) OR EXISTS(SELECT 1 FROM internal_settlements WHERE period_id=?2)",params![collection,id],|r|r.get::<_,bool>(0))? {return Err(Error::Conflict("period_has_transactions"))}
        let previous=validation::exact_integer(old["collection_revision"].as_str().ok_or(Error::Internal)?,true)?;let next=next_revision(previous,expected)?;let now=validation::now();
        tx.execute("UPDATE billing_periods SET voided_at=?1,voided_by=?2,void_reason=?3 WHERE id=?4",params![now,actor.user_id,input.reason,id])?;
        tx.execute("UPDATE collections SET cancelled_at=?1,revision=?2,updated_at=?1 WHERE id=?3",params![now,next,collection])?;
        tx.execute("INSERT INTO period_commands VALUES (?1,?2,?3,?4,?5)",params![id,input.command_id,actor.user_id,digest,now])?;
        audit_revision(tx,&actor,&client,collection,"billing","cancelled",(Some(previous),next))?;
        audit_revision(tx,&actor,&client,&id,"billing_period","updated",(Some(previous),next))?;
        Ok(json!({"id":id,"replayed":false}))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;
    fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
        validation::json(&serde_json::to_vec(&v).unwrap()).unwrap()
    }
    async fn agreement(
        f: &Fixture,
        partner: Option<String>,
        currency: &str,
        total: &str,
        share: &str,
        collector: &str,
    ) -> String {
        let a=create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"command_id":validation::new_id(),"title":"Synthetic service","service_type":if partner.is_none()&&currency=="USD"{"software_maintenance"}else{"advertising_consulting"},"frequency":"monthly","start_date":schedule::today("Europe/Bucharest").unwrap().to_string(),"due_offset_days":7,"terms":{"amount_minor":total,"currency":currency,"roise_share_minor":share,"partner_id":partner,"collector":collector,"allocation_policy":"proportional"}}))).await.unwrap();
        a["id"].as_str().unwrap().into()
    }
    async fn period_fixture(f: &Fixture, agreement: &str) -> Value {
        let a = read(&f.db, f.actor.clone(), f.client.clone(), agreement.into())
            .await
            .unwrap();
        let date = a["next_date"].as_str().unwrap().to_owned();
        let (first, second) = tokio::join!(
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                agreement.into(),
                Generate {
                    billing_date: date.clone()
                }
            ),
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                agreement.into(),
                Generate { billing_date: date }
            )
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first["id"], second["id"]);
        assert_ne!(first["replayed"], second["replayed"]);
        period(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            first["id"].as_str().unwrap().into(),
        )
        .await
        .unwrap()
    }
    async fn pay(f: &Fixture, p: &Value, amount: &str, collector: &str) -> billing::Mutation {
        billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),p["collection_id"].as_str().unwrap().into(),input(json!({"command_id":validation::new_id(),"expected_revision":p["collection_revision"],"amount_minor":amount,"currency":p["currency"],"collector":collector,"paid_on":billing::today(),"method":"bank_transfer","reference":"synthetic","note":""}))).await.unwrap()
    }
    async fn refresh(f: &Fixture, p: &Value) -> Value {
        period(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            p["id"].as_str().unwrap().into(),
        )
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn persisted_collector_partial_refund_settlement_and_retry_keep_one_customer_obligation()
    {
        let f = Fixture::new().await;
        let partner = validation::new_id();
        create_partner(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Partner {
                id: partner.clone(),
                name: "Synthetic advertising partner".into(),
            },
        )
        .await
        .unwrap();
        for (collector, collected, expected, customer) in [
            ("partner", "70000", "20000", "0"),
            ("roise", "70000", "-50000", "0"),
            ("partner", "35000", "10000", "35000"),
        ] {
            let a = agreement(
                &f,
                Some(partner.clone()),
                "EUR",
                "70000",
                "20000",
                collector,
            )
            .await;
            let initial = period_fixture(&f, &a).await;
            let payment = pay(&f, &initial, collected, collector).await;
            let p = refresh(&f, &initial).await;
            assert_eq!(p["amount_minor"], "70000");
            assert_eq!(p["outstanding_minor"], customer);
            assert_eq!(p["internal_remaining_to_roise_minor"], expected);
            assert_eq!(p["partner_share_minor"], "50000");
            let settle_input = json!({"command_id":validation::new_id(),"expected_revision":p["settlement_revision"],"direction":if collector=="roise"{"roise_to_partner"}else{"partner_to_roise"},"amount_minor":expected.trim_start_matches('-'),"currency":"EUR","settled_on":billing::today()});
            assert_eq!(
                settle(
                    &f.db,
                    f.actor.clone(),
                    f.client.clone(),
                    p["id"].as_str().unwrap().into(),
                    input(settle_input.clone())
                )
                .await
                .unwrap()["replayed"],
                false
            );
            assert_eq!(
                settle(
                    &f.db,
                    f.actor.clone(),
                    f.client.clone(),
                    p["id"].as_str().unwrap().into(),
                    input(settle_input)
                )
                .await
                .unwrap()["replayed"],
                true
            );
            let settled = refresh(&f, &p).await;
            assert_eq!(settled["internal_remaining_to_roise_minor"], "0");
            assert_eq!(settled["paid_minor"], collected);
            if collected == "70000" {
                let reversal = json!({"command_id":validation::new_id(),"expected_revision":settled["collection_revision"],"amount_minor":"35000","currency":"EUR","reversed_on":billing::today(),"reason":"Synthetic partial refund"});
                let pid = payment.payment_id.unwrap();
                billing::reverse(
                    &f.db,
                    f.actor.clone(),
                    f.client.clone(),
                    p["collection_id"].as_str().unwrap().into(),
                    pid.clone(),
                    input(reversal.clone()),
                )
                .await
                .unwrap();
                assert!(
                    billing::reverse(
                        &f.db,
                        f.actor.clone(),
                        f.client.clone(),
                        p["collection_id"].as_str().unwrap().into(),
                        pid,
                        input(reversal)
                    )
                    .await
                    .unwrap()
                    .replayed
                );
                let refunded = refresh(&f, &p).await;
                assert_eq!(refunded["outstanding_minor"], "35000");
                assert_eq!(
                    refunded["internal_remaining_to_roise_minor"],
                    if collector == "roise" {
                        "25000"
                    } else {
                        "-10000"
                    }
                );
            }
            let count: i64 = f
                .connection()
                .query_row(
                    "SELECT count(*) FROM collections WHERE id=?1",
                    [p["collection_id"].as_str()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
        let software = agreement(&f, None, "USD", "100000", "100000", "roise").await;
        let s = period_fixture(&f, &software).await;
        pay(&f, &s, "60000", "roise").await;
        let s = refresh(&f, &s).await;
        assert_eq!(s["outstanding_minor"], "40000");
        assert_eq!(s["currency"], "USD");
        assert_eq!(s["internal_remaining_to_roise_minor"], "0");
        let totals = billing::summary(&f.db, f.actor.clone(), f.client.clone())
            .await
            .unwrap();
        assert_eq!(totals.as_array().unwrap().len(), 2);
        let filters = Query::parse("currency=USD&service_type=software_maintenance&collector=roise&payment_status=partially_paid&partner_id=none&q=synthetic", PERIOD_FILTERS).unwrap();
        let report = periods(&f.db, f.actor.clone(), f.client.clone(), None, filters)
            .await
            .unwrap();
        assert_eq!(report["data"].as_array().unwrap().len(), 1);
        assert_eq!(report["data"][0]["id"], s["id"]);
        let partner_filter = Query::parse(
            &format!("currency=EUR&collector=partner&partner_id={partner}"),
            PERIOD_FILTERS,
        )
        .unwrap();
        let report = periods(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            None,
            partner_filter,
        )
        .await
        .unwrap();
        assert_eq!(report["data"].as_array().unwrap().len(), 2);
        // Contract responsibility and the actual collector are independent.
        let mixed_agreement = agreement(
            &f,
            Some(partner.clone()),
            "EUR",
            "70000",
            "20000",
            "partner",
        )
        .await;
        let mixed = period_fixture(&f, &mixed_agreement).await;
        pay(&f, &mixed, "35000", "roise").await;
        let mixed_report = periods(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            None,
            Query::parse("collector=partner&payment_collector=roise", PERIOD_FILTERS).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(mixed_report["data"].as_array().unwrap().len(), 1);
        assert_eq!(mixed_report["data"][0]["id"], mixed["id"]);
        // Simulate an elapsed due date in this isolated ledger fixture.
        let yesterday = chrono::Utc::now()
            .date_naive()
            .pred_opt()
            .unwrap()
            .to_string();
        f.connection()
            .execute(
                "UPDATE collections SET due_date=?1 WHERE id=?2",
                params![yesterday, s["collection_id"].as_str().unwrap()],
            )
            .unwrap();
        let overdue = periods(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Some(software),
            Query::parse("payment_status=overdue", PERIOD_FILTERS).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(overdue["data"][0]["id"], s["id"]);
        assert!(
            periods(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                None,
                Query::parse("from=2026-10-02&to=2026-10-01", PERIOD_FILTERS).unwrap()
            )
            .await
            .is_err()
        );
        assert!(
            periods(
                &f.db,
                f.actor,
                f.client,
                None,
                Query::parse("partner_id=invalid", PERIOD_FILTERS).unwrap()
            )
            .await
            .is_err()
        );
    }
    #[tokio::test]
    async fn agreements_preserve_historical_terms_pause_and_deny_unrelated_scope() {
        let f = Fixture::new().await;
        let a = agreement(&f, None, "USD", "100000", "100000", "roise").await;
        let p = period_fixture(&f, &a).await;
        let current = read(&f.db, f.actor.clone(), f.client.clone(), a.clone())
            .await
            .unwrap();
        let next = validation::new_id();
        let paused =
            json!({"command_id":next,"expected_revision":current["revision"],"status":"paused"});
        change(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            a.clone(),
            input(paused.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            change(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                a.clone(),
                input(paused)
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
                a.clone(),
                Generate {
                    billing_date: current["next_date"].as_str().unwrap().into()
                }
            )
            .await
            .is_err()
        );
        let other = crate::clients::create(
            &f.db,
            f.actor.clone(),
            input(json!({"name":"Synthetic other","tags":[]})),
        )
        .await
        .unwrap();
        assert!(
            read(&f.db, f.actor.clone(), other.id.clone(), a)
                .await
                .is_err()
        );
        assert!(
            period(
                &f.db,
                f.actor.clone(),
                other.id,
                p["id"].as_str().unwrap().into()
            )
            .await
            .is_err()
        );
        f.connection()
            .execute(
                "UPDATE clients SET archived_at=?1,updated_at=?1,revision=revision+1 WHERE id=?2",
                params![validation::now(), f.client],
            )
            .unwrap();
        assert_eq!(
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                p["agreement_id"].as_str().unwrap().into(),
                Generate {
                    billing_date: p["billing_date"].as_str().unwrap().into()
                }
            )
            .await
            .unwrap()["replayed"],
            true
        );
        assert!(billing::record_payment(&f.db,f.actor.clone(),f.client.clone(),p["collection_id"].as_str().unwrap().into(),input(json!({"command_id":validation::new_id(),"expected_revision":p["collection_revision"],"amount_minor":"100","currency":"USD","paid_on":billing::today(),"method":"bank_transfer","reference":"","note":""}))).await.is_err());
        let payments: i64 = f
            .connection()
            .query_row("SELECT count(*) FROM payments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(payments, 0);
    }
    #[tokio::test]
    async fn actual_month_end_periods_use_one_collection_and_preserve_future_price_versions() {
        let f = Fixture::new().await;
        let year = schedule::today("Europe/Bucharest").unwrap().year() + 1;
        let start = format!("{year}-01-31");
        let a=create(&f.db,f.actor.clone(),f.client.clone(),input(json!({"command_id":validation::new_id(),"title":"Synthetic month end maintenance","service_type":"software_maintenance","frequency":"monthly","start_date":start,"due_offset_days":0,"terms":{"amount_minor":"100000","currency":"USD","roise_share_minor":"100000","collector":"roise","allocation_policy":"proportional"}}))).await.unwrap();
        let id = a["id"].as_str().unwrap().to_owned();
        change(&f.db,f.actor.clone(),f.client.clone(),id.clone(),input(json!({"command_id":validation::new_id(),"expected_revision":"1","effective_from":format!("{year}-02-01"),"terms":{"amount_minor":"120000","currency":"USD","roise_share_minor":"120000","collector":"roise","allocation_policy":"proportional"}}))).await.unwrap();
        let mut historical = None;
        for month in [1, 2, 3] {
            let day = if month == 2 {
                if chrono::NaiveDate::from_ymd_opt(year, 2, 29).is_some() {
                    29
                } else {
                    28
                }
            } else {
                31
            };
            let date = format!("{year}-{month:02}-{day:02}");
            let actor = f.actor.clone();
            let client = f.client.clone();
            let id = id.clone();
            let period =
                f.db.write(move |tx| {
                    let now = schedule::date(&date)?;
                    let first = generate_at(tx, &actor, &client, &id, &date, now)?;
                    let again = generate_at(tx, &actor, &client, &id, &date, now)?;
                    assert_eq!(first["id"], again["id"]);
                    Ok(first["id"].as_str().unwrap().to_owned())
                })
                .await
                .unwrap();
            let value = super::period(&f.db, f.actor.clone(), f.client.clone(), period)
                .await
                .unwrap();
            assert_eq!(
                value["amount_minor"],
                if month == 1 { "100000" } else { "120000" }
            );
            if month == 1 {
                historical = Some(value["id"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(
            super::period(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                historical.unwrap()
            )
            .await
            .unwrap()["amount_minor"],
            "100000"
        );
        assert_eq!(
            f.connection()
                .query_row(
                    "SELECT count(*) FROM billing_periods WHERE agreement_id=?1",
                    [id],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
    }
    #[tokio::test]
    async fn period_void_retains_history_blocks_money_and_retries_safely() {
        let f = Fixture::new().await;
        let a = agreement(&f, None, "USD", "100000", "100000", "roise").await;
        let p = period_fixture(&f, &a).await;
        let command = json!({"command_id":validation::new_id(),"expected_revision":p["collection_revision"],"reason":"Synthetic incorrect service charge"});
        let id = p["id"].as_str().unwrap().to_owned();
        assert_eq!(
            void_period(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                input(command.clone())
            )
            .await
            .unwrap()["replayed"],
            false
        );
        assert_eq!(
            void_period(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id.clone(),
                input(command)
            )
            .await
            .unwrap()["replayed"],
            true
        );
        let cancelled = refresh(&f, &p).await;
        assert_eq!(cancelled["outstanding_minor"], "0");
        assert_eq!(cancelled["amount_minor"], "100000");
        let tx = f.connection();
        super::super::integrity::verify(&tx.unchecked_transaction().unwrap()).unwrap();
        let a = agreement(&f, None, "USD", "100000", "100000", "roise").await;
        let p = period_fixture(&f, &a).await;
        pay(&f, &p, "10000", "roise").await;
        let p = refresh(&f, &p).await;
        assert!(void_period(&f.db,f.actor.clone(),f.client.clone(),p["id"].as_str().unwrap().into(),input(json!({"command_id":validation::new_id(),"expected_revision":p["collection_revision"],"reason":"Synthetic unsupported void"}))).await.is_err());
    }
    #[tokio::test]
    async fn agreement_worker_uses_current_authority_generates_one_period_and_rejects_future_charges()
     {
        let f = Fixture::new().await;
        let id = agreement(&f, None, "USD", "100000", "100000", "roise").await;
        let partner = validation::new_id();
        create_partner(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Partner {
                id: partner.clone(),
                name: "Synthetic worker partner".into(),
            },
        )
        .await
        .unwrap();
        let consulting = agreement(&f, Some(partner), "EUR", "70000", "20000", "partner").await;
        let (a, b) = tokio::join!(
            super::super::automation::tick(&f.db),
            super::super::automation::tick(&f.db)
        );
        a.unwrap();
        b.unwrap();
        let count = f
            .connection()
            .query_row(
                "SELECT count(*) FROM billing_periods WHERE agreement_id=?1",
                [&id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert!(f.connection().query_row("SELECT count(*) FROM audit_events WHERE resource_id=?1 AND json_extract(metadata,'$.source')='job'",[&id],|r|r.get::<_,i64>(0)).unwrap()>0);
        let periods = periods(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            Some(consulting),
            Query::default(),
        )
        .await
        .unwrap();
        let consulting = &periods["data"][0];
        assert_eq!(consulting["amount_minor"], "70000");
        assert_eq!(consulting["roise_share_minor"], "20000");
        assert_eq!(consulting["partner_share_minor"], "50000");
        assert_eq!(consulting["internal_remaining_to_roise_minor"], "0");
        assert_eq!(periods["data"].as_array().unwrap().len(), 1);
        let doc = read(&f.db, f.actor.clone(), f.client.clone(), id.clone())
            .await
            .unwrap();
        assert!(
            generate(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                id,
                Generate {
                    billing_date: doc["next_date"].as_str().unwrap().into()
                }
            )
            .await
            .is_err()
        );
        super::super::integrity::verify(&f.connection().unchecked_transaction().unwrap()).unwrap();
    }
}
