use super::*;

impl Api {
    pub(super) async fn websites(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        let method = r.method.as_str();
        match route {
            [
                website,
                module @ ("analytics" | "commerce" | "marketing"),
                rest @ ..,
            ] => {
                self.report(
                    r,
                    actor,
                    client,
                    Some(validation::id(website)?),
                    match *module {
                        "analytics" => "ga4",
                        "commerce" => "woocommerce",
                        _ => "meta_ads",
                    },
                    rest,
                )
                .await
            }
            [id, "integrations", rest @ ..] => {
                self.integrations(r, actor, client, Some(validation::id(id)?), rest)
                    .await
            }
            [] => match method {
                "GET" => Ok(Reply::page(
                    websites::list(
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
                        websites::create(&self.db, actor, client, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            [id] => {
                no_query(r)?;
                let id = validation::id(id)?;
                match method {
                    "GET" => Reply::data(200, websites::read(&self.db, actor, client, id).await?),
                    "PUT" | "PATCH" => Reply::data(
                        200,
                        websites::update(&self.db, actor, client, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT, PATCH")),
                }
            }
            [id, action @ ("primary" | "archive")] => {
                no_query(r)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    websites::select_or_archive(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        validation::json(&r.body)?,
                        *action == "archive",
                    )
                    .await?,
                )
            }
            [id, "connections"] => match method {
                "GET" => Ok(Reply::page(
                    websites::connections(
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
                        websites::bind(
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
            [id, "activity"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    websites::activity(
                        &self.db,
                        actor,
                        client,
                        validation::id(id)?,
                        query(r, &["limit", "cursor"])?,
                    )
                    .await?,
                ))
            }
            _ => Err(Error::NotFound),
        }
    }
}
