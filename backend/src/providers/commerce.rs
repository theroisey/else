//! Complete wc/v3 order-created and refund-created cohorts. Product groups
//! describe original lines only; no cash, inventory or revenue is inferred.
use super::Requestor;
use crate::{
    billing,
    error::{Error, Result},
    provider_credentials::ReadKey,
    provider_http::{Call, Page, Policy},
    provider_json::{self, object, text},
    sync_period::Period,
    validation,
};
use chrono::{DateTime, Duration, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const ORDERS_PATH: &str = "/wp-json/wc/v3/orders";
const REFUNDS_PATH: &str = "/wp-json/wc/v3/refunds";
const ORDER_FIELDS: &str = "id,status,currency,date_created_gmt,total,refunds.id,refunds.total,line_items.id,line_items.product_id,line_items.variation_id,line_items.quantity,line_items.total,line_items.total_tax";
const REFUND_FIELDS: &str = "id,parent_id,date_created_gmt,amount";
const BINDING_KEYS: [&str; 7] = [
    "client_id",
    "connection_id",
    "api_version",
    "currency",
    "currency_exponent",
    "start",
    "end",
];
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Binding {
    pub client_id: String,
    pub connection_id: String,
    pub api_version: String,
    pub currency: String,
    pub currency_exponent: u32,
    pub start: String,
    pub end: String,
}
impl Binding {
    pub(crate) fn new(
        client: String,
        connection: String,
        start: String,
        end: String,
        currency: String,
    ) -> Result<Self> {
        validation::id(&client).map_err(|_| Error::Internal)?;
        validation::id(&connection).map_err(|_| Error::Internal)?;
        Period::commerce(&start, &end, &currency).map_err(|_| Error::Internal)?;
        Ok(Self {
            client_id: client,
            connection_id: connection,
            api_version: "wc/v3".into(),
            currency_exponent: billing::exponent(&currency)? as u32,
            currency,
            start,
            end,
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub grand_total_minor: String,
    pub lifetime_refund_minor: String,
    pub remainder_minor: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Orders {
    #[serde(flatten)]
    pub binding: Binding,
    pub orders: Vec<Order>,
    pub grand_total_minor: String,
    pub lifetime_refund_minor: String,
    pub remainder_minor: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Refund {
    pub id: String,
    pub parent_id: String,
    pub created_at: String,
    pub amount_minor: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Refunds {
    #[serde(flatten)]
    pub binding: Binding,
    pub refunds: Vec<Refund>,
    pub amount_minor: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Product {
    pub product_id: String,
    pub variation_id: String,
    pub quantity: String,
    pub order_count: String,
    pub line_count: String,
    pub total_minor: String,
    pub tax_minor: String,
    pub line_grand_minor: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Products {
    #[serde(flatten)]
    pub binding: Binding,
    pub products: Vec<Product>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub orders: Orders,
    pub refunds: Refunds,
    pub products: Products,
    pub collected_from: String,
    pub collected_through: String,
}
impl Workspace {
    pub fn validate(&self, expected: &Binding) -> Result<()> {
        let binding = Binding::new(
            expected.client_id.clone(),
            expected.connection_id.clone(),
            expected.start.clone(),
            expected.end.clone(),
            expected.currency.clone(),
        )?;
        if binding != *expected
            || self.orders.binding != binding
            || self.refunds.binding != binding
            || self.products.binding != binding
            || self.orders.orders.len() > 500
            || self.refunds.refunds.len() > 500
            || self.products.products.len() > 1000
        {
            return Err(Error::Internal);
        }
        super::collected_span(&self.collected_from, &self.collected_through)?;
        let mut previous = 0;
        let mut order_ids = BTreeSet::new();
        let mut totals = [0i128; 3];
        for row in &self.orders.orders {
            let id = number(&row.id, 18, true)?;
            if id <= previous || !known_status(&row.status) {
                return Err(Error::Internal);
            }
            previous = id;
            order_ids.insert(id);
            workspace_date(&row.created_at, &binding)?;
            let grand = number(&row.grand_total_minor, 18, false)?;
            let refund = number(&row.lifetime_refund_minor, 20, false)?;
            let remainder = number(&row.remainder_minor, 18, false)?;
            if refund + remainder != grand {
                return Err(Error::Internal);
            }
            for (sum, value) in totals.iter_mut().zip([grand, refund, remainder]) {
                *sum = sum.checked_add(value).ok_or(Error::Internal)?;
            }
        }
        if self.orders.grand_total_minor != totals[0].to_string()
            || self.orders.lifetime_refund_minor != totals[1].to_string()
            || self.orders.remainder_minor != totals[2].to_string()
        {
            return Err(Error::Internal);
        }
        previous = 0;
        let mut amount = 0i128;
        for row in &self.refunds.refunds {
            let id = number(&row.id, 18, true)?;
            let parent = number(&row.parent_id, 18, true)?;
            if id <= previous || id == parent || order_ids.contains(&id) {
                return Err(Error::Internal);
            }
            previous = id;
            workspace_date(&row.created_at, &binding)?;
            amount = amount
                .checked_add(number(&row.amount_minor, 18, false)?)
                .ok_or(Error::Internal)?;
        }
        if amount.to_string() != self.refunds.amount_minor {
            return Err(Error::Internal);
        }
        let mut previous = None;
        let mut total_lines = 0i128;
        for row in &self.products.products {
            let id = (
                number(&row.product_id, 18, false)?,
                number(&row.variation_id, 18, false)?,
            );
            if previous.is_some_and(|p| p >= id) {
                return Err(Error::Internal);
            }
            previous = Some(id);
            let quantity = number(&row.quantity, 23, true)?;
            let orders = number(&row.order_count, 3, true)?;
            let lines = number(&row.line_count, 5, true)?;
            let net = number(&row.total_minor, 23, false)?;
            let tax = number(&row.tax_minor, 23, false)?;
            let grand = number(&row.line_grand_minor, 23, false)?;
            if orders > self.orders.orders.len() as i128
                || lines < orders
                || lines > orders * 50
                || quantity < lines
                || net + tax != grand
            {
                return Err(Error::Internal);
            }
            let limit = lines * 999_999_999_999_999_999;
            if quantity > limit || net > limit || tax > limit {
                return Err(Error::Internal);
            }
            total_lines += lines;
        }
        if total_lines > self.orders.orders.len() as i128 * 50 {
            return Err(Error::Internal);
        }
        Ok(())
    }
    pub fn decode(raw: &[u8], expected: &Binding) -> Result<Self> {
        if raw.is_empty() || raw.len() > 2_097_152 {
            return Err(Error::Internal);
        }
        let value = provider_json::parse(raw)?;
        let root = object(
            &value,
            &[
                "orders",
                "refunds",
                "products",
                "collected_from",
                "collected_through",
            ],
        )?;
        if root.len() != 5 {
            return Err(Error::Internal);
        }
        for (name, rows, extra, row_fields) in [
            (
                "orders",
                "orders",
                &[
                    "grand_total_minor",
                    "lifetime_refund_minor",
                    "remainder_minor",
                ][..],
                &[
                    "id",
                    "status",
                    "created_at",
                    "grand_total_minor",
                    "lifetime_refund_minor",
                    "remainder_minor",
                ][..],
            ),
            (
                "refunds",
                "refunds",
                &["amount_minor"][..],
                &["id", "parent_id", "created_at", "amount_minor"][..],
            ),
            (
                "products",
                "products",
                &[][..],
                &[
                    "product_id",
                    "variation_id",
                    "quantity",
                    "order_count",
                    "line_count",
                    "total_minor",
                    "tax_minor",
                    "line_grand_minor",
                ][..],
            ),
        ] {
            let mut fields = BINDING_KEYS.to_vec();
            fields.push(rows);
            fields.extend(extra);
            let part = object(root.get(name).ok_or(Error::Internal)?, &fields)?;
            if part.len() != fields.len() {
                return Err(Error::Internal);
            }
            for row in part
                .get(rows)
                .and_then(Value::as_array)
                .ok_or(Error::Internal)?
            {
                if object(row, row_fields)?.len() != row_fields.len() {
                    return Err(Error::Internal);
                }
            }
        }
        let result: Self = provider_json::decode(value)?;
        result.validate(expected)?;
        Ok(result)
    }
}
pub(super) async fn fetch(
    wire: &dyn Requestor,
    origin: &str,
    key: &ReadKey,
    binding: Binding,
) -> Result<Workspace> {
    let authorization = key.authorization();
    let collected_from = super::collected_now()?;
    let start = DateTime::parse_from_rfc3339(&binding.start).map_err(|_| Error::Internal)?;
    let after = (start - Duration::seconds(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
    let query = [
        ("after", after.as_str()),
        ("before", binding.end.as_str()),
        ("dates_are_gmt", "true"),
        ("dp", "6"),
        ("orderby", "id"),
        ("order", "asc"),
        ("per_page", "100"),
    ];
    let mut order_query = query.to_vec();
    order_query.push(("_fields", ORDER_FIELDS));
    let order_pages = collect(wire, origin, ORDERS_PATH, &authorization, &order_query).await?;
    let (orders, products) = normalize_orders(&binding, &order_pages)?;
    let mut refund_query = query.to_vec();
    refund_query.push(("_fields", REFUND_FIELDS));
    let refund_pages = collect(wire, origin, REFUNDS_PATH, &authorization, &refund_query).await?;
    let parent_ids = refund_parent_ids(&refund_pages)?;
    for batch in parent_ids.chunks(50) {
        let include = batch
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let query = [
            ("include", include.as_str()),
            ("_fields", "id,currency"),
            ("orderby", "id"),
            ("order", "asc"),
            ("per_page", "50"),
            ("page", "1"),
        ];
        let page = get(wire, origin, ORDERS_PATH, &authorization, &query).await?;
        let rows = page.json.as_array().ok_or(Error::Internal)?;
        if page.total != Some(batch.len()) || page.pages != Some(1) || rows.len() != batch.len() {
            return Err(Error::Internal);
        }
        for (row, id) in rows.iter().zip(batch) {
            let fields = object(row, &["id", "currency"])?;
            if fields.len() != 2
                || numeric_json(fields.get("id"), true)? != *id
                || text(fields, "currency")? != binding.currency
            {
                return Err(Error::Internal);
            }
        }
    }
    let refunds = normalize_refunds(&binding, &refund_pages)?;
    unchanged(
        wire,
        origin,
        ORDERS_PATH,
        &authorization,
        &order_query,
        &order_pages[0],
    )
    .await?;
    unchanged(
        wire,
        origin,
        REFUNDS_PATH,
        &authorization,
        &refund_query,
        &refund_pages[0],
    )
    .await?;
    let result = Workspace {
        orders,
        refunds,
        products,
        collected_from,
        collected_through: super::collected_now()?,
    };
    result.validate(&binding)?;
    Ok(result)
}
async fn get(
    wire: &dyn Requestor,
    origin: &str,
    path: &str,
    authorization: &str,
    query: &[(&str, &str)],
) -> Result<Page> {
    wire.call(
        origin,
        Call {
            method: http::Method::GET,
            path,
            query,
            body: &[],
            authorization,
            content_type: None,
            policy: Policy::Report,
            commerce_page: true,
        },
    )
    .await
}
async fn collect(
    wire: &dyn Requestor,
    origin: &str,
    path: &str,
    authorization: &str,
    query: &[(&str, &str)],
) -> Result<Vec<Page>> {
    let mut pages: Vec<Page> = vec![];
    for number in 1..=5 {
        let number = number.to_string();
        let mut query = query.to_vec();
        query.push(("page", &number));
        let page = get(wire, origin, path, authorization, &query).await?;
        let total = page.total.ok_or(Error::Internal)?;
        let count = page.pages.ok_or(Error::Internal)?;
        if total > 500
            || count > 5
            || count != total.div_ceil(100)
            || pages
                .first()
                .is_some_and(|first| first.total != page.total || first.pages != page.pages)
        {
            return Err(Error::Internal);
        }
        let rows = page.json.as_array().ok_or(Error::Internal)?;
        let offset = pages.len() * 100;
        if rows.len() != 100.min(total.checked_sub(offset).ok_or(Error::Internal)?) {
            return Err(Error::Internal);
        }
        pages.push(page);
        if pages.len() == count.max(1) {
            return Ok(pages);
        }
    }
    Err(Error::Internal)
}
async fn unchanged(
    wire: &dyn Requestor,
    origin: &str,
    path: &str,
    authorization: &str,
    query: &[(&str, &str)],
    first: &Page,
) -> Result<()> {
    let mut query = query.to_vec();
    query.push(("page", "1"));
    let page = get(wire, origin, path, authorization, &query).await?;
    if page.total != first.total
        || page.pages != first.pages
        || page.raw.as_slice() != first.raw.as_slice()
    {
        return Err(Error::Internal);
    }
    Ok(())
}
fn rows(pages: &[Page]) -> Result<Vec<&Value>> {
    if pages.is_empty() || pages.len() > 5 {
        return Err(Error::Internal);
    }
    let total = pages[0].total.ok_or(Error::Internal)?;
    let count = pages[0].pages.ok_or(Error::Internal)?;
    if total > 500 || count != total.div_ceil(100) || pages.len() != count.max(1) {
        return Err(Error::Internal);
    }
    let mut rows = vec![];
    for page in pages {
        let values = page.json.as_array().ok_or(Error::Internal)?;
        if page.total != Some(total)
            || page.pages != Some(count)
            || values.len() != 100.min(total.checked_sub(rows.len()).ok_or(Error::Internal)?)
            || page.raw.len() > 65_536
        {
            return Err(Error::Internal);
        }
        rows.extend(values);
    }
    Ok(rows)
}
fn refund_parent_ids(pages: &[Page]) -> Result<Vec<i128>> {
    let mut ids = BTreeSet::new();
    for row in rows(pages)? {
        let fields = object(row, &["id", "parent_id", "date_created_gmt", "amount"])?;
        if fields.len() != 4 {
            return Err(Error::Internal);
        }
        ids.insert(numeric_json(fields.get("parent_id"), true)?);
    }
    Ok(ids.into_iter().collect())
}
struct Group {
    quantity: i128,
    net: i128,
    tax: i128,
    orders: BTreeSet<i128>,
    lines: usize,
}
fn normalize_orders(binding: &Binding, pages: &[Page]) -> Result<(Orders, Products)> {
    let mut orders = vec![];
    let mut totals = [0i128; 3];
    let mut previous = 0;
    let mut refund_ids = BTreeSet::new();
    let mut order_ids = BTreeSet::new();
    let mut line_ids = BTreeSet::new();
    let mut groups: BTreeMap<(i128, i128), Group> = BTreeMap::new();
    for row in rows(pages)? {
        let fields = object(
            row,
            &[
                "id",
                "status",
                "currency",
                "date_created_gmt",
                "total",
                "refunds",
                "line_items",
            ],
        )?;
        if fields.len() != 7 {
            return Err(Error::Internal);
        }
        let id = numeric_json(fields.get("id"), true)?;
        if id <= previous
            || refund_ids.contains(&id)
            || text(fields, "currency")? != binding.currency
        {
            return Err(Error::Internal);
        }
        previous = id;
        order_ids.insert(id);
        let status = text(fields, "status")?;
        if !known_status(status) {
            return Err(Error::Internal);
        }
        let created = created(text(fields, "date_created_gmt")?, binding)?;
        let grand = minor(text(fields, "total")?, binding.currency_exponent)?;
        let summaries = fields
            .get("refunds")
            .and_then(Value::as_array)
            .ok_or(Error::Internal)?;
        if summaries.len() > 50 {
            return Err(Error::Internal);
        }
        let mut refunded = 0i128;
        for summary in summaries {
            let fields = object(summary, &["id", "total"])?;
            let id = numeric_json(fields.get("id"), true)?;
            if fields.len() != 2 || !refund_ids.insert(id) || order_ids.contains(&id) {
                return Err(Error::Internal);
            }
            let amount = text(fields, "total")?
                .strip_prefix('-')
                .ok_or(Error::Internal)?;
            refunded += minor(amount, binding.currency_exponent)?;
        }
        if refunded > grand {
            return Err(Error::Internal);
        }
        orders.push(Order {
            id: id.to_string(),
            status: status.into(),
            created_at: created,
            grand_total_minor: grand.to_string(),
            lifetime_refund_minor: refunded.to_string(),
            remainder_minor: (grand - refunded).to_string(),
        });
        for (sum, value) in totals.iter_mut().zip([grand, refunded, grand - refunded]) {
            *sum = sum.checked_add(value).ok_or(Error::Internal)?;
        }
        let lines = fields
            .get("line_items")
            .and_then(Value::as_array)
            .ok_or(Error::Internal)?;
        if lines.len() > 50 {
            return Err(Error::Internal);
        }
        for line in lines {
            let fields = object(
                line,
                &[
                    "id",
                    "product_id",
                    "variation_id",
                    "quantity",
                    "total",
                    "total_tax",
                ],
            )?;
            if fields.len() != 6 || !line_ids.insert(numeric_json(fields.get("id"), true)?) {
                return Err(Error::Internal);
            }
            let product = numeric_json(fields.get("product_id"), false)?;
            let variation = numeric_json(fields.get("variation_id"), false)?;
            let quantity = numeric_json(fields.get("quantity"), true)?;
            let net = minor(text(fields, "total")?, binding.currency_exponent)?;
            let tax = minor(text(fields, "total_tax")?, binding.currency_exponent)?;
            if groups.len() >= 1000 && !groups.contains_key(&(product, variation)) {
                return Err(Error::Internal);
            }
            let group = groups.entry((product, variation)).or_insert(Group {
                quantity: 0,
                net: 0,
                tax: 0,
                orders: BTreeSet::new(),
                lines: 0,
            });
            group.quantity += quantity;
            group.net += net;
            group.tax += tax;
            group.orders.insert(id);
            group.lines += 1;
        }
    }
    let products = groups
        .into_iter()
        .map(|((product, variation), group)| Product {
            product_id: product.to_string(),
            variation_id: variation.to_string(),
            quantity: group.quantity.to_string(),
            order_count: group.orders.len().to_string(),
            line_count: group.lines.to_string(),
            total_minor: group.net.to_string(),
            tax_minor: group.tax.to_string(),
            line_grand_minor: (group.net + group.tax).to_string(),
        })
        .collect();
    Ok((
        Orders {
            binding: binding.clone(),
            orders,
            grand_total_minor: totals[0].to_string(),
            lifetime_refund_minor: totals[1].to_string(),
            remainder_minor: totals[2].to_string(),
        },
        Products {
            binding: binding.clone(),
            products,
        },
    ))
}
fn normalize_refunds(binding: &Binding, pages: &[Page]) -> Result<Refunds> {
    let mut refunds = vec![];
    let mut previous = 0;
    let mut amount = 0i128;
    for row in rows(pages)? {
        let fields = object(row, &["id", "parent_id", "date_created_gmt", "amount"])?;
        if fields.len() != 4 {
            return Err(Error::Internal);
        }
        let id = numeric_json(fields.get("id"), true)?;
        let parent = numeric_json(fields.get("parent_id"), true)?;
        if id <= previous || id == parent {
            return Err(Error::Internal);
        }
        previous = id;
        let created = created(text(fields, "date_created_gmt")?, binding)?;
        let value = minor(text(fields, "amount")?, binding.currency_exponent)?;
        amount += value;
        refunds.push(Refund {
            id: id.to_string(),
            parent_id: parent.to_string(),
            created_at: created,
            amount_minor: value.to_string(),
        });
    }
    Ok(Refunds {
        binding: binding.clone(),
        refunds,
        amount_minor: amount.to_string(),
    })
}
fn number(raw: &str, digits: usize, positive: bool) -> Result<i128> {
    if raw.is_empty()
        || raw.len() > digits
        || (raw.len() > 1 && raw.starts_with('0'))
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Error::Internal);
    }
    let value = raw.parse::<i128>().map_err(|_| Error::Internal)?;
    if positive && value == 0 {
        return Err(Error::Internal);
    }
    Ok(value)
}
fn numeric_json(value: Option<&Value>, positive: bool) -> Result<i128> {
    let value = value.and_then(Value::as_u64).ok_or(Error::Internal)?;
    number(&value.to_string(), 18, positive)
}
fn minor(value: &str, exponent: u32) -> Result<i128> {
    let (whole, fraction) = value.split_once('.').ok_or(Error::Internal)?;
    number(whole, 18, false)?;
    if exponent > 6
        || fraction.len() != 6
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || fraction[exponent as usize..].bytes().any(|b| b != b'0')
    {
        return Err(Error::Internal);
    }
    let raw = format!("{whole}{}", &fraction[..exponent as usize]);
    let raw = raw.trim_start_matches('0');
    number(if raw.is_empty() { "0" } else { raw }, 18, false)
}
fn created(value: &str, binding: &Binding) -> Result<String> {
    if value.len() != 19 {
        return Err(Error::Internal);
    }
    let value = format!("{value}Z");
    workspace_date(&value, binding)?;
    Ok(value)
}
fn workspace_date(value: &str, binding: &Binding) -> Result<()> {
    let time = DateTime::parse_from_rfc3339(value).map_err(|_| Error::Internal)?;
    if time.timestamp_subsec_nanos() >= 1_000_000_000
        || time.to_rfc3339_opts(SecondsFormat::Secs, true) != value
        || value < binding.start.as_str()
        || value >= binding.end.as_str()
    {
        return Err(Error::Internal);
    }
    Ok(())
}
fn known_status(value: &str) -> bool {
    matches!(
        value,
        "pending"
            | "processing"
            | "on-hold"
            | "completed"
            | "cancelled"
            | "refunded"
            | "failed"
            | "trash"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minor_units_require_six_observed_decimal_places_and_exact_currency_representability() {
        assert_eq!(
            minor("90071992547409.930000", 2).unwrap(),
            9_007_199_254_740_993
        );
        assert_eq!(
            minor("9999999999999999.990000", 2).unwrap(),
            999_999_999_999_999_999
        );
        assert_eq!(minor("1.001000", 3).unwrap(), 1001);
        assert_eq!(minor("1.000000", 0).unwrap(), 1);
        for (value, exponent) in [
            ("1.000001", 2),
            ("1.001000", 2),
            ("1.000001", 3),
            ("1.010000", 0),
            ("10000000000000000.000000", 2),
            ("01.000000", 2),
            ("1.00", 2),
            ("1e2.000000", 2),
        ] {
            assert!(minor(value, exponent).is_err());
        }
    }
}
