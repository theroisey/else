use crate::{
    audit::{self, Snapshot},
    billing,
    db::Database,
    error::{Error, Result},
    query::{Query, row_json},
    security::{self, Actor},
    validation,
};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Exact(i64);
impl Serialize for Exact {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    title: String,
    #[serde(default)]
    note: String,
    currency: String,
    effective_from: String,
    effective_until: Option<String>,
    lines: Vec<LineInput>,
    expected_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LineInput {
    description: String,
    kind: String,
    frequency: String,
    quantity_micros: String,
    unit_price_minor: String,
    discount_bps: String,
    tax_bps: String,
    unit_cost_minor: Option<String>,
}

#[derive(Clone, Default, Serialize)]
struct Totals {
    base_minor: Exact,
    discount_minor: Exact,
    net_minor: Exact,
    tax_minor: Exact,
    total_minor: Exact,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost_minor: Option<Exact>,
}

#[derive(Clone, Serialize)]
struct Line {
    position: i64,
    description: String,
    kind: String,
    frequency: String,
    quantity_micros: Exact,
    unit_price_minor: Exact,
    discount_bps: Exact,
    tax_bps: Exact,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit_cost_minor: Option<Exact>,
    #[serde(flatten)]
    totals: Totals,
}

#[derive(Serialize)]
pub struct Calculation {
    currency: String,
    currency_exponent: i64,
    lines: Vec<Line>,
    #[serde(flatten)]
    totals: Totals,
}

struct Normalized {
    title: String,
    note: String,
    from: String,
    until: Option<String>,
    expected: Option<i64>,
    calculation: Calculation,
}

impl Profile {
    fn normalize(self, append: bool) -> Result<Normalized> {
        if self.expected_revision.is_some() != append || !(1..=50).contains(&self.lines.len()) {
            return Err(Error::Invalid("invalid_request"));
        }
        let title = validation::text(&self.title, 200, true, false)?;
        let note = validation::text(&self.note, 2000, false, true)?;
        let from = validation::date(&self.effective_from)?;
        let until = self
            .effective_until
            .map(|v| validation::date(&v))
            .transpose()?;
        if until.as_ref().is_some_and(|v| v <= &from) {
            return Err(Error::Invalid("invalid_request"));
        }
        let exponent = billing::exponent(&self.currency)?;
        let expected = self
            .expected_revision
            .map(|v| validation::exact_integer(&v, true))
            .transpose()?;
        let mut lines = vec![];
        let mut totals = Totals {
            cost_minor: Some(Exact(0)),
            ..Totals::default()
        };
        for (index, input) in self.lines.into_iter().enumerate() {
            let line = calculate_line(input, (index + 1) as i64)?;
            totals.base_minor = add(totals.base_minor, line.totals.base_minor)?;
            totals.discount_minor = add(totals.discount_minor, line.totals.discount_minor)?;
            totals.net_minor = add(totals.net_minor, line.totals.net_minor)?;
            totals.tax_minor = add(totals.tax_minor, line.totals.tax_minor)?;
            totals.total_minor = add(totals.total_minor, line.totals.total_minor)?;
            totals.cost_minor = totals
                .cost_minor
                .zip(line.totals.cost_minor)
                .map(|(a, b)| add(a, b))
                .transpose()?;
            lines.push(line);
        }
        Ok(Normalized {
            title,
            note,
            from,
            until,
            expected,
            calculation: Calculation {
                currency: self.currency,
                currency_exponent: exponent,
                lines,
                totals,
            },
        })
    }
}

fn add(a: Exact, b: Exact) -> Result<Exact> {
    a.0.checked_add(b.0)
        .map(Exact)
        .ok_or(Error::Invalid("invalid_request"))
}

pub fn half_up(a: i64, b: i64, denominator: i64) -> Result<i64> {
    if a < 0 || b < 0 || denominator <= 0 {
        return Err(Error::Invalid("invalid_request"));
    }
    let value =
        (i128::from(a) * i128::from(b) + i128::from(denominator / 2)) / i128::from(denominator);
    i64::try_from(value).map_err(|_| Error::Invalid("invalid_request"))
}

fn calculate_line(input: LineInput, position: i64) -> Result<Line> {
    let description = validation::text(&input.description, 200, true, false)?;
    if !["recurring", "one_time", "custom"].contains(&input.kind.as_str())
        || !["none", "weekly", "monthly", "quarterly", "yearly"].contains(&input.frequency.as_str())
        || (input.kind == "recurring" && input.frequency == "none")
        || (input.kind == "one_time" && input.frequency != "none")
    {
        return Err(Error::Invalid("invalid_request"));
    }
    let quantity = validation::exact_integer(&input.quantity_micros, true)?;
    let price = validation::exact_integer(&input.unit_price_minor, false)?;
    let discount = validation::exact_integer(&input.discount_bps, false)?;
    let tax = validation::exact_integer(&input.tax_bps, false)?;
    if discount > 10000 || tax > 10000 {
        return Err(Error::Invalid("invalid_request"));
    }
    let unit_cost = input
        .unit_cost_minor
        .map(|v| validation::exact_integer(&v, false))
        .transpose()?;
    let base = half_up(quantity, price, 1_000_000)?;
    let discount_amount = half_up(base, discount, 10000)?;
    let net = base - discount_amount;
    let tax_amount = half_up(net, tax, 10000)?;
    let total = net
        .checked_add(tax_amount)
        .ok_or(Error::Invalid("invalid_request"))?;
    let cost = unit_cost
        .map(|v| half_up(quantity, v, 1_000_000).map(Exact))
        .transpose()?;
    Ok(Line {
        position,
        description,
        kind: input.kind,
        frequency: input.frequency,
        quantity_micros: Exact(quantity),
        unit_price_minor: Exact(price),
        discount_bps: Exact(discount),
        tax_bps: Exact(tax),
        unit_cost_minor: unit_cost.map(Exact),
        totals: Totals {
            base_minor: Exact(base),
            discount_minor: Exact(discount_amount),
            net_minor: Exact(net),
            tax_minor: Exact(tax_amount),
            total_minor: Exact(total),
            cost_minor: cost,
        },
    })
}

/// Recompute every immutable line using the same exact arithmetic at import and
/// recovery boundaries; stored totals alone cannot establish calculation parity.
pub(crate) fn verify_lines(tx: &Transaction<'_>) -> Result<()> {
    let mut statement=tx.prepare("SELECT position,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,unit_cost_minor,base_minor,discount_minor,net_minor,tax_minor,total_minor,cost_minor FROM pricing_lines")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let calculated = calculate_line(
            LineInput {
                description: row.get(1)?,
                kind: row.get(2)?,
                frequency: row.get(3)?,
                quantity_micros: row.get::<_, i64>(4)?.to_string(),
                unit_price_minor: row.get::<_, i64>(5)?.to_string(),
                discount_bps: row.get::<_, i64>(6)?.to_string(),
                tax_bps: row.get::<_, i64>(7)?.to_string(),
                unit_cost_minor: row.get::<_, Option<i64>>(8)?.map(|v| v.to_string()),
            },
            row.get(0)?,
        )?;
        let totals = calculated.totals;
        if [
            totals.base_minor.0,
            totals.discount_minor.0,
            totals.net_minor.0,
            totals.tax_minor.0,
            totals.total_minor.0,
        ] != [
            row.get::<_, i64>(9)?,
            row.get::<_, i64>(10)?,
            row.get::<_, i64>(11)?,
            row.get::<_, i64>(12)?,
            row.get::<_, i64>(13)?,
        ] || totals.cost_minor.map(|v| v.0) != row.get::<_, Option<i64>>(14)?
        {
            return Err(Error::Internal);
        }
    }
    Ok(())
}

