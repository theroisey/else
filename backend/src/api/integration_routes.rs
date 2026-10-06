use super::*;
use crate::vault::Scope;

impl Api {
    pub(super) async fn integrations(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        website: Option<String>,
        route: &[&str],
    ) -> Result<Reply> {
        let method = r.method.as_str();
        match route {
            [
                id,
                provider @ ("ga4" | "woocommerce" | "meta_ads"),
                action @ ("credentials" | "sync"),
            ] => {
                self.queue_report(
                    r,
                    actor,
                    Scope {
                        client,
                        website,
                        connection: validation::id(id)?,
                    },
                    provider,
                    action,
                )
                .await
            }
            [id, provider @ ("ga4" | "woocommerce" | "meta_ads")] => {
                self.report(r, actor, client, website, provider, &[id])
                    .await
            }
            [] if website.is_none() => {
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                if r.query.len() > 512 || (r.query_present && r.query.is_empty()) {
                    return Err(Error::Invalid("invalid_request"));
                }
                Ok(Reply::page(
                    integrations::list(&self.db, actor, client, query(r, &["limit", "cursor"])?)
                        .await?,
                ))
            }
            [provider @ ("ga4" | "woocommerce" | "meta_ads")] if website.is_none() => {
                no_query(r)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                if r.body.len() > 4096 {
                    return Err(Error::Invalid("invalid_request"));
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Google {
                    property_id: String,
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Commerce {
                    origin: String,
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Meta {
                    account_id: String,
                }
                let account = match *provider {
                    "ga4" => validation::json::<Google>(&r.body)?.property_id,
                    "woocommerce" => validation::json::<Commerce>(&r.body)?.origin,
                    _ => validation::json::<Meta>(&r.body)?.account_id,
                };
                Reply::data(
                    201,
                    integrations::create(&self.db, actor, client, provider.to_string(), account)
                        .await?,
                )
            }
            [id] => {
                no_query(r)?;
                if method != "GET" {
                    return Err(Error::Method("GET"));
                }
                Reply::data(
                    200,
                    integrations::read(
                        &self.db,
                        actor,
                        Scope {
                            client,
                            connection: validation::id(id)?,
                            website,
                        },
                    )
                    .await?,
                )
            }
            [id, "disconnect"] => {
                no_query(r)?;
                if method != "POST" {
                    return Err(Error::Method("POST"));
                }
                if r.body.len() > 1024 {
                    return Err(Error::Invalid("invalid_request"));
                }
                Ok(Reply::page(
                    integrations::disconnect(
                        &self.db,
                        actor,
                        Scope {
                            client,
                            connection: validation::id(id)?,
                            website,
                        },
                        validation::json(&r.body)?,
                    )
                    .await?,
                ))
            }
            _ => Err(Error::NotFound),
        }
    }
}
