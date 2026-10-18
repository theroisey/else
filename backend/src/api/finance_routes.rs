use super::*;
use crate::finance::{expenses as e, export, reporting as f};
impl Api {
    pub(super) async fn financial(
        &self,
        r: &Request,
        actor: Actor,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            ["dashboard"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    f::dashboard(&self.db, actor, query(r, f::KEYS)?).await?,
                )
            }
            ["reports", report] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    f::details(&self.db, actor, query(r, f::KEYS)?, report.to_string()).await?,
                )
            }
            ["exports", report] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    export::csv(
                        &self.db,
                        actor,
                        query(
                            r,
                            if *report == "expenses" {
                                e::KEYS
                            } else {
                                f::KEYS
                            },
                        )?,
                        report.to_string(),
                    )
                    .await?,
                )
            }
            ["expense-categories"] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    e::categories(&self.db, actor, query(r, &["limit", "cursor"])?).await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        e::category(&self.db, actor, validation::json(&r.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["expenses"] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    e::list(&self.db, actor, query(r, e::KEYS)?).await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        e::create(&self.db, actor, validation::json(&r.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["expenses", id] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(200, e::read(&self.db, actor, validation::id(id)?).await?)
            }
            ["expenses", id, "events"] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    e::events(
                        &self.db,
                        actor,
                        validation::id(id)?,
                        query(r, &["limit", "cursor"])?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        200,
                        e::event(
                            &self.db,
                            actor,
                            validation::id(id)?,
                            validation::json(&r.body)?,
                        )
                        .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["expenses", id, "cancel"] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    e::cancel(
                        &self.db,
                        actor,
                        validation::id(id)?,
                        validation::json(&r.body)?,
                    )
                    .await?,
                )
            }
            _ => Err(Error::NotFound),
        }
    }
}