pub async fn preview(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Calculation> {
    let calculation = profile.normalize(false)?.calculation;
    db.read(move |tx| {
        authorize(tx, &actor, &client, true)?;
        Ok(calculation)
    })
    .await
}

#[derive(Serialize)]
pub struct Mutation {
    id: String,
    version_id: String,
    revision: String,
}

pub async fn create(
    db: &Database,
    actor: Actor,
    client: String,
    profile: Profile,
) -> Result<Mutation> {
    let profile = profile.normalize(false)?;
    db.write(move |tx| {
        authorize(tx, &actor, &client, true)?;
        let id = validation::new_id();
        tx.execute(
            "INSERT INTO pricing_sheets VALUES (?1,?2,?3,?4,1)",
            params![
                id,
                client,
                profile.calculation.currency,
                profile.calculation.currency_exponent
            ],
        )?;
        let version = insert_version(tx, &actor, &client, &id, 1, &profile)?;
        audit::mutation(
            tx,
            &actor,
            "pricing",
            &id,
            Some(&client),
            "created",
            (None, Snapshot::revision(1)),
        )?;
        Ok(Mutation {
            id,
            version_id: version,
            revision: "1".into(),
        })
    })
    .await
}

pub async fn append(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    profile: Profile,
) -> Result<Mutation> {
    let profile = profile.normalize(true)?;
    db.write(move |tx| {
        authorize(tx, &actor, &client, true)?;
        let (previous, currency): (i64, String) = tx.query_row(
            "SELECT revision,currency FROM pricing_sheets WHERE id=?1 AND client_id=?2",
            params![id, client],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let revision = billing::next_revision(
            previous,
            profile.expected.ok_or(Error::Invalid("invalid_request"))?,
        )?;
        let from: String = tx.query_row(
            "SELECT effective_from FROM pricing_versions WHERE sheet_id=?1 AND revision=?2",
            params![id, previous],
            |r| r.get(0),
        )?;
        if currency != profile.calculation.currency
            || profile.from < billing::today()
            || profile.from < from
        {
            return Err(Error::Conflict("conflict"));
        }
        let version = insert_version(tx, &actor, &client, &id, revision, &profile)?;
        tx.execute(
            "UPDATE pricing_sheets SET revision=?1 WHERE id=?2",
            params![revision, id],
        )?;
        audit::mutation(
            tx,
            &actor,
            "pricing",
            &id,
            Some(&client),
            "updated",
            (
                Some(Snapshot::revision(previous)),
                Snapshot::revision(revision),
            ),
        )?;
        Ok(Mutation {
            id,
            version_id: version,
            revision: revision.to_string(),
        })
    })
    .await
}

fn insert_version(
    tx: &Transaction<'_>,
    actor: &Actor,
    client: &str,
    sheet: &str,
    revision: i64,
    profile: &Normalized,
) -> Result<String> {
    let id = validation::new_id();
    let c = &profile.calculation;
    let t = &c.totals;
    tx.execute("INSERT INTO pricing_versions(id,sheet_id,client_id,currency,revision,title,note,effective_from,effective_until,created_by,created_at,base_minor,discount_minor,net_minor,tax_minor,total_minor,cost_minor) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",params![id,sheet,client,c.currency,revision,profile.title,profile.note,profile.from,profile.until,actor.user_id,validation::now(),t.base_minor.0,t.discount_minor.0,t.net_minor.0,t.tax_minor.0,t.total_minor.0,t.cost_minor.map(|v|v.0)])?;
    for line in &c.lines {
        let t = &line.totals;
        tx.execute("INSERT INTO pricing_lines VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",params![id,line.position,line.description,line.kind,line.frequency,line.quantity_micros.0,line.unit_price_minor.0,line.discount_bps.0,line.tax_bps.0,line.unit_cost_minor.map(|v|v.0),t.base_minor.0,t.discount_minor.0,t.net_minor.0,t.tax_minor.0,t.total_minor.0,t.cost_minor.map(|v|v.0)])?;
    }
    Ok(id)
}

pub async fn list(db: &Database, actor: Actor, client: String, query: Query) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,false)?;let costs=security::allowed_user(tx,&actor.user_id,"pricing.manage",Some(&client))?;
        let mut statement=tx.prepare("SELECT id FROM pricing_sheets WHERE client_id=?1 AND (?2 IS NULL OR id>?2) ORDER BY id LIMIT ?3")?;
        let ids=statement.query_map(params![client,paging.cursor,(paging.limit+1) as i64],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let data=ids.into_iter().map(|id|sheet_document(tx,&client,&id,costs)).collect::<Result<Vec<_>>>()?;paging.page(data)
    }).await
}

