use super::*;

impl Api {
    pub(super) async fn pricing(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    pricing::list(&self.db, actor, client, query(r, &["limit", "cursor"])?).await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        pricing::create(&self.db, actor, client, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["preview"] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    pricing::preview(&self.db, actor, client, validation::json(&r.body)?).await?,
                )
            }
            [id] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    pricing::read(&self.db, actor, client, validation::id(id)?).await?,
                )
            }
            [id, "versions"] => {
                let id = validation::id(id)?;
                match r.method.as_str() {
                    "GET" => Ok(Reply::page(
                        pricing::versions(
                            &self.db,
                            actor,
                            client,
                            id,
                            query(r, &["limit", "cursor"])?,
                        )
                        .await?,
                    )),
                    "POST" => {
                        no_query(r)?;
                        Reply::data(
                            201,
                            pricing::append(
                                &self.db,
                                actor,
                                client,
                                id,
                                validation::json(&r.body)?,
                            )
                            .await?,
                        )
                    }
                    _ => Err(Error::Method("GET, POST")),
                }
            }
            [id, "versions", version] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    pricing::version(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        validation::id(version)?,
                    )
                    .await?,
                )
            }
            [id, "versions", version, "collections"] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                let copied = pricing::copy(
                    &self.db,
                    actor,
                    client,
                    validation::id(id)?,
                    validation::id(version)?,
                    validation::json(&r.body)?,
                )
                .await?;
                Reply::data(if copied.replayed { 200 } else { 201 }, copied)
            }
            _ => Err(Error::NotFound),
        }
    }
}
