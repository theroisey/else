use super::*;

impl Api {
    pub(super) async fn reminders(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    reminders::list(
                        &self.db,
                        actor,
                        client,
                        query(
                            r,
                            &["limit", "cursor", "sort", "status", "due", "owner", "q"],
                        )?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        reminders::create(&self.db, actor, client, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["owners"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    reminders::owners(&self.db, actor, client, query(r, &["limit", "cursor"])?)
                        .await?,
                ))
            }
            [id] => {
                let id = validation::id(id)?;
                no_query(r)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, reminders::read(&self.db, actor, client, id).await?),
                    "PUT" => Reply::data(
                        200,
                        reminders::update(&self.db, actor, client, id, validation::json(&r.body)?)
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
                    "complete" => Reply::data(
                        200,
                        reminders::complete(
                            &self.db,
                            actor,
                            client,
                            id,
                            validation::json(&r.body)?,
                        )
                        .await?,
                    ),
                    "dismiss" => Reply::data(
                        200,
                        reminders::dismiss(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::NotFound),
                }
            }
            _ => Err(Error::NotFound),
        }
    }
}