pub async fn read(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, false)?;
        sheet_document(
            tx,
            &client,
            &id,
            security::allowed_user(tx, &actor.user_id, "pricing.manage", Some(&client))?,
        )
    })
    .await
}

pub async fn versions(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    query: Query,
) -> Result<Value> {
    let paging = query.paging()?;
    db.read(move |tx| {
        authorize(tx,&actor,&client,false)?;sheet_identity(tx,&client,&id)?;let costs=security::allowed_user(tx,&actor.user_id,"pricing.manage",Some(&client))?;
        let mut statement=tx.prepare("SELECT id FROM pricing_versions WHERE sheet_id=?1 AND client_id=?2 AND (?3 IS NULL OR id>?3) ORDER BY id LIMIT ?4")?;
        let ids=statement.query_map(params![id,client,paging.cursor,(paging.limit+1) as i64],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let data=ids.into_iter().map(|version|version_document(tx,&client,&id,Some(&version),costs)).collect::<Result<Vec<_>>>()?;paging.page(data)
    }).await
}

pub async fn version(
    db: &Database,
    actor: Actor,
    client: String,
    id: String,
    version: String,
) -> Result<Value> {
    db.read(move |tx| {
        authorize(tx, &actor, &client, false)?;
        version_document(
            tx,
            &client,
            &id,
            Some(&version),
            security::allowed_user(tx, &actor.user_id, "pricing.manage", Some(&client))?,
        )
    })
    .await
}

fn sheet_identity(tx: &Transaction<'_>, client: &str, id: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT revision FROM pricing_sheets WHERE id=?1 AND client_id=?2",
        params![id, client],
        |r| r.get(0),
    )?)
}
fn sheet_document(tx: &Transaction<'_>, client: &str, id: &str, costs: bool) -> Result<Value> {
    Ok(
        serde_json::json!({"id":id,"client_id":client,"revision":sheet_identity(tx,client,id)?.to_string(),"latest_version":version_document(tx,client,id,None,costs)?}),
    )
}

