//! Bounded name-only pickers for explicit automation authority transfers.
use super::*;
use crate::{
    db::Database,
    query::{Query, row_json},
};
use serde_json::Value;

pub async fn list(
    db: &Database,
    actor: Actor,
    client: String,
    q: Query,
    financial: bool,
) -> Result<Value> {
    let page = q.paging()?;
    let search = q.text("q", 100)?.to_lowercase();
    db.read(move |tx| {
        require(tx, &actor, if financial { "agreements.manage" } else { "recurring.manage" }, &client, false)?;
        if financial { security::require(tx, &actor, "billing.view", Some(&client)).map_err(hidden)?; }
        let view = grant_sql("u.id", "clients.view", "?1");
        let manage = grant_sql("u.id", if financial {"agreements.manage"} else {"recurring.manage"}, "?1");
        let create = grant_sql("u.id", if financial {"billing.create"} else {"tasks.create"}, "?1");
        let full = grant_sql("u.id", if financial {"billing.manage"} else {"tasks.manage"}, "?1");
        let finance = if financial {grant_sql("u.id", "billing.view", "?1")} else {"1".into()};
        let mut stmt = tx.prepare(&format!("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND {view} AND {manage} AND ({create} OR {full}) AND {finance} AND (?2 IS NULL OR u.id>?2) AND instr(unicode_lower(u.display_name),?3)>0 ORDER BY u.id LIMIT ?4"))?;
        page.page(stmt.query_map(params![client,page.cursor,search,(page.limit+1) as i64], row_json)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }).await
}
