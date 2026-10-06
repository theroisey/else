use super::*;

impl Api {
    pub(super) async fn tasks(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    tasks::list(
                        &self.db,
                        actor,
                        client,
                        query(
                            r,
                            &[
                                "limit", "cursor", "sort", "status", "priority", "archived",
                                "assignee", "q", "tag",
                            ],
                        )?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        tasks::create(&self.db, actor, client, validation::json(&r.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["assignees"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    tasks::assignees(&self.db, actor, client, query(r, &["limit", "cursor"])?)
                        .await?,
                ))
            }
            [id] => {
                let id = validation::id(id)?;
                no_query(r)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, tasks::read(&self.db, actor, client, id).await?),
                    "PUT" => Reply::data(
                        200,
                        tasks::update(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            [id, operation] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                let id = validation::id(id)?;
                match *operation {
                    "status" => Reply::data(
                        200,
                        tasks::status(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    "archive" => Reply::data(
                        200,
                        tasks::archive(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::NotFound),
                }
            }
            _ => Err(Error::NotFound),
        }
    }
}