const TOTAL_COLUMNS: &str = "CAST(base_minor AS TEXT) AS base_minor,CAST(discount_minor AS TEXT) AS discount_minor,CAST(net_minor AS TEXT) AS net_minor,CAST(tax_minor AS TEXT) AS tax_minor,CAST(total_minor AS TEXT) AS total_minor";
const LINE_COLUMNS: &str = "position,description,kind,frequency,CAST(quantity_micros AS TEXT) AS quantity_micros,CAST(unit_price_minor AS TEXT) AS unit_price_minor,CAST(discount_bps AS TEXT) AS discount_bps,CAST(tax_bps AS TEXT) AS tax_bps";

fn version_document(
    tx: &Transaction<'_>,
    client: &str,
    sheet: &str,
    version: Option<&str>,
    costs: bool,
) -> Result<Value> {
    let mut document=tx.query_row(&format!("SELECT v.id,v.sheet_id,v.client_id,v.currency,s.currency_exponent,CAST(v.revision AS TEXT) AS revision,v.title,v.note,v.effective_from,v.effective_until,v.created_by,v.created_at,{TOTAL_COLUMNS},CAST(v.cost_minor AS TEXT) AS cost_minor FROM pricing_versions v JOIN pricing_sheets s ON s.id=v.sheet_id WHERE v.sheet_id=?1 AND v.client_id=?2 AND ((?3 IS NULL AND v.revision=s.revision) OR v.id=?3)"),params![sheet,client,version],row_json)?;
    let id = document["id"].as_str().ok_or(Error::Internal)?.to_owned();
    let revision =
        validation::exact_integer(document["revision"].as_str().ok_or(Error::Internal)?, true)?;
    let successor: Option<String> = if let Some(next) = revision.checked_add(1) {
        tx.query_row(
            "SELECT effective_from FROM pricing_versions WHERE sheet_id=?1 AND revision=?2",
            params![sheet, next],
            |r| r.get(0),
        )
        .optional()?
    } else {
        None
    };
    let original = document["effective_until"].as_str().map(String::from);
    let window = match (original, successor) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    document["window_until"] = serde_json::to_value(window).map_err(|_| Error::Internal)?;
    let mut statement=tx.prepare(&format!("SELECT {LINE_COLUMNS},{TOTAL_COLUMNS},CAST(unit_cost_minor AS TEXT) AS unit_cost_minor,CAST(cost_minor AS TEXT) AS cost_minor FROM pricing_lines WHERE version_id=?1 ORDER BY position"))?;
    let mut lines = statement
        .query_map([id], row_json)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for line in &mut lines {
        omit_costs(line, costs);
    }
    document["lines"] = Value::Array(lines);
    omit_costs(&mut document, costs);
    Ok(document)
}

