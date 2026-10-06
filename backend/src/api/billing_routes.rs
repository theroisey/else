use super::*;

impl Api {
    pub(super) async fn billing(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        match route {
            [id, "pricing-snapshot"] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    pricing::snapshot(&self.db, actor, client, validation::id(id)?).await?,
                )
            }
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    billing::list(
                        &self.db,
                        actor,
                        client,
                        query(r, &["limit", "cursor", "status", "currency", "search"])?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        billing::create(&self.db, actor, client, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["summary"] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(200, billing::summary(&self.db, actor, client).await?)
            }
            ["currencies"] => {
                no_query(r)?;
                if r.method != Method::GET {
                    return Err(Error::Method("GET"));
                }
                Reply::data(200, billing::currencies(&self.db, actor, client).await?)
            }
            [id] => {
                let id = validation::id(id)?;
                no_query(r)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, billing::read(&self.db, actor, client, id).await?),
                    "PUT" => Reply::data(
                        200,
                        billing::update(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            [id, "payments"] => {
                let id = validation::id(id)?;
                match r.method.as_str() {
                    "GET" => Ok(Reply::page(
                        billing::payments(
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
                        let payment = billing::record_payment(
                            &self.db,
                            actor,
                            client,
                            id,
                            validation::json(&r.body)?,
                        )
                        .await?;
                        Reply::data(if payment.replayed { 200 } else { 201 }, payment)
                    }
                    _ => Err(Error::Method("GET, POST")),
                }
            }
            [id, "cancel"] => {
                no_query(r)?;
                if r.method != Method::POST {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    billing::cancel(
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
