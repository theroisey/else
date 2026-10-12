use super::*;
use crate::{
    operations::{self, evidence, notifications, requests},
    security,
};
use tokio::sync::OwnedSemaphorePermit;
impl Api {
    pub(crate) fn upload_route(path: &str) -> Option<(&str, &str)> {
        let mut p = path.trim_start_matches('/').split('/');
        if p.next() != Some("api") || p.next() != Some("v1") || p.next() != Some("clients") {
            return None;
        }
        let client = p.next()?;
        if p.next() != Some("evidence") {
            return None;
        }
        let id = p.next()?;
        if p.next().is_some() || validation::id(client).is_err() || validation::id(id).is_err() {
            return None;
        }
        Some((client, id))
    }
    pub(crate) async fn evidence_preflight(&self, r: &Request) -> Result<()> {
        no_query(r)?;
        self.unsafe_request(r)?;
        let (client, _) = Self::upload_route(&r.path).ok_or(Error::NotFound)?;
        let token = cookie(&r.headers, self.config.session_cookie()).ok_or(Error::Unauthorized)?;
        let actor = self.auth.current(&token, r.request_id.clone()).await?.actor;
        let csrf = cookie(&r.headers, self.config.csrf_cookie()).ok_or_else(csrf_error)?;
        let header = single_header(&r.headers, "x-csrf-token").ok_or_else(csrf_error)?;
        if !Auth::csrf(&actor, &csrf, header) {
            return Err(csrf_error());
        }
        let client = client.to_owned();
        self.db
            .read(move |tx| {
                security::require(tx, &actor, "clients.view", Some(&client))
                    .map_err(operations::hidden)?;
                security::require_any(tx, &actor, &["tickets.create", "tickets.deliver"], &client)
                    .map_err(operations::hidden)?;
                security::client(tx, &client, true)
            })
            .await
    }
    pub(super) async fn operations(
        &self,
        r: &Request,
        actor: Actor,
        admission: Option<OwnedSemaphorePermit>,
    ) -> Result<Reply> {
        let path: Vec<&str> = r.path.trim_start_matches('/').split('/').skip(2).collect();
        let method = r.method.as_str();
        const FILTERS: &[&str] = &[
            "limit",
            "cursor",
            "sort",
            "status",
            "priority",
            "q",
            "assignee",
            "requester",
            "website",
            "from",
            "to",
            "client_id",
        ];
        match path.as_slice() {
            ["tasks"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    tasks::queue(
                        &self.db,
                        actor,
                        query(
                            r,
                            &[
                                "limit",
                                "cursor",
                                "client_id",
                                "assignee",
                                "status",
                                "q",
                                "overdue",
                            ],
                        )?,
                    )
                    .await?,
                ))
            }
            ["operations-people"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    operations::team::people(
                        &self.db,
                        actor,
                        query(r, &["limit", "cursor", "q", "client_id"])?,
                    )
                    .await?,
                ))
            }
            ["preferences"] => {
                no_query(r)?;
                match method {
                    "GET" => {
                        Reply::data(200, operations::preferences::read(&self.db, actor).await?)
                    }
                    "PUT" => Reply::data(
                        200,
                        operations::preferences::update(
                            &self.db,
                            actor,
                            validation::json(&r.body)?,
                        )
                        .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["operations-settings"] => {
                no_query(r)?;
                match method {
                    "GET" => Reply::data(
                        200,
                        operations::preferences::settings(&self.db, actor).await?,
                    ),
                    "PUT" => Reply::data(
                        200,
                        operations::preferences::update_settings(
                            &self.db,
                            actor,
                            validation::json(&r.body)?,
                        )
                        .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }

            ["teams"] => match method {
                "GET" => Ok(Reply::page(
                    operations::team::list(&self.db, actor, query(r, &["limit", "cursor"])?)
                        .await?,
                )),
                "POST" => {
                    no_query(r)?;
                    Reply::data(
                        201,
                        operations::team::create(&self.db, actor, validation::json(&r.body)?)
                            .await?,
                    )
                }
                _ => Err(Error::Method("GET, POST")),
            },
            ["teams", "directory"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    operations::team::directory(
                        &self.db,
                        actor,
                        query(r, &["limit", "cursor", "q"])?,
                    )
                    .await?,
                ))
            }
            ["teams", id] => {
                let id = validation::id(id)?;
                no_query(r)?;
                match method {
                    "GET" => Reply::data(200, operations::team::read(&self.db, actor, id).await?),
                    "PUT" => Reply::data(
                        200,
                        operations::team::update(&self.db, actor, id, validation::json(&r.body)?)
                            .await?,
                    ),
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["teams", id, "members"] => {
                let id = validation::id(id)?;
                match method {
                    "GET" => Ok(Reply::page(
                        operations::team::members(
                            &self.db,
                            actor,
                            id,
                            query(r, &["limit", "cursor"])?,
                        )
                        .await?,
                    )),
                    "PUT" => {
                        no_query(r)?;
                        Reply::data(
                            200,
                            operations::team::membership(
                                &self.db,
                                actor,
                                id,
                                validation::json(&r.body)?,
                            )
                            .await?,
                        )
                    }
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["teams", id, "assignments"] => {
                let id = validation::id(id)?;
                match method {
                    "GET" => Ok(Reply::page(
                        operations::team::assignments(
                            &self.db,
                            actor,
                            id,
                            query(r, &["limit", "cursor"])?,
                        )
                        .await?,
                    )),
                    "PUT" => {
                        no_query(r)?;
                        Reply::data(
                            200,
                            operations::team::assign(
                                &self.db,
                                actor,
                                id,
                                validation::json(&r.body)?,
                            )
                            .await?,
                        )
                    }
                    _ => Err(Error::Method("GET, PUT")),
                }
            }
            ["teams", id, "history"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    operations::team::leadership_history(
                        &self.db,
                        actor,
                        validation::id(id)?,
                        query(r, &["limit", "before"])?,
                    )
                    .await?,
                ))
            }
            ["today"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    operations::today::read(
                        &self.db,
                        actor,
                        query(r, &["client_id", "employee_id"])?,
                    )
                    .await?,
                )
            }
            ["requests"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                let q = query(r, FILTERS)?;
                let client = q.get("client_id").map(validation::id).transpose()?;
                Ok(Reply::page(
                    requests::list(&self.db, actor, client, q).await?,
                ))
            }
            ["clients", client, "requests"] => {
                let client = validation::id(client)?;
                match method {
                    "GET" => Ok(Reply::page(
                        requests::list(
                            &self.db,
                            actor,
                            Some(client),
                            query(r, &FILTERS[..FILTERS.len() - 1])?,
                        )
                        .await?,
                    )),
                    "POST" => {
                        no_query(r)?;
                        Reply::data(
                            201,
                            requests::create(&self.db, actor, client, validation::json(&r.body)?)
                                .await?,
                        )
                    }
                    _ => Err(Error::Method("GET, POST")),
                }
            }
            ["clients", client, "requests", "developers"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                let client = validation::id(client)?;
                let paging = query(r, &["limit", "cursor"])?.paging()?;
                Ok(Reply::page(self.db.read(move|tx|{
                    security::require(tx,&actor,"clients.view",Some(&client)).map_err(operations::hidden)?;
                    security::require_any(tx,&actor,&["tickets.accept","tickets.assign"],&client).map_err(operations::hidden)?;
                    let allowed=operations::grant_sql("u.id","tickets.deliver","?2");let tasks=format!("({} OR {})",operations::grant_sql("u.id","tasks.view","?2"),operations::grant_sql("u.id","tasks.read_development","?2"));
                    let mut stmt=tx.prepare(&format!("SELECT u.id,u.display_name FROM users u WHERE u.status='active' AND {allowed} AND {tasks} AND (?1 IS NULL OR u.id>?1) ORDER BY u.id LIMIT ?3"))?;
                    let items=stmt.query_map(rusqlite::params![paging.cursor,client,(paging.limit+1) as i64],crate::query::row_json)?.collect::<std::result::Result<Vec<_>,_>>()?;
                    paging.page(items)
                }).await?))
            }
            ["clients", client, "requests", id] => {
                no_query(r)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    requests::read(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        validation::id(id)?,
                    )
                    .await?,
                )
            }
            ["clients", client, "requests", id, "deliveries"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    requests::deliveries(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        validation::id(id)?,
                        query(r, &["limit", "before"])?,
                    )
                    .await?,
                ))
            }
            ["clients", client, "requests", id, "timeline"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    requests::timeline(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        validation::id(id)?,
                        query(r, &["limit", "after"])?,
                    )
                    .await?,
                ))
            }
            ["clients", client, "requests", id, action] => {
                no_query(r)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                Reply::data(
                    200,
                    requests::act(
                        &self.db,
                        actor,
                        validation::id(client)?,
                        validation::id(id)?,
                        action.to_string(),
                        validation::json(&r.body)?,
                    )
                    .await?,
                )
            }
            ["clients", client, "evidence", id] => {
                no_query(r)?;
                let client = validation::id(client)?;
                let id = validation::id(id)?;
                match method {
                    "POST" => {
                        let filename = single_header(&r.headers, "x-file-name")
                            .ok_or(Error::Invalid("invalid_request"))?;
                        let filename = percent_encoding::percent_decode_str(filename)
                            .decode_utf8()
                            .map_err(|_| Error::Invalid("invalid_request"))?
                            .to_string();
                        let mime = single_header(&r.headers, "content-type")
                            .and_then(|v| v.parse::<mime::Mime>().ok())
                            .ok_or(Error::Invalid("invalid_request"))?
                            .essence_str()
                            .to_owned();
                        Reply::data(
                            201,
                            evidence::upload(
                                &self.db,
                                actor,
                                client,
                                evidence::Upload {
                                    id,
                                    filename,
                                    declared: mime,
                                    body: r.body.clone(),
                                },
                                admission,
                            )
                            .await?,
                        )
                    }
                    "DELETE" => {
                        #[derive(Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Empty {}
                        let _: Empty = validation::json(&r.body)?;
                        Reply::data(200, evidence::discard(&self.db, actor, client, id).await?)
                    }
                    "GET" => {
                        if !r.body.is_empty() {
                            return Err(Error::Invalid("invalid_request"));
                        }
                        Ok(Reply {
                            status: 200,
                            binary: Some(evidence::read(&self.db, actor, client, id).await?),
                            body: None,
                            cookies: vec![],
                        })
                    }
                    _ => Err(Error::Method("GET, POST, DELETE")),
                }
            }
            ["notifications"] => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Ok(Reply::page(
                    notifications::list(
                        &self.db,
                        actor,
                        query(r, &["limit", "cursor", "sort", "unread"])?,
                    )
                    .await?,
                ))
            }
            ["notifications", id, "read"] => {
                no_query(r)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Empty {}
                let _: Empty = validation::json(&r.body)?;
                Reply::data(
                    200,
                    notifications::mark(
                        &self.db,
                        actor,
                        if *id == "all" {
                            None
                        } else {
                            Some(validation::id(id)?)
                        },
                    )
                    .await?,
                )
            }
            _ => Err(Error::NotFound),
        }
    }
}
