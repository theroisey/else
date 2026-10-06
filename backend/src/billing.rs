use crate::{
    audit::{self, Snapshot},
    db::Database,
    error::{Error, Result},
    query::{Query, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CURRENCIES: &[(&str, i64)] = &[
    ("EUR", 2),
    ("GBP", 2),
    ("JPY", 0),
    ("KWD", 3),
    ("TRY", 2),
    ("USD", 2),
];
const STATUS: &str = "CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled' WHEN c.paid_minor=c.amount_minor THEN 'paid' WHEN c.due_date<?3 THEN 'overdue' WHEN c.paid_minor>0 THEN 'partially_paid' ELSE 'pending' END";
const COLUMNS: &str = "c.id,c.client_id,c.created_by,c.description,c.internal_note,CAST(c.amount_minor AS TEXT) AS amount_minor,CAST(c.paid_minor AS TEXT) AS paid_minor,CAST(CASE WHEN c.cancelled_at IS NULL THEN c.amount_minor-c.paid_minor ELSE 0 END AS TEXT) AS outstanding_minor,c.currency,c.currency_exponent,c.due_date,c.cancelled_at,CAST(c.revision AS TEXT) AS revision,c.created_at,c.updated_at";
const PAYMENT_COLUMNS: &str = "id,client_id,collection_id,recorded_by,currency,CAST(amount_minor AS TEXT) AS amount_minor,paid_on,method,reference,note,command_id,CAST(collection_revision AS TEXT) AS collection_revision,recorded_at";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    description: String,
    #[serde(default)]
    internal_note: String,
    amount_minor: String,
    currency: String,
    due_date: Option<String>,
    expected_revision: Option<String>,
}

pub struct Terms {
    pub description: String,
    pub note: String,
    pub amount: i64,
    pub currency: String,
    pub due: Option<String>,
}

impl Profile {
    fn normalize(self, updating: bool) -> Result<(Terms, Option<i64>)> {
        if self.expected_revision.is_some() != updating {
            return Err(Error::Invalid("invalid_request"));
        }
        exponent(&self.currency)?;
        let expected = self
            .expected_revision
            .map(|v| validation::exact_integer(&v, true))
            .transpose()?;
        Ok((
            Terms {
                description: validation::text(&self.description, 2000, true, true)?,
                note: validation::text(&self.internal_note, 8000, false, true)?,
                amount: validation::exact_integer(&self.amount_minor, true)?,
                currency: self.currency,
                due: self.due_date.map(|v| validation::date(&v)).transpose()?,
            },
            expected,
        ))
    }
}

#[derive(Serialize)]
pub struct Mutation {
    pub id: String,
    pub revision: String,
    pub payment_id: Option<String>,
    pub replayed: bool,
}

pub async fn currencies(db: &Database, actor: Actor, client: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, None, false)?;
        Ok(Value::Array(
            CURRENCIES
                .iter()
                .map(|(code, exponent)| serde_json::json!({"code":code,"exponent":exponent}))
                .collect(),
        ))
    })
    .await
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    let status = query
        .choice(
            "status",
            "all",
            &[
                "all",
                "pending",
                "partially_paid",
                "paid",
                "overdue",
                "cancelled",
            ],
        )?
        .to_owned();
    let currency = query.get("currency").unwrap_or("").to_owned();
    if !currency.is_empty() {
        exponent(&currency)?;
    }
    let search = query.text("search", 100)?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,None,false)?;
        let mut statement=tx.prepare(&format!("SELECT {COLUMNS},{STATUS} AS status FROM collections c WHERE c.client_id=?1 AND (?2 IS NULL OR c.id>?2) AND (?4='all' OR ({STATUS})=?4) AND (?5='' OR c.currency=?5) AND (?6='' OR instr(unicode_lower(c.description),unicode_lower(?6))>0) ORDER BY c.id LIMIT ?7"))?;
        let data=statement.query_map(params![client,paging.cursor,today(),status,currency,search,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
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

pub async fn payments(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    query: Query,
) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,None,false)?;document(tx,&client,&id)?;
        let mut statement=tx.prepare(&format!("SELECT {PAYMENT_COLUMNS} FROM payments WHERE collection_id=?1 AND client_id=?2 AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT ?4"))?;
        let data=statement.query_map(params![id,client,paging.cursor,(paging.limit+1) as i64],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
        paging.page(data)
    }).await
}

pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    let (terms, _) = profile.normalize(false)?;
    db.write(move |tx| create_in_transaction(tx, &actor, &client, terms))
        .await
}

pub(crate) fn create_in_transaction(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    terms: Terms,
) -> Result<Mutation> {
    authorize(tx, actor, client, Some("billing.create"), true)?;
    let id = validation::new_id();
    let now = validation::now();
    let exponent = exponent(&terms.currency)?;
    tx.execute("INSERT INTO collections(id,client_id,created_by,description,internal_note,amount_minor,currency,currency_exponent,due_date,revision,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10)",params![id,client,actor.user_id,terms.description,terms.note,terms.amount,terms.currency,exponent,terms.due,now])?;
    let document = document(tx, client, &id)?;
    audit::mutation(
        tx,
        actor,
        "billing",
        &id,
        Some(client),
        "created",
        (None, snapshot(&document)?),
    )?;
    Ok(Mutation {
        id,
        revision: "1".into(),
        payment_id: None,
        replayed: false,
    })
}

pub async fn update(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    profile: Profile,
) -> Result<Mutation> {
    let (terms, expected) = profile.normalize(true)?;
    db.write(move |tx| {
        authorize(tx,&actor,&client,Some("billing.update"),true)?;
        let old=document(tx,&client,&id)?;let previous=revision(&old)?;let next=next_revision(previous,expected.ok_or(Error::Invalid("invalid_request"))?)?;
        if old["status"]=="cancelled" || old["currency"]!=terms.currency {return Err(Error::Conflict("conflict"));}
        tx.execute("UPDATE collections SET description=?1,internal_note=?2,amount_minor=?3,due_date=?4,revision=?5,updated_at=?6 WHERE id=?7",params![terms.description,terms.note,terms.amount,terms.due,next,validation::now(),id])?;
        audit::mutation(tx,&actor,"billing",&id,Some(&client),"updated",(Some(snapshot(&old)?), snapshot(&document(tx,&client,&id)?)?))?;
        Ok(Mutation{id,revision:next.to_string(),payment_id:None,replayed:false})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Payment {
    expected_revision: String,
    command_id: String,
    amount_minor: String,
    currency: String,
    paid_on: String,
    method: String,
    #[serde(default)]
    reference: String,
    #[serde(default)]
    note: String,
}

pub async fn record_payment(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    mut input: Payment,
) -> Result<Mutation> {
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    let amount = validation::exact_integer(&input.amount_minor, true)?;
    validation::id(&input.command_id)?;
    exponent(&input.currency)?;
    input.paid_on = validation::date(&input.paid_on)?;
    if input.paid_on > today()
        || !["bank_transfer", "cash", "card", "other"].contains(&input.method.as_str())
    {
        return Err(Error::Invalid("invalid_request"));
    }
    input.reference = validation::text(&input.reference, 200, false, false)?;
    input.note = validation::text(&input.note, 2000, false, true)?;
    db.write(move |tx| {
        // Authorized committed-command reconciliation precedes lifecycle checks.
        authorize(tx,&actor,&client,Some("billing.update"),false)?;
        let old=document(tx,&client,&id)?;
        let committed:Option<(String,bool)>=tx.query_row("SELECT id,(recorded_by=?1 AND expected_revision=?2 AND amount_minor=?3 AND currency=?4 AND paid_on=?5 AND method=?6 AND reference=?7 AND note=?8) FROM payments WHERE collection_id=?9 AND command_id=?10",params![actor.user_id,expected,amount,input.currency,input.paid_on,input.method,input.reference,input.note,id,input.command_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((payment_id,equal))=committed {
            if !equal {return Err(Error::Conflict("conflict"));}
            return Ok(Mutation{id,revision:revision(&old)?.to_string(),payment_id:Some(payment_id),replayed:true});
        }
        security::client(tx,&client,true)?;
        if old["status"]=="cancelled" || old["currency"]!=input.currency {return Err(Error::Conflict("conflict"));}
        let previous=revision(&old)?;let next=next_revision(previous,expected)?;
        let outstanding=validation::exact_integer(old["outstanding_minor"].as_str().ok_or(Error::Internal)?,false)?;
        if amount>outstanding {return Err(Error::Conflict("conflict"));}
        let payment_id=validation::new_id();let now=validation::now();
        tx.execute("INSERT INTO payments VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",params![payment_id,id,client,input.currency,actor.user_id,amount,input.paid_on,input.method,input.reference,input.note,input.command_id,expected,next,now])?;
        // A storage trigger applies the append-only ledger to the cached balance.
        tx.execute("UPDATE collections SET revision=?1,updated_at=?2 WHERE id=?3",params![next,now,id])?;
        audit::mutation(tx,&actor,"billing",&id,Some(&client),"payment_recorded",(Some(snapshot(&old)?), snapshot(&document(tx,&client,&id)?)?))?;
        Ok(Mutation{id,revision:next.to_string(),payment_id:Some(payment_id),replayed:false})
    }).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cancellation {
    expected_revision: String,
    confirm: bool,
}

pub async fn cancel(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    input: Cancellation,
) -> Result<Mutation> {
    if !input.confirm {
        return Err(Error::Invalid("invalid_request"));
    }
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    db.write(move |tx| {
        authorize(tx, &actor, &client, Some("billing.delete"), true)?;
        let old = document(tx, &client, &id)?;
        if matches!(old["status"].as_str(), Some("paid" | "cancelled")) {
            return Err(Error::Conflict("conflict"));
        }
        let next = next_revision(revision(&old)?, expected)?;
        let now = validation::now();
        tx.execute(
            "UPDATE collections SET cancelled_at=?1,updated_at=?1,revision=?2 WHERE id=?3",
            params![now, next, id],
        )?;
        audit::mutation(
            tx,
            &actor,
            "billing",
            &id,
            Some(&client),
            "cancelled",
            (
                Some(snapshot(&old)?),
                snapshot(&document(tx, &client, &id)?)?,
            ),
        )?;
        Ok(Mutation {
            id,
            revision: next.to_string(),
            payment_id: None,
            replayed: false,
        })
    })
    .await
}

pub async fn summary(db: &Database, actor: Actor, client: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, None, false)?;
        summary_in_transaction(tx, &client)
    })
    .await
}

pub(crate) fn summary_in_transaction(tx: &Transaction<'_>, client: &str) -> Result<Value> {
    summary_at(tx, client, &today())
}

pub(crate) fn summary_at(tx: &Transaction<'_>, client: &str, today: &str) -> Result<Value> {
    let mut groups: BTreeMap<String, (i64, [i128; 6])> = BTreeMap::new();
    let mut statement=tx.prepare("SELECT currency,currency_exponent,amount_minor,paid_minor,cancelled_at,due_date FROM collections WHERE client_id=?1")?;
    let mut rows = statement.query([client])?;
    while let Some(row) = rows.next()? {
        let currency: String = row.get(0)?;
        let exponent: i64 = row.get(1)?;
        let amount: i128 = i128::from(row.get::<_, i64>(2)?);
        let paid: i128 = i128::from(row.get::<_, i64>(3)?);
        let cancelled: Option<String> = row.get(4)?;
        let due: Option<String> = row.get(5)?;
        let (_, totals) = groups.entry(currency).or_insert((exponent, [0; 6]));
        let changes = if cancelled.is_some() {
            [0, 0, 0, 0, amount, paid]
        } else {
            [
                amount,
                paid,
                amount - paid,
                if due.as_ref().is_some_and(|d| d.as_str() < today) {
                    amount - paid
                } else {
                    0
                },
                0,
                0,
            ]
        };
        for (total, change) in totals.iter_mut().zip(changes) {
            *total = total.checked_add(change).ok_or(Error::Internal)?;
        }
    }
    Ok(Value::Array(groups.into_iter().map(|(currency,(exponent,totals))|serde_json::json!({"currency":currency,"currency_exponent":exponent,"amount_minor":totals[0].to_string(),"paid_minor":totals[1].to_string(),"outstanding_minor":totals[2].to_string(),"overdue_minor":totals[3].to_string(),"cancelled_amount_minor":totals[4].to_string(),"cancelled_paid_minor":totals[5].to_string()})).collect()))
}

pub fn exponent(currency: &str) -> Result<i64> {
    CURRENCIES
        .iter()
        .find(|c| c.0 == currency)
        .map(|c| c.1)
        .ok_or(Error::Invalid("invalid_request"))
}
pub fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}
pub fn next_revision(previous: i64, expected: i64) -> Result<i64> {
    if previous != expected || expected <= 0 {
        return Err(Error::Conflict("conflict"));
    }
    previous.checked_add(1).ok_or(Error::Conflict("conflict"))
}

fn authorize(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    write: Option<&str>,
    active: bool,
) -> Result<()> {
    security::require(tx, actor, "billing.view", Some(client)).map_err(hidden)?;
    if let Some(key) = write {
        security::require(tx, actor, key, Some(client)).map_err(hidden)?;
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
    Ok(tx.query_row(&format!("SELECT {COLUMNS},{STATUS} AS status FROM collections c WHERE c.client_id=?1 AND c.id=?2"),params![client,id,today()],row_json)?)
}
fn revision(document: &Value) -> Result<i64> {
    validation::exact_integer(document["revision"].as_str().ok_or(Error::Internal)?, true)
        .map_err(|_| Error::Internal)
}
fn snapshot(document: &Value) -> Result<Snapshot> {
    let field = |key: &str| {
        document[key]
            .as_str()
            .map(String::from)
            .ok_or(Error::Internal)
    };
    Ok(Snapshot {
        billing_status: Some(field("status")?),
        currency: Some(field("currency")?),
        amount_minor: Some(field("amount_minor")?),
        paid_minor: Some(field("paid_minor")?),
        ..Snapshot::revision(revision(document)?)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    #[tokio::test]
    async fn exact_ledger_commands_audit_and_archived_reconciliation() {
        let fixture = Fixture::new().await;
        let db = &fixture.db;
        let actor = fixture.actor.clone();
        let client = fixture.client.clone();
        let collection=create(db,actor.clone(),client.clone(),validation::json(br#"{"description":"Synthetic obligation","amount_minor":"9223372036854775807","currency":"USD"}"#).unwrap()).await.unwrap();
        create(db,actor.clone(),client.clone(),validation::json(br#"{"description":"Synthetic second obligation","amount_minor":"9223372036854775807","currency":"USD"}"#).unwrap()).await.unwrap();
        assert_eq!(
            summary(db, actor.clone(), client.clone()).await.unwrap()[0]["amount_minor"],
            "18446744073709551614"
        );
        let command = validation::new_id();
        let payment = || {
            validation::json::<Payment>(serde_json::json!({"expected_revision":"1","command_id":command,"amount_minor":"9007199254740993","currency":"USD","paid_on":"2020-01-01","method":"bank_transfer","reference":"Synthetic private reference"}).to_string().as_bytes()).unwrap()
        };
        let committed = record_payment(
            db,
            actor.clone(),
            client.clone(),
            collection.id.clone(),
            payment(),
        )
        .await
        .unwrap();
        assert_eq!(
            read(db, actor.clone(), client.clone(), collection.id.clone())
                .await
                .unwrap()["paid_minor"],
            "9007199254740993"
        );
        let replay = record_payment(
            db,
            actor.clone(),
            client.clone(),
            collection.id.clone(),
            payment(),
        )
        .await
        .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.payment_id, committed.payment_id);
        let mut mismatch = payment();
        mismatch.reference = "Different synthetic reference".into();
        assert!(
            record_payment(
                db,
                actor.clone(),
                client.clone(),
                collection.id.clone(),
                mismatch
            )
            .await
            .is_err()
        );
        let conn = fixture.connection();
        assert!(conn.execute("DELETE FROM payments", []).is_err());
        assert!(
            conn.execute(
                "UPDATE collections SET paid_minor=1 WHERE id=?1",
                [&collection.id]
            )
            .is_err()
        );
        assert!(
            conn.execute(
                "UPDATE collections SET amount_minor=amount_minor-1 WHERE id=?1",
                [&collection.id]
            )
            .is_err()
        );
        cancel(
            db,
            actor.clone(),
            client.clone(),
            collection.id.clone(),
            Cancellation {
                expected_revision: "2".into(),
                confirm: true,
            },
        )
        .await
        .unwrap();
        crate::clients::archive(
            db,
            actor.clone(),
            client.clone(),
            crate::clients::ConfirmRevision {
                expected_revision: 1,
                confirm: true,
            },
        )
        .await
        .unwrap();
        assert!(
            record_payment(
                db,
                actor.clone(),
                client.clone(),
                collection.id.clone(),
                payment()
            )
            .await
            .unwrap()
            .replayed
        );
        assert_eq!(
            read(db, actor.clone(), client.clone(), collection.id.clone())
                .await
                .unwrap()["outstanding_minor"],
            "0"
        );
        let leaked:i64=conn.query_row("SELECT count(*) FROM audit_events WHERE before_state LIKE '%Synthetic private%' OR after_state LIKE '%Synthetic private%'",[],|r|r.get(0)).unwrap();
        assert_eq!(leaked, 0);
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='billing.update'",
            [validation::now()],
        )
        .unwrap();
        assert!(
            record_payment(db, actor, client, collection.id, payment())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn queued_financial_writes_and_audit_failure_never_duplicate_payments() {
        let fixture = Fixture::new().await;
        let db = &fixture.db;
        let actor = fixture.actor.clone();
        let client = fixture.client.clone();
        let collection=create(db,actor.clone(),client.clone(),validation::json(br#"{"description":"Synthetic race obligation","amount_minor":"100","currency":"EUR"}"#).unwrap()).await.unwrap();
        let payment = || Payment {
            expected_revision: "1".into(),
            command_id: validation::new_id(),
            amount_minor: "60".into(),
            currency: "EUR".into(),
            paid_on: "2020-01-01".into(),
            method: "cash".into(),
            reference: String::new(),
            note: String::new(),
        };
        let conn = fixture.connection();
        conn.execute_batch("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        assert!(
            record_payment(
                db,
                actor.clone(),
                client.clone(),
                collection.id.clone(),
                payment()
            )
            .await
            .is_err()
        );
        assert_eq!(
            read(db, actor.clone(), client.clone(), collection.id.clone())
                .await
                .unwrap()["paid_minor"],
            "0"
        );
        conn.execute_batch("DROP TRIGGER reject_audit;").unwrap();
        let (first, second) = tokio::join!(
            record_payment(
                db,
                actor.clone(),
                client.clone(),
                collection.id.clone(),
                payment()
            ),
            record_payment(
                db,
                actor.clone(),
                client.clone(),
                collection.id.clone(),
                payment()
            )
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert_eq!(
            read(db, actor, client, collection.id).await.unwrap()["paid_minor"],
            "60"
        );
        assert_eq!(
            conn.query_row::<i64, _, _>("SELECT count(*) FROM payments", [], |r| r.get(0))
                .unwrap(),
            1
        );
    }
}
