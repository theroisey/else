use super::*;

impl Api {
    pub(super) async fn planning(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        route: &[&str],
    ) -> Result<Reply> {
        if let [plan, "task-candidates"] = route {
            if r.method != Method::GET {
                return Err(Error::Method("GET"));
            }
            return Ok(Reply::page(
                planning::candidates(
                    &self.db,
                    actor,
                    client,
                    validation::id(plan)?,
                    query(r, &["limit", "cursor", "sort", "q"])?,
                )
                .await?,
            ));
        }
        let (scope, route) = if let [plan, "milestones", rest @ ..] = route {
            (
                planning::Scope {
                    client,
                    plan: Some(validation::id(plan)?),
                },
                rest,
            )
        } else {
            (planning::Scope { client, plan: None }, route)
        };
        match route {
            [] => match r.method.as_str() {
                "GET" => Ok(Reply::page(
                    planning::list(
                        &self.db,
                        actor,
                        scope,
                        query(r, &["limit", "cursor", "sort", "status", "archived", "q"])?,
                    )
                    .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    let profile = planning::Profile::parse(&r.body, &scope, false)?;
                    Reply::data(
                        201,
                        planning::create(&self.db, actor, scope, profile).await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            [id] => {
                let id = validation::id(id)?;
                no_query(r)?;
                match r.method.as_str() {
                    "GET" => Reply::data(200, planning::read(&self.db, actor, scope, id).await?),
                    "PUT" => {
                        let profile = planning::Profile::parse(&r.body, &scope, true)?;
                        Reply::data(
                            200,
                            planning::update(&self.db, actor, scope, id, profile).await?,
                        )
                    }
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            [id, "task-links"] if scope.plan.is_some() => {
                let id = validation::id(id)?;
                match r.method.as_str() {
                    "GET" => Ok(Reply::page(
                        planning::links(
                            &self.db,
                            actor,
                            scope,
                            id,
                            query(r, &["limit", "cursor", "sort", "archived"])?,
                        )
                        .await?,
                    )),
                    "PUT" => {
                        no_query(r)?;
                        Reply::data(
                            200,
                            planning::replace_links(
                                &self.db,
                                actor,
                                scope,
                                id,
                                validation::json(&r.body)?,
                            )
                            .await?,
                        )
                    }
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
                        planning::status(&self.db, actor, scope, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    "archive" => Reply::data(
                        200,
                        planning::archive(&self.db, actor, scope, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::NotFound),
                }
            }
            _ => Err(Error::NotFound),
        }
    }
}