fn omit_costs(document: &mut Value, allowed: bool) {
    for key in ["unit_cost_minor", "cost_minor"] {
        if (!allowed || document[key].is_null())
            && let Some(object) = document.as_object_mut()
        {
            object.remove(key);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Copy {
    expected_revision: String,
    command_id: String,
    billing_date: String,
    due_date: Option<String>,
    #[serde(default)]
    internal_note: String,
}
#[derive(Serialize)]
pub struct Copied {
    pub id: String,
    pub revision: String,
    pub replayed: bool,
}

pub async fn copy(
    db: &Database,
    actor: Actor,
    client: String,
    sheet: String,
    version: String,
    mut input: Copy,
) -> Result<Copied> {
    let expected = validation::exact_integer(&input.expected_revision, true)?;
    validation::id(&input.command_id)?;
    input.billing_date = validation::date(&input.billing_date)?;
    input.due_date = input.due_date.map(|v| validation::date(&v)).transpose()?;
    input.internal_note = validation::text(&input.internal_note, 8000, false, true)?;
    if input.billing_date > billing::today() {
        return Err(Error::Invalid("invalid_request"));
    }
    db.write(move |tx| {
        authorize(tx,&actor,&client,false)?;
        security::require(tx,&actor,"billing.view",Some(&client)).map_err(hidden)?;security::require(tx,&actor,"billing.create",Some(&client)).map_err(hidden)?;
        let current=sheet_identity(tx,&client,&sheet)?;
        let selected=version_document(tx,&client,&sheet,Some(&version),false)?;
        let previous:Option<(String,String,bool)>=tx.query_row("SELECT s.collection_id,CAST(c.revision AS TEXT),(s.created_by=?1 AND s.sheet_id=?2 AND s.version_id=?3 AND s.expected_revision=?4 AND s.billing_date=?5 AND s.original_due_date IS ?6 AND s.original_internal_note=?7) FROM pricing_snapshots s JOIN collections c ON c.id=s.collection_id WHERE s.client_id=?8 AND s.command_id=?9",params![actor.user_id,sheet,version,expected,input.billing_date,input.due_date,input.internal_note,client,input.command_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((id,revision,equal))=previous {
            if !equal {return Err(Error::Conflict("conflict"));}return Ok(Copied{id,revision,replayed:true});
        }
        security::client(tx,&client,true)?;
        if current!=expected {return Err(Error::Conflict("conflict"));}
        let effective:Option<String>=tx.query_row("SELECT id FROM pricing_versions WHERE sheet_id=?1 AND effective_from<=?2 ORDER BY revision DESC LIMIT 1",params![sheet,input.billing_date],|r|r.get(0)).optional()?;
        if effective.as_deref()!=Some(&version) || selected["effective_until"].as_str().is_some_and(|until|input.billing_date.as_str()>=until) {return Err(Error::Conflict("conflict"));}
        let amount=validation::exact_integer(selected["total_minor"].as_str().ok_or(Error::Internal)?,true).map_err(|_|Error::Conflict("conflict"))?;
        let collection=billing::create_in_transaction(tx,&actor,&client,billing::Terms {description:selected["title"].as_str().ok_or(Error::Internal)?.into(),note:input.internal_note.clone(),amount,currency:selected["currency"].as_str().ok_or(Error::Internal)?.into(),due:input.due_date.clone()})?;
        tx.execute("INSERT INTO pricing_snapshots(collection_id,client_id,sheet_id,version_id,currency,command_id,expected_revision,created_by,created_at,billing_date,original_due_date,original_internal_note,title,base_minor,discount_minor,net_minor,tax_minor,total_minor) SELECT ?1,?2,?3,v.id,v.currency,?4,?5,?6,?7,?8,?9,?10,v.title,v.base_minor,v.discount_minor,v.net_minor,v.tax_minor,v.total_minor FROM pricing_versions v WHERE v.id=?11",params![collection.id,client,sheet,input.command_id,expected,actor.user_id,validation::now(),input.billing_date,input.due_date,input.internal_note,version])?;
        tx.execute("INSERT INTO pricing_snapshot_lines SELECT ?1,position,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,base_minor,discount_minor,net_minor,tax_minor,total_minor FROM pricing_lines WHERE version_id=?2",params![collection.id,version])?;
        Ok(Copied{id:collection.id,revision:collection.revision,replayed:false})
    }).await
}

pub async fn snapshot(db: &Database, actor: Actor, client: String, id: String) -> Result<Value> {
    db.read(move |tx| {
        security::require(tx,&actor,"billing.view",Some(&client)).map_err(hidden)?;security::client(tx,&client,false)?;
        let mut document=tx.query_row("SELECT s.collection_id,s.client_id,s.sheet_id,s.version_id,CAST(v.revision AS TEXT) AS pricing_revision,s.command_id,s.billing_date,s.title,s.created_by,s.created_at,s.currency,c.currency_exponent,CAST(s.base_minor AS TEXT) AS base_minor,CAST(s.discount_minor AS TEXT) AS discount_minor,CAST(s.net_minor AS TEXT) AS net_minor,CAST(s.tax_minor AS TEXT) AS tax_minor,CAST(s.total_minor AS TEXT) AS total_minor FROM pricing_snapshots s JOIN collections c ON c.id=s.collection_id JOIN pricing_versions v ON v.id=s.version_id WHERE s.collection_id=?1 AND s.client_id=?2",params![id,client],row_json)?;
        let mut statement=tx.prepare(&format!("SELECT {LINE_COLUMNS},{TOTAL_COLUMNS} FROM pricing_snapshot_lines WHERE collection_id=?1 ORDER BY position"))?;
        document["lines"]=Value::Array(statement.query_map([id],row_json)?.collect::<std::result::Result<Vec<_>,_>>()?);Ok(document)
    }).await
}

fn authorize(tx: &Transaction<'_>, actor: &Actor, client: &str, manage: bool) -> Result<()> {
    security::require(tx, actor, "pricing.view", Some(client)).map_err(hidden)?;
    if manage {
        security::require(tx, actor, "pricing.manage", Some(client)).map_err(hidden)?;
    }
    security::client(tx, client, manage)
}
fn hidden(error: Error) -> Error {
    match error {
        Error::Denied => Error::NotFound,
        _ => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Fixture;

    fn profile(from: &str) -> Profile {
        validation::json(serde_json::json!({"title":"Synthetic terms","currency":"EUR","effective_from":from,"lines":[{"description":"Synthetic service","kind":"custom","frequency":"none","quantity_micros":"1500000","unit_price_minor":"1","discount_bps":"2500","tax_bps":"10000","unit_cost_minor":"1"}]}).to_string().as_bytes()).unwrap()
    }

    #[test]
    fn calculation_rounds_each_step_and_rejects_overflow() {
        let calculation = profile("2020-01-01").normalize(false).unwrap().calculation;
        let totals = &calculation.totals;
        assert_eq!(
            [
                totals.base_minor.0,
                totals.discount_minor.0,
                totals.net_minor.0,
                totals.tax_minor.0,
                totals.total_minor.0
            ],
            [2, 1, 1, 1, 2]
        );
        assert_eq!(half_up(i64::MAX, 1_000_000, 1_000_000).unwrap(), i64::MAX);
        assert!(half_up(i64::MAX, i64::MAX, 1_000_000).is_err());
        assert_eq!(half_up(500_000, 1, 1_000_000).unwrap(), 1);
    }

    #[tokio::test]
    async fn immutable_versions_exact_copies_and_cost_privacy() {
        let f = Fixture::new().await;
        let created = create(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            profile("2020-01-01"),
        )
        .await
        .unwrap();
        let command = validation::new_id();
        let copy_input = || Copy {
            expected_revision: "1".into(),
            command_id: command.clone(),
            billing_date: "2020-01-01".into(),
            due_date: None,
            internal_note: "Synthetic private note".into(),
        };
        let copied = copy(
            &f.db,
            f.actor.clone(),
            f.client.clone(),
            created.id.clone(),
            created.version_id.clone(),
            copy_input(),
        )
        .await
        .unwrap();
        assert!(!copied.replayed);
        assert!(
            copy(
                &f.db,
                f.actor.clone(),
                f.client.clone(),
                created.id.clone(),
                created.version_id.clone(),
                copy_input()
            )
            .await
            .unwrap()
            .replayed
        );
        let captured = snapshot(&f.db, f.actor.clone(), f.client.clone(), copied.id.clone())
            .await
            .unwrap();
        assert_eq!(captured["total_minor"], "2");
        assert!(captured.get("cost_minor").is_none());
        assert!(captured["lines"][0].get("unit_cost_minor").is_none());
        let conn = f.connection();
        assert!(conn.execute("DELETE FROM pricing_versions", []).is_err());
        assert!(
            conn.execute(
                "UPDATE collections SET amount_minor=3 WHERE id=?1",
                [&copied.id]
            )
            .is_err()
        );
        assert!(conn.execute("INSERT INTO pricing_lines SELECT version_id,2,description,kind,frequency,quantity_micros,unit_price_minor,discount_bps,tax_bps,unit_cost_minor,base_minor,discount_minor,net_minor,tax_minor,total_minor,cost_minor FROM pricing_lines WHERE version_id=?1",[&created.version_id]).is_err());
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='pricing.manage'",
            [validation::now()],
        )
        .unwrap();
        let document = read(&f.db, f.actor.clone(), f.client.clone(), created.id)
            .await
            .unwrap();
        assert!(document["latest_version"].get("cost_minor").is_none());
        conn.execute(
            "UPDATE role_permissions SET revoked_at=?1 WHERE permission_key='pricing.view'",
            [validation::now()],
        )
        .unwrap();
        assert!(snapshot(&f.db, f.actor, f.client, copied.id).await.is_ok());
    }
}
