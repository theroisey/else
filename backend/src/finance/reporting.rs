use crate::{
    billing,
    db::Database,
    error::{Error, Result},
    operations::{commercial, grant_sql},
    query::{Query, row_json},
    security::{self, Actor},
    validation,
};
use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::{Transaction, params_from_iter, types::Value as Sql};
use serde_json::{Value, json};

pub const KEYS: &[&str] = &[
    "currency",
    "from",
    "to",
    "client_id",
    "service_type",
    "agreement_id",
    "partner_id",
    "status",
    "method",
    "collector",
    "due_from",
    "due_to",
    "group",
    "q",
    "limit",
    "cursor",
];
const CAP: i64 = 50_000;
const CAP_SQL: &str = "SELECT (SELECT count(*) FROM visible) AS obligations,(SELECT count(*) FROM payment_data) AS payments,(SELECT count(*) FROM reversal_data) AS reversals,(SELECT count(*) FROM settlement_data) AS settlements FROM f";
fn check_caps(cap: &Value) -> Result<()> {
    if ["obligations", "payments", "reversals", "settlements"]
        .iter()
        .any(|k| cap[k].as_i64().is_some_and(|n| n > CAP))
    {
        return Err(Error::Invalid("report_range_too_large"));
    }
    Ok(())
}
#[derive(Clone)]
pub struct Filter {
    pub currency: String,
    pub from: String,
    pub to: String,
    pub client: Option<String>,
    pub service: String,
    pub agreement: Option<String>,
    pub partner: Option<String>,
    pub status: String,
    pub method: String,
    pub collector: String,
    pub due_from: Option<String>,
    pub due_to: Option<String>,
    pub group: String,
    pub search: String,
    pub previous_from: String,
    pub previous_to: String,
    pub year_from: String,
    pub year_to: String,
    pub year_available: bool,
}
impl Filter {
    pub fn parse(q: &Query) -> Result<Self> {
        let today = chrono::Utc::now().date_naive();
        let from = validation::date(
            q.get("from")
                .unwrap_or(&today.with_day(1).ok_or(Error::Internal)?.to_string()),
        )?;
        let to = validation::date(q.get("to").unwrap_or(&today.to_string()))?;
        let start = NaiveDate::parse_from_str(&from, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid_request"))?;
        let end = NaiveDate::parse_from_str(&to, "%Y-%m-%d")
            .map_err(|_| Error::Invalid("invalid_request"))?;
        if end < start
            || end > today
            || (start.year() != 1 && end.signed_duration_since(start).num_days() > 73_200)
        {
            return Err(Error::Invalid("invalid_report_period"));
        }
        let days = end.signed_duration_since(start).num_days() + 1;
        let previous_from = start
            .checked_sub_signed(Duration::days(days))
            .filter(|d| d.year() >= 1)
            .unwrap_or(start)
            .to_string();
        let previous_to = start
            .checked_sub_signed(Duration::days(1))
            .filter(|d| d.year() >= 1)
            .unwrap_or(start)
            .to_string();
        let prior_year = |d: NaiveDate| -> String {
            if d.year() <= 1 {
                return d.to_string();
            }
            d.with_year(d.year() - 1)
                .or_else(|| d.with_day(28).and_then(|v| v.with_year(v.year() - 1)))
                .unwrap_or(d)
                .to_string()
        };
        let year_from = prior_year(start);
        let year_to = prior_year(end);
        let currency = q.get("currency").unwrap_or("EUR").to_owned();
        billing::exponent(&currency)?;
        let due_from = q.get("due_from").map(validation::date).transpose()?;
        let due_to = q.get("due_to").map(validation::date).transpose()?;
        if due_from
            .as_ref()
            .zip(due_to.as_ref())
            .is_some_and(|(a, b)| a > b)
        {
            return Err(Error::Invalid("invalid_report_period"));
        }
        Ok(Self {
            currency,
            from,
            to,
            client: q.get("client_id").map(validation::id).transpose()?,
            service: q
                .choice(
                    "service_type",
                    "all",
                    &[
                        "all",
                        "software_maintenance",
                        "software_development",
                        "advertising_consulting",
                        "other",
                        "unclassified",
                    ],
                )?
                .into(),
            agreement: q.get("agreement_id").map(validation::id).transpose()?,
            partner: q.get("partner_id").map(validation::id).transpose()?,
            status: q
                .choice(
                    "status",
                    "all",
                    &[
                        "all",
                        "paid",
                        "partially_paid",
                        "pending",
                        "overdue",
                        "cancelled",
                    ],
                )?
                .into(),
            method: q
                .choice(
                    "method",
                    "all",
                    &["all", "bank_transfer", "cash", "card", "other"],
                )?
                .into(),
            collector: q
                .choice("collector", "all", &["all", "roise", "partner", "unknown"])?
                .into(),
            due_from,
            due_to,
            group: q
                .choice(
                    "group",
                    "month",
                    &["day", "week", "month", "quarter", "year"],
                )?
                .into(),
            search: q.text("q", 100)?,
            previous_from,
            previous_to,
            year_from,
            year_to,
            year_available: start.year() > 1,
        })
    }
}
pub struct Context {
    pub cte: String,
    pub args: Vec<Sql>,
    pub filter: Filter,
    pub as_of: String,
}
fn optional(v: Option<&String>) -> Sql {
    v.map_or(Sql::Null, |v| Sql::Text(v.clone()))
}
impl Context {
    pub fn new(tx: &Transaction<'_>, actor: &Actor, q: &Query) -> Result<Self> {
        security::fresh(tx, actor)?;
        let filter = Filter::parse(q)?;
        if let Some(client) = &filter.client {
            crate::operations::require(tx, actor, "billing.view", client, false)?;
        } else {
            security::require(tx, actor, "finance.read_company", None)?;
        }
        let p = q.paging()?;
        if p.descending {
            return Err(Error::Invalid("invalid_request"));
        }
        let as_of = validation::now();
        let args = vec![
            Sql::Text(actor.user_id.clone()),
            Sql::Text(filter.currency.clone()),
            optional(filter.client.as_ref()),
            Sql::Text(filter.from.clone()),
            Sql::Text(filter.to.clone()),
            Sql::Text(as_of[..10].into()),
            Sql::Text(filter.service.clone()),
            optional(filter.agreement.as_ref()),
            optional(filter.partner.as_ref()),
            Sql::Text(filter.status.clone()),
            Sql::Text(filter.method.clone()),
            Sql::Text(filter.collector.clone()),
            optional(filter.due_from.as_ref()),
            optional(filter.due_to.as_ref()),
            Sql::Text(filter.previous_from.clone()),
            Sql::Text(filter.previous_to.clone()),
            Sql::Text(filter.search.clone()),
            Sql::Integer(p.limit as i64),
            p.cursor.map_or(Sql::Null, Sql::Text),
            Sql::Text(filter.year_from.clone()),
            Sql::Text(filter.year_to.clone()),
        ];
        let base = format!(
            "{} AND {}",
            grant_sql("?1", "billing.view", "c.client_id"),
            grant_sql("?1", "clients.view", "c.client_id")
        );
        let base = crate::mcp::access::predicate(actor, "finance:read", "c.client_id", base)?;
        let base = crate::mcp::access::predicate(actor, "clients:read", "c.client_id", base)?;
        let terms = crate::mcp::access::predicate(
            actor,
            "finance:read",
            "c.client_id",
            grant_sql("?1", "agreements.view", "c.client_id"),
        )?;
        let settlement_access = crate::mcp::access::predicate(
            actor,
            "finance:read",
            "s.client_id",
            grant_sql("?1", "agreements.view", "s.client_id"),
        )?;
        let cte=format!("WITH f AS (SELECT ?1 usr,?2 currency,?3 client,?4 start,?5 finish,?6 today,?7 service,?8 agreement,?9 partner,?10 state,?11 method,?12 collector,?13 due_from,?14 due_to,?15 previous_start,?16 previous_finish,?17 search,?18 page_size,?19 cursor,?20 year_start,?21 year_finish), visible AS MATERIALIZED (
  SELECT c.*,n.name AS client_name,CASE WHEN {terms} THEN coalesce(a.service_type,'unclassified') ELSE 'unclassified' END AS service_type,CASE WHEN {terms} THEN b.agreement_id END AS agreement_id,CASE WHEN {terms} THEN v.partner_id END AS partner_id,coalesce(b.billing_date,substr(c.created_at,1,10)) AS billed_on,CASE WHEN c.cancelled_at IS NOT NULL THEN 'cancelled' WHEN c.paid_minor=c.amount_minor THEN 'paid' WHEN c.due_date<?6 THEN 'overdue' WHEN c.paid_minor>0 THEN 'partially_paid' ELSE 'pending' END AS status
  FROM collections c JOIN clients n ON n.id=c.client_id LEFT JOIN billing_periods b ON b.collection_id=c.id LEFT JOIN service_agreements a ON a.id=b.agreement_id LEFT JOIN agreement_versions v ON v.id=b.version_id
  WHERE c.currency=?2 AND (?3 IS NULL OR c.client_id=?3) AND {base} AND (?13 IS NULL OR c.due_date>=?13) AND (?14 IS NULL OR c.due_date<=?14) AND (?17='' OR instr(unicode_lower(n.name||' '||c.description),unicode_lower(?17))>0) LIMIT 50001),
  eligible AS MATERIALIZED (SELECT * FROM visible WHERE (?7='all' OR service_type=?7) AND (?8 IS NULL OR agreement_id=?8) AND (?9 IS NULL OR partner_id=?9) AND (?10='all' OR status=?10)),
  payment_data AS MATERIALIZED (SELECT p.id,p.collection_id,p.client_id,e.client_name,e.description,e.service_type,e.agreement_id,e.status,p.amount_minor,p.paid_on AS occurred_on,p.recorded_at,p.method,coalesce(p.collector,'unknown') AS collector,'payment' AS kind FROM payments p JOIN eligible e ON e.id=p.collection_id WHERE p.currency=?2 AND p.paid_on BETWEEN min(?15,?20) AND ?5 AND (?11='all' OR p.method=?11) AND (?12='all' OR coalesce(p.collector,'unknown')=?12) LIMIT 50001),
  reversal_data AS MATERIALIZED (SELECT r.id,r.collection_id,r.client_id,e.client_name,e.description,e.service_type,e.agreement_id,e.status,r.amount_minor,r.reversed_on AS occurred_on,r.recorded_at,p.method,coalesce(p.collector,'unknown') AS collector,'reversal' AS kind FROM payment_reversals r JOIN payments p ON p.id=r.payment_id JOIN eligible e ON e.id=r.collection_id WHERE r.currency=?2 AND r.reversed_on BETWEEN min(?15,?20) AND ?5 AND (?11='all' OR p.method=?11) AND (?12='all' OR coalesce(p.collector,'unknown')=?12) LIMIT 50001),
  events AS (SELECT *,amount_minor AS signed_minor FROM payment_data UNION ALL SELECT *,-amount_minor AS signed_minor FROM reversal_data), settlement_data AS MATERIALIZED (SELECT s.* FROM internal_settlements s JOIN billing_periods b ON b.id=s.period_id JOIN eligible e ON e.id=b.collection_id WHERE s.currency=?2 AND s.settled_on BETWEEN ?4 AND ?5 AND {settlement_access} LIMIT 50001) ");
        Ok(Self {
            cte,
            args,
            filter,
            as_of,
        })
    }
    pub fn rows(&self, tx: &Transaction<'_>, sql: &str) -> Result<Vec<Value>> {
        let full = self.cte.clone() + sql;
        let mut stmt = tx.prepare(&full)?;
        Ok(stmt
            .query_map(params_from_iter(self.args.iter()), row_json)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    /// One statement shares the eligible obligation and event materializations
    /// across all core aggregates. Column names come only from compiled queries.
    pub fn batch(&self, tx: &Transaction<'_>, queries: &[(&str, String)]) -> Result<Value> {
        let mut selections = Vec::new();
        for (name, sql) in queries {
            let stmt = tx.prepare(&(self.cte.clone() + sql))?;
            let fields = stmt
                .column_names()
                .iter()
                .map(|c| format!("'{c}',r.\"{c}\""))
                .collect::<Vec<_>>()
                .join(",");
            selections.push(format!(
                "(SELECT json_group_array(json_object({fields})) FROM ({sql}) r) AS {name}_json"
            ));
        }
        self.one(tx, &format!("SELECT {}", selections.join(",")))
    }
    pub fn one(&self, tx: &Transaction<'_>, sql: &str) -> Result<Value> {
        self.rows(tx, sql)?
            .into_iter()
            .next()
            .ok_or(Error::Internal)
    }
}
fn sum(field: &str) -> String {
    format!("coalesce(exact_sum({field}),'0')")
}
pub fn activity_sql(condition: &str) -> String {
    format!(
        "SELECT {} AS gross_minor,{} AS reversed_minor,{} AS net_minor,{} AS roise_minor,{} AS partner_minor,{} AS unknown_minor,CAST(count(CASE WHEN kind='payment' THEN 1 END) AS TEXT) AS payment_count,CAST(count(CASE WHEN kind='reversal' THEN 1 END) AS TEXT) AS reversal_count,max(occurred_on) AS latest_date FROM events WHERE {condition}",
        sum("CASE WHEN kind='payment' THEN amount_minor ELSE 0 END"),
        sum("CASE WHEN kind='reversal' THEN amount_minor ELSE 0 END"),
        sum("signed_minor"),
        sum("CASE WHEN collector='roise' THEN signed_minor ELSE 0 END"),
        sum("CASE WHEN collector='partner' THEN signed_minor ELSE 0 END"),
        sum("CASE WHEN collector='unknown' THEN signed_minor ELSE 0 END")
    )
}
pub async fn dashboard(db: &Database, actor: Actor, q: Query) -> Result<Value> {
    db.read(move|tx|{
 let ctx=Context::new(tx,&actor,&q)?;
 let bucket=match ctx.filter.group.as_str(){"day"=>"occurred_on" ,"week"=>"date(occurred_on,'-'||((CAST(strftime('%w',occurred_on) AS INTEGER)+6)%7)||' days')","month"=>"substr(occurred_on,1,7)","quarter"=>"substr(occurred_on,1,4)||'-Q'||((CAST(substr(occurred_on,6,2) AS INTEGER)+2)/3)",_=>"substr(occurred_on,1,4)"};

 let queries:Vec<(&str,String)>=vec![
("position",("SELECT coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor ELSE 0 END),'0') AS amount_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN paid_minor ELSE 0 END),'0') AS paid_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor-paid_minor ELSE 0 END),'0') AS outstanding_minor,coalesce(exact_sum(CASE WHEN status='overdue' THEN amount_minor-paid_minor ELSE 0 END),'0') AS overdue_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NOT NULL THEN amount_minor ELSE 0 END),'0') AS cancelled_amount_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NOT NULL THEN paid_minor ELSE 0 END),'0') AS cancelled_paid_minor,coalesce(exact_sum(CASE WHEN billed_on BETWEEN ?4 AND ?5 AND cancelled_at IS NULL THEN amount_minor ELSE 0 END),'0') AS issued_minor,CAST(count(*) AS TEXT) AS count,CAST(count(CASE WHEN cancelled_at IS NULL AND paid_minor=amount_minor THEN 1 END) AS TEXT) AS paid_count,CAST(count(CASE WHEN cancelled_at IS NULL AND paid_minor>0 AND paid_minor<amount_minor THEN 1 END) AS TEXT) AS partial_count,CAST(count(CASE WHEN cancelled_at IS NULL AND paid_minor=0 THEN 1 END) AS TEXT) AS unpaid_count,CAST(count(CASE WHEN status='overdue' THEN 1 END) AS TEXT) AS overdue_count,CAST(count(CASE WHEN cancelled_at IS NOT NULL THEN 1 END) AS TEXT) AS cancelled_count,CAST(count(DISTINCT CASE WHEN cancelled_at IS NULL AND paid_minor<amount_minor THEN client_id END) AS TEXT) AS debtor_count,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND paid_minor=amount_minor THEN amount_minor ELSE 0 END),'0') AS fully_paid_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND paid_minor>0 AND paid_minor<amount_minor THEN amount_minor-paid_minor ELSE 0 END),'0') AS partial_outstanding_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL AND paid_minor=0 THEN amount_minor ELSE 0 END),'0') AS unpaid_minor FROM eligible").to_owned()),
("activity",(activity_sql("occurred_on BETWEEN ?4 AND ?5")).to_owned()),
("previous",(activity_sql(if ctx.filter.from=="0001-01-01"{"0"}else{"occurred_on BETWEEN ?15 AND ?16"})).to_owned()),
("aging",("SELECT bucket,coalesce(exact_sum(outstanding),'0') AS amount_minor,CAST(count(*) AS TEXT) AS count,CAST(count(DISTINCT client_id) AS TEXT) AS clients FROM (SELECT client_id,amount_minor-paid_minor AS outstanding,CASE WHEN due_date IS NULL THEN 'undated' WHEN due_date>?6 THEN 'future' WHEN due_date=?6 THEN 'today' WHEN julianday(?6)-julianday(due_date)<=7 THEN '1_7' WHEN julianday(?6)-julianday(due_date)<=15 THEN '8_15' WHEN julianday(?6)-julianday(due_date)<=30 THEN '16_30' WHEN julianday(?6)-julianday(due_date)<=60 THEN '31_60' WHEN julianday(?6)-julianday(due_date)<=90 THEN '61_90' ELSE 'over_90' END AS bucket FROM eligible WHERE cancelled_at IS NULL AND paid_minor<amount_minor) GROUP BY bucket ORDER BY CASE bucket WHEN 'future' THEN 0 WHEN 'today' THEN 1 WHEN '1_7' THEN 2 WHEN '8_15' THEN 3 WHEN '16_30' THEN 4 WHEN '31_60' THEN 5 WHEN '61_90' THEN 6 WHEN 'over_90' THEN 7 ELSE 8 END").to_owned()),
("upcoming",("SELECT days,coalesce(exact_sum(coalesce(amount_minor-paid_minor,0)),'0') AS amount_minor,CAST(count(id) AS TEXT) AS count FROM (SELECT 7 days UNION ALL SELECT 14 UNION ALL SELECT 30 UNION ALL SELECT 60 UNION ALL SELECT 90) windows LEFT JOIN eligible ON cancelled_at IS NULL AND paid_minor<amount_minor AND due_date BETWEEN ?6 AND date(?6,'+'||days||' days') GROUP BY days ORDER BY days").to_owned()),
("trends",(format!("SELECT {bucket} AS period,{} AS gross_minor,{} AS reversed_minor,{} AS net_minor,CAST(count(CASE WHEN kind='payment' THEN 1 END) AS TEXT) AS count FROM events WHERE occurred_on BETWEEN ?4 AND ?5 GROUP BY period ORDER BY period LIMIT 367",sum("CASE WHEN kind='payment' THEN amount_minor ELSE 0 END"),sum("CASE WHEN kind='reversal' THEN amount_minor ELSE 0 END"),sum("signed_minor"))).to_owned()),
("methods",("SELECT method AS label,coalesce(exact_sum(signed_minor),'0') AS amount_minor,CAST(count(CASE WHEN kind='payment' THEN 1 END) AS TEXT) AS count FROM events WHERE occurred_on BETWEEN ?4 AND ?5 GROUP BY method ORDER BY method").to_owned()),
("collectors",("SELECT collector AS label,coalesce(exact_sum(signed_minor),'0') AS amount_minor,CAST(count(CASE WHEN kind='payment' THEN 1 END) AS TEXT) AS count FROM events WHERE occurred_on BETWEEN ?4 AND ?5 GROUP BY collector ORDER BY collector").to_owned()),
("services",("SELECT service_type AS label,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor ELSE 0 END),'0') AS amount_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN paid_minor ELSE 0 END),'0') AS paid_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor-paid_minor ELSE 0 END),'0') AS outstanding_minor,CAST(count(*) AS TEXT) AS count,coalesce((SELECT exact_sum(ev.signed_minor) FROM events ev WHERE ev.service_type=eligible.service_type AND ev.occurred_on BETWEEN ?4 AND ?5),'0') AS activity_minor FROM eligible GROUP BY service_type ORDER BY service_type").to_owned()),
("attention",("SELECT id,client_id,client_name,description,due_date,status,CAST(amount_minor-paid_minor AS TEXT) AS outstanding_minor FROM eligible WHERE cancelled_at IS NULL AND paid_minor<amount_minor ORDER BY due_date IS NULL,due_date,id LIMIT 10").to_owned()),
("concentration",("SELECT client_id,client_name,coalesce(exact_sum(signed_minor),'0') AS net_minor FROM events WHERE occurred_on BETWEEN ?4 AND ?5 GROUP BY client_id,client_name ORDER BY (net_minor NOT LIKE '-%') DESC,CASE WHEN net_minor LIKE '-%' THEN -length(net_minor) ELSE length(net_minor) END DESC,net_minor DESC,client_id LIMIT 10").to_owned()),
("client_nets",("SELECT exact_sum(signed_minor) AS net FROM events WHERE occurred_on BETWEEN ?4 AND ?5 GROUP BY client_id LIMIT 10001").to_owned())
];
 let mut queries=queries;
 queries.push(("prior_year",activity_sql(if ctx.filter.year_available{"occurred_on BETWEEN ?20 AND ?21"}else{"0"})));
 queries.push(("source_caps",CAP_SQL.to_owned()));
 queries.push(("commercial_periods",partner_sql(&actor)?));
 queries.push(("settlements",format!("SELECT {} AS incoming_minor,{} AS outgoing_minor FROM settlement_data",sum("CASE WHEN direction='partner_to_roise' THEN amount_minor ELSE 0 END"),sum("CASE WHEN direction='roise_to_partner' THEN amount_minor ELSE 0 END"))));
 queries.push(("customer_cash", "SELECT substr(occurred_on,1,7) AS period,exact_sum(signed_minor) AS amount_minor FROM events WHERE occurred_on BETWEEN ?4 AND ?5 AND collector='roise' GROUP BY period ORDER BY period LIMIT 367".into()));
 queries.push(("settlement_cash", "SELECT substr(settled_on,1,7) AS period,direction,exact_sum(amount_minor) AS amount_minor FROM settlement_data GROUP BY period,direction ORDER BY period LIMIT 733".into()));
 let core=ctx.batch(tx,&queries)?;
 check_caps(&core["source_caps"][0])?;
 let position=core["position"][0].clone();
 let activity=core["activity"][0].clone();
 let previous=core["previous"][0].clone();
 let aging=core["aging"].as_array().ok_or(Error::Internal)?.clone();
 let upcoming=core["upcoming"].as_array().ok_or(Error::Internal)?.clone();
 let mut trends=core["trends"].as_array().ok_or(Error::Internal)?.clone();
 let mut cumulative=0i128;for row in &mut trends{cumulative=cumulative.checked_add(integer(&row["net_minor"])?).ok_or(Error::Internal)?;row["cumulative_minor"]=json!(cumulative.to_string());}
 if cumulative!=integer(&activity["net_minor"])?{return Err(Error::Internal)}
 let methods=core["methods"].as_array().ok_or(Error::Internal)?.clone();
 let collectors=core["collectors"].as_array().ok_or(Error::Internal)?.clone();
 let services=core["services"].as_array().ok_or(Error::Internal)?.clone();
 let attention=core["attention"].as_array().ok_or(Error::Internal)?.clone();
 let concentration=core["concentration"].as_array().ok_or(Error::Internal)?.clone();
 let client_nets=core["client_nets"].as_array().ok_or(Error::Internal)?.clone();
 if trends.len()>366||client_nets.len()>10000{return Err(Error::Invalid("report_range_too_large"))}
 let positive=client_nets.iter().try_fold(0i128,|n,r|n.checked_add(integer(&r["net"])?.max(0)).ok_or(Error::Internal))?;
 let agreements=agreement_summary(tx,&actor,&ctx)?;
 let partners=partner_rows(core["commercial_periods"].as_array().ok_or(Error::Internal)?.clone())?;
 let expenses=super::expenses::analytics(tx,&actor,&ctx)?;
 let settlements=core["settlements"][0].clone();
 let cashflow=cashflow(&ctx,&expenses,&core)?;
 let alerts=alerts(&aging,&concentration,&activity,&partners,&expenses,positive)?;
 Ok(json!({"as_of":ctx.as_of,"client_id":ctx.filter.client,"currency":ctx.filter.currency,"from":ctx.filter.from,"to":ctx.filter.to,"previous_from":ctx.filter.previous_from,"previous_to":ctx.filter.previous_to,"group":ctx.filter.group,"position":position,"activity":activity,"previous":previous,"prior_year":if ctx.filter.year_available{core["prior_year"][0].clone()}else{Value::Null},"year_from":ctx.filter.year_from,"year_to":ctx.filter.year_to,"aging":aging,"upcoming":upcoming,"trends":trends,"methods":methods,"collectors":collectors,"services":services,"attention":attention,"concentration":concentration,"partners":partners,"agreements":agreements,"positive_client_net_minor":positive.to_string(),"expenses":expenses,"settlements":settlements,"cashflow":cashflow,"alerts":alerts}))
}).await
}
fn partner_sql(actor: &Actor) -> Result<String> {
    let access = crate::mcp::access::predicate(
        actor,
        "finance:read",
        "b.client_id",
        grant_sql("?1", "agreements.view", "b.client_id"),
    )?;
    Ok(format!(
        "{} JOIN eligible e ON e.id=b.collection_id WHERE {access} AND b.voided_at IS NULL AND v.partner_id IS NOT NULL ORDER BY b.id LIMIT 5001",
        commercial::PERIOD_SQL
    ))
}
fn partner_rows(rows: Vec<Value>) -> Result<Vec<Value>> {
    if rows.len() > 5000 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    let mut groups = std::collections::BTreeMap::<String, Value>::new();
    for row in rows {
        let p = commercial::period_position(row)?;
        let key = p["partner_id"].as_str().ok_or(Error::Internal)?.to_owned();
        let group=groups.entry(key.clone()).or_insert_with(||json!({"id":key,"name":p["partner_name"],"contracted_minor":"0","roise_share_minor":"0","partner_share_minor":"0","roise_recognized_minor":"0","partner_recognized_minor":"0","settled_minor":"0","receivable_minor":"0","payable_minor":"0","balance_minor":"0","count":"0"}));
        for (dst, src) in [
            ("contracted_minor", "amount_minor"),
            ("roise_share_minor", "roise_share_minor"),
            ("partner_share_minor", "partner_share_minor"),
            ("roise_recognized_minor", "roise_recognized_minor"),
            ("partner_recognized_minor", "partner_recognized_minor"),
            ("settled_minor", "settled_to_roise_minor"),
            ("balance_minor", "internal_remaining_to_roise_minor"),
        ] {
            add(group, dst, integer(&p[src])?)?;
        }
        let balance = integer(&p["internal_remaining_to_roise_minor"])?;
        add(
            group,
            if balance >= 0 {
                "receivable_minor"
            } else {
                "payable_minor"
            },
            balance.abs(),
        )?;
        add(group, "count", 1)?;
    }
    Ok(groups.into_values().collect())
}
pub fn integer(value: &Value) -> Result<i128> {
    value
        .as_str()
        .ok_or(Error::Internal)?
        .parse()
        .map_err(|_| Error::Internal)
}
pub fn add(v: &mut Value, key: &str, n: i128) -> Result<()> {
    v[key] = json!(
        integer(&v[key])?
            .checked_add(n)
            .ok_or(Error::Internal)?
            .to_string()
    );
    Ok(())
}
pub async fn details(db: &Database, actor: Actor, q: Query, report: String) -> Result<Value> {
    db.read(move|tx|{
 let ctx=Context::new(tx,&actor,&q)?;
 check_caps(&ctx.one(tx,CAP_SQL)?)?;
 let sql=match report.as_str(){
 "receivables"=>"SELECT id,client_id,client_name,description,currency,service_type,agreement_id,CAST(amount_minor AS TEXT) AS amount_minor,CAST(paid_minor AS TEXT) AS paid_minor,CAST(CASE WHEN cancelled_at IS NULL THEN amount_minor-paid_minor ELSE 0 END AS TEXT) AS outstanding_minor,due_date,status,billed_on FROM eligible WHERE (?19 IS NULL OR id>?19) ORDER BY id LIMIT (?18+1)",
 "payments"=>"SELECT id,client_id,client_name,description,collection_id,service_type,agreement_id,CAST(amount_minor AS TEXT) AS amount_minor,occurred_on,recorded_at,method,collector,kind FROM events WHERE occurred_on BETWEEN ?4 AND ?5 AND (?19 IS NULL OR id>?19) ORDER BY id LIMIT (?18+1)",
 "clients"=>"SELECT client_id AS id,client_name,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor ELSE 0 END),'0') AS amount_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN paid_minor ELSE 0 END),'0') AS paid_minor,coalesce(exact_sum(CASE WHEN cancelled_at IS NULL THEN amount_minor-paid_minor ELSE 0 END),'0') AS outstanding_minor,coalesce(exact_sum(CASE WHEN status='overdue' THEN amount_minor-paid_minor ELSE 0 END),'0') AS overdue_minor,CAST(count(*) AS TEXT) AS count,min(CASE WHEN cancelled_at IS NULL AND paid_minor<amount_minor THEN due_date END) AS next_due,(SELECT max(p.paid_on) FROM payments p JOIN eligible src ON src.id=p.collection_id WHERE p.client_id=eligible.client_id) AS last_payment_on,coalesce((SELECT exact_sum(ev.signed_minor) FROM events ev WHERE ev.client_id=eligible.client_id AND ev.occurred_on BETWEEN ?4 AND ?5),'0') AS activity_minor FROM eligible WHERE (?19 IS NULL OR client_id>?19) GROUP BY client_id,client_name ORDER BY client_id LIMIT (?18+1)",
 _=>return Err(Error::NotFound)};
 let page=q.paging()?.page(ctx.rows(tx,sql)?)?;
 Ok(json!({"as_of":ctx.as_of,"client_id":ctx.filter.client,"currency":ctx.filter.currency,"from":ctx.filter.from,"to":ctx.filter.to,"report":report,"data":page["data"],"page":page["page"]}))
}).await
}

fn agreement_summary(tx: &Transaction<'_>, actor: &Actor, ctx: &Context) -> Result<Vec<Value>> {
    let base = format!(
        "{} AND {} AND {}",
        grant_sql("?1", "billing.view", "a.client_id"),
        grant_sql("?1", "clients.view", "a.client_id"),
        grant_sql("?1", "agreements.view", "a.client_id")
    );
    let visible = crate::mcp::access::predicate(actor, "finance:read", "a.client_id", base)?;
    let visible = crate::mcp::access::predicate(actor, "clients:read", "a.client_id", visible)?;
    let cte = format!(
        ", agreement_source AS MATERIALIZED (SELECT a.id,a.status,a.frequency,a.next_date,a.end_date,v.amount_minor FROM service_agreements a JOIN agreement_versions v ON v.agreement_id=a.id AND v.number=(SELECT max(v2.number) FROM agreement_versions v2 WHERE v2.agreement_id=a.id AND v2.effective_from<=a.next_date) WHERE {visible} AND v.currency=?2 AND (?3 IS NULL OR a.client_id=?3) AND (?7='all' OR a.service_type=?7) AND (?8 IS NULL OR a.id=?8) AND (?9 IS NULL OR v.partner_id=?9) LIMIT 10001) "
    );
    if ctx.one(
        tx,
        &(cte.clone() + "SELECT count(*) AS count FROM agreement_source"),
    )?["count"]
        .as_i64()
        .is_some_and(|v| v > 10000)
    {
        return Err(Error::Invalid("report_range_too_large"));
    }
    ctx.rows(tx,&(cte+"SELECT status AS label,CAST(count(*) AS TEXT) AS count,coalesce(exact_sum(CASE WHEN status='active' AND next_date BETWEEN ?6 AND date(?6,'+90 days') AND (end_date IS NULL OR next_date<=end_date) THEN amount_minor ELSE 0 END),'0') AS potential_next_minor FROM agreement_source GROUP BY status ORDER BY status"))
}

fn cashflow(ctx: &Context, expenses: &Value, core: &Value) -> Result<Value> {
    let f = &ctx.filter;
    if expenses.is_null()
        || f.service != "all"
        || f.status != "all"
        || f.method != "all"
        || f.collector != "all"
        || f.agreement.is_some()
        || f.partner.is_some()
        || f.due_from.is_some()
        || f.due_to.is_some()
        || !f.search.is_empty()
    {
        return Ok(Value::Null);
    }
    let mut groups = std::collections::BTreeMap::<String, Value>::new();
    let mut merge = |period: &str, key: &str, n: i128| -> Result<()> {
        let row=groups.entry(period.to_owned()).or_insert_with(||json!({"period":period,"customer_minor":"0","incoming_minor":"0","outgoing_minor":"0","operating_minor":"0","net_minor":"0"}));
        add(row, key, n)
    };
    let customers = core["customer_cash"].as_array().ok_or(Error::Internal)?;
    let transfers = core["settlement_cash"].as_array().ok_or(Error::Internal)?;
    if customers.len() > 366 || transfers.len() > 732 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    for row in customers {
        merge(
            row["period"].as_str().ok_or(Error::Internal)?,
            "customer_minor",
            integer(&row["amount_minor"])?,
        )?;
    }
    for row in transfers {
        merge(
            row["period"].as_str().ok_or(Error::Internal)?,
            if row["direction"] == "partner_to_roise" {
                "incoming_minor"
            } else {
                "outgoing_minor"
            },
            integer(&row["amount_minor"])?,
        )?;
    }
    for row in expenses["trends"].as_array().ok_or(Error::Internal)? {
        merge(
            row["period"].as_str().ok_or(Error::Internal)?,
            "operating_minor",
            integer(&row["net_minor"])?,
        )?;
    }
    if groups.len() > 366 {
        return Err(Error::Invalid("report_range_too_large"));
    }
    for row in groups.values_mut() {
        let net = integer(&row["customer_minor"])?
            .checked_add(integer(&row["incoming_minor"])?)
            .and_then(|n| n.checked_sub(integer(&row["outgoing_minor"]).ok()?))
            .and_then(|n| n.checked_sub(integer(&row["operating_minor"]).ok()?))
            .ok_or(Error::Internal)?;
        row["net_minor"] = json!(net.to_string());
    }
    Ok(json!(groups.into_values().collect::<Vec<_>>()))
}

fn alerts(
    aging: &[Value],
    concentration: &[Value],
    activity: &Value,
    partners: &[Value],
    expenses: &Value,
    positive: i128,
) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    let mut emit = |rule: &str,
                    amount: &Value,
                    client: &Value,
                    name: &Value,
                    target: &str,
                    tone: &str| {
        result.push(json!({"rule":rule,"amount_minor":amount,"client_id":client,"name":name,"target":target,"tone":tone}));
    };
    for row in aging {
        let rule = match row["bucket"].as_str() {
            Some("over_90") => "over_90",
            Some("undated") => "undated",
            _ => continue,
        };
        emit(
            rule,
            &row["amount_minor"],
            &Value::Null,
            &Value::Null,
            "Receivables",
            "warning",
        );
    }
    if let Some(row) = concentration.first()
        && positive > 0
        && integer(&row["net_minor"])?
            .checked_mul(2)
            .ok_or(Error::Internal)?
            >= positive
    {
        emit(
            "concentration_50",
            &row["net_minor"],
            &row["client_id"],
            &row["client_name"],
            "Clients",
            "warning",
        );
    }
    let gross = integer(&activity["gross_minor"])?;
    let reversed = integer(&activity["reversed_minor"])?;
    if reversed > 0 && (gross == 0 || reversed.checked_mul(10).ok_or(Error::Internal)? >= gross) {
        emit(
            "reversals_10",
            &activity["reversed_minor"],
            &Value::Null,
            &Value::Null,
            "Payments",
            "warning",
        );
    }
    if integer(&activity["unknown_minor"])? != 0 {
        emit(
            "unknown_collector",
            &activity["unknown_minor"],
            &Value::Null,
            &Value::Null,
            "Payments",
            "neutral",
        );
    }
    for row in partners.iter().take(10) {
        for (field, rule) in [
            ("receivable_minor", "partner_receivable"),
            ("payable_minor", "partner_payable"),
        ] {
            if integer(&row[field])? > 0 {
                emit(
                    rule,
                    &row[field],
                    &Value::Null,
                    &row["name"],
                    "Partners",
                    "warning",
                );
            }
        }
    }
    if !expenses.is_null() && integer(&expenses["position"]["upcoming_minor"])? > 0 {
        emit(
            "expenses_due_30",
            &expenses["position"]["upcoming_minor"],
            &Value::Null,
            &Value::Null,
            "Expenses",
            "neutral",
        );
    }
    result.truncate(25);
    Ok(result)
}
