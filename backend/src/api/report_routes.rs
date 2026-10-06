use super::*;
use crate::{reports, sync_period::Period, vault::Scope};
use zeroize::{Zeroize, Zeroizing};

impl Api {
    pub(super) async fn report(
        &self,
        r: &Request,
        actor: Actor,
        client: String,
        website: Option<String>,
        provider: &str,
        route: &[&str],
    ) -> Result<Reply> {
        if r.method != "GET" {
            return Err(Error::Method("GET"));
        }
        if route.is_empty() {
            if r.query.len() > 80 || (r.query_present && r.query.is_empty()) {
                return Err(Error::Invalid("invalid_request"));
            }
            let query = query(r, &["after"])?;
            let after = query.get("after").map(validation::id).transpose()?;
            return Ok(Reply::page(
                reports::list(&self.db, actor, client, website, provider.into(), after).await?,
            ));
        }
        let [connection] = route else {
            return Err(Error::NotFound);
        };
        let period = report_period(r, provider)?;
        Ok(Reply::page(
            reports::read_cached(
                &self.db,
                &self.report_cache,
                actor,
                Scope {
                    client,
                    website,
                    connection: validation::id(connection)?,
                },
                period,
            )
            .await?,
        ))
    }
    pub(super) async fn queue_report(
        &self,
        r: &Request,
        actor: Actor,
        scope: Scope,
        provider: &str,
        action: &str,
    ) -> Result<Reply> {
        if r.method != "POST" {
            return Err(Error::Method("POST"));
        }
        no_query(r)?;
        let setup = action == "credentials";
        let mut allowed = if provider == "woocommerce" {
            vec!["revision", "start", "end", "currency"]
        } else {
            vec!["revision", "since", "until"]
        };
        if setup {
            allowed.extend(match provider {
                "woocommerce" => vec!["consumer_key", "consumer_secret"],
                "ga4" => vec!["credential_json"],
                "meta_ads" => vec!["access_token"],
                _ => return Err(Error::NotFound),
            });
        }
        let max = match provider {
            "ga4" => 32_768,
            "woocommerce" => 4096,
            "meta_ads" => 8192,
            _ => return Err(Error::NotFound),
        };
        if r.body.len() > max {
            return Err(Error::Invalid("invalid_request"));
        }
        let mut fields = Fields::parse(&r.body, &allowed)?;
        let revision = validation::exact_integer(fields.get("revision")?, true)?;
        let period = if provider == "woocommerce" {
            Period::commerce(
                fields.get("start")?,
                fields.get("end")?,
                fields.get("currency")?,
            )?
        } else {
            Period::calendar(provider, fields.get("since")?, fields.get("until")?)?
        };
        let plaintext = if setup {
            Some(match provider {
            "woocommerce"=>Zeroizing::new(serde_json::to_vec(&serde_json::json!({"consumer_key":fields.get("consumer_key")?,"consumer_secret":fields.get("consumer_secret")?})).map_err(|_|Error::Internal)?),
            "ga4"=>Zeroizing::new(fields.get("credential_json")?.as_bytes().to_vec()),
            _=>Zeroizing::new(fields.get("access_token")?.as_bytes().to_vec()),
        })
        } else {
            None
        };
        fields.0.values_mut().for_each(Zeroize::zeroize);
        let queued = self
            .synchronization
            .enqueue(actor, scope, revision, period, plaintext)
            .await?;
        Ok(Reply {
            status: 202,
            body: Some(serde_json::to_value(queued).map_err(|_| Error::Internal)?),
            cookies: vec![],
        })
    }
}
fn report_period(r: &Request, provider: &str) -> Result<Period> {
    if r.query.len() > 200 || !r.query_present || r.query.is_empty() {
        return Err(Error::Invalid("invalid_request"));
    }
    let keys = if provider == "woocommerce" {
        &["start", "end", "currency"][..]
    } else {
        &["since", "until"][..]
    };
    let fields = query(r, keys)?;
    if fields.0.len() != keys.len() {
        return Err(Error::Invalid("invalid_request"));
    }
    if provider == "woocommerce" {
        Period::commerce(
            fields
                .get("start")
                .ok_or(Error::Invalid("invalid_request"))?,
            fields.get("end").ok_or(Error::Invalid("invalid_request"))?,
            fields
                .get("currency")
                .ok_or(Error::Invalid("invalid_request"))?,
        )
    } else {
        Period::calendar(
            provider,
            fields
                .get("since")
                .ok_or(Error::Invalid("invalid_request"))?,
            fields
                .get("until")
                .ok_or(Error::Invalid("invalid_request"))?,
        )
    }
}
struct Fields(std::collections::BTreeMap<String, String>);
impl Fields {
    fn parse(raw: &[u8], allowed: &[&str]) -> Result<Self> {
        let value =
            crate::provider_json::parse(raw).map_err(|_| Error::Invalid("invalid_request"))?;
        let value = value.as_object().ok_or(Error::Invalid("invalid_request"))?;
        if value.len() != allowed.len() {
            return Err(Error::Invalid("invalid_request"));
        }
        let mut result = Self(std::collections::BTreeMap::new());
        for (key, value) in value {
            if !allowed.contains(&key.as_str()) {
                return Err(Error::Invalid("invalid_request"));
            }
            let value = value
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or(Error::Invalid("invalid_request"))?;
            result.0.insert(key.clone(), value.into());
        }
        Ok(result)
    }
    fn get(&self, key: &str) -> Result<&str> {
        self.0
            .get(key)
            .map(String::as_str)
            .ok_or(Error::Invalid("invalid_request"))
    }
}
impl Drop for Fields {
    fn drop(&mut self) {
        self.0.values_mut().for_each(Zeroize::zeroize);
    }
}
