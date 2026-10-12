use super::*;
use crate::operations::recurring as t;
impl Api {
    pub(super) async fn recurring(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            ["supervisors"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    t::supervisors(
                        &self.db,
                        actor,
                        client,
                        query(r, &["limit", "cursor", "assignee"])?,
                    )
                    .await?,
                ))
            }
            ["managers"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    crate::operations::managers::list(
                        &self.db,
                        actor,
                        client,
                        query(r, &["limit", "cursor", "q"])?,
                        false,
                    )
                    .await?,
                ))
            }
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    t::list(
                        &self.db,
                        actor,
                        client,
                        query(r, &["limit", "cursor", "status"])?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        t::create(&self.db, actor, client, validation::json(&r.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            [id] => {
                no_query(r)?;
                let id = validation::id(id)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, t::read(&self.db, actor, client, id).await?),
                    "PUT" => Reply::data(
                        200,
                        t::change(&self.db, actor, client, id, validation::json(&r.body)?).await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            [id, "occurrences"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    t::occurrences(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        query(r, &["limit", "cursor"])?,
                    )
                    .await?,
                ))
            }
            [id, "versions"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    t::versions(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        query(r, &["limit", "cursor"])?,
                    )
                    .await?,
                ))
            }
            [id, "generate"] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    t::generate(
                        &self.db,
                        actor,
                        client,
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
