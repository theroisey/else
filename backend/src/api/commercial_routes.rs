use super::*;
use crate::operations::commercial as c;
impl Api {
    pub(super) async fn commercial(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
        periods: bool,
    ) -> Result<Reply> {
        if periods {
            return match route {
                [] => {
                    if r.method != Method::GET {
                        return Err(Error::Method("GET"));
                    }
                    Ok(Reply::page(
                        c::periods(&self.db, actor, client, None, query(r, c::PERIOD_FILTERS)?)
                            .await?,
                    ))
                }
                [id] => {
                    no_query(r)?;
                    if r.method != Method::GET {
                        return Err(Error::Method("GET"));
                    }
                    Reply::data(
                        200,
                        c::period(&self.db, actor, client, validation::id(id)?).await?,
                    )
                }
                [id, "settlements"] => match r.method.as_str() {
                    "GET" => Ok(Reply::page(
                        c::settlements(
                            &self.db,
                            actor,
                            client,
                            validation::id(id)?,
                            query(r, &["limit", "cursor"])?,
                        )
                        .await?,
                    )),
                    "POST" => {
                        no_query(r)?;
                        Reply::data(
                            200,
                            c::settle(
                                &self.db,
                                actor,
                                client,
                                validation::id(id)?,
                                validation::json(&r.body)?,
                            )
                            .await?,
                        )
                    }
                    _ => Err(Error::Method("GET, POST")),
                },
                [id, "void"] => {
                    no_query(r)?;
                    if r.method != Method::POST {
                        return Err(Error::Method("POST"));
                    }
                    Reply::data(
                        200,
                        c::void_period(
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
            };
        }
        match route {
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
                        true,
                    )
                    .await?,
                ))
            }
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    c::list(
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
                        c::create(&self.db, actor, client, validation::json(&r.body)?).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["partners"] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    c::partners(&self.db, actor, client, query(r, &["limit", "cursor"])?).await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        c::create_partner(&self.db, actor, client, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            [id] => {
                no_query(r)?;
                let id = validation::id(id)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, c::read(&self.db, actor, client, id).await?),
                    "PUT" => Reply::data(
                        200,
                        c::change(&self.db, actor, client, id, validation::json(&r.body)?).await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            [id, "versions"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    c::versions(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        query(r, &["limit", "cursor"])?,
                    )
                    .await?,
                ))
            }
            [id, "periods"] => {
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    c::periods(
                        &self.db,
                        actor,
                        client,
                        Some(validation::id(id)?),
                        query(r, c::PERIOD_FILTERS)?,
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
                    c::generate(
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
