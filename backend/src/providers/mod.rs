//! Compiled read-only collectors. The request boundary performs a fresh durable
//! authorization/lease check before every request, after any CPU preparation.
use crate::{
    error::{Error, Result},
    provider_credentials::ServiceAccount,
    provider_http::{Call, Page, Transport},
    sync_period::Period,
    synchronization::{Job, Synchronization},
};
use std::{sync::Arc, time::Duration};
pub mod commerce;
#[cfg(test)]
mod commerce_tests;
pub mod ga4;
mod ga4_normalize;
#[cfg(test)]
mod ga4_tests;
pub mod meta;
#[cfg(test)]
mod meta_tests;
pub mod workspace;

pub struct Providers {
    transport: Transport,
}
impl Providers {
    pub fn new() -> Result<Self> {
        Ok(Self {
            transport: Transport::new()?,
        })
    }
    pub async fn ga4(
        &self,
        sync: &Synchronization,
        job: Job,
        account: String,
        credential: Arc<ServiceAccount>,
    ) -> Result<ga4::Workspace> {
        let Period::Calendar {
            provider,
            since,
            until,
        } = &job.period
        else {
            return Err(Error::Internal);
        };
        if provider != "ga4" {
            return Err(Error::Internal);
        }
        let request = ga4::Request {
            client: job.client.clone(),
            connection: job.connection.clone(),
            property: account,
            since: since.clone(),
            until: until.clone(),
        };
        let wire = Fenced {
            sync: sync.clone(),
            job,
            transport: self.transport.clone(),
        };
        tokio::time::timeout(
            Duration::from_secs(120),
            ga4::fetch(&wire, sync.crypto(), credential, request),
        )
        .await
        .map_err(|_| Error::Internal)?
    }
    pub async fn meta(
        &self,
        sync: &Synchronization,
        job: Job,
        account: String,
        credential: crate::provider_credentials::ReadToken,
    ) -> Result<meta::Workspace> {
        let Period::Calendar {
            provider,
            since,
            until,
        } = &job.period
        else {
            return Err(Error::Internal);
        };
        if provider != "meta_ads" {
            return Err(Error::Internal);
        }
        let request = meta::Request {
            client: job.client.clone(),
            connection: job.connection.clone(),
            account,
            since: since.clone(),
            until: until.clone(),
        };
        let wire = Fenced {
            sync: sync.clone(),
            job,
            transport: self.transport.clone(),
        };
        tokio::time::timeout(
            Duration::from_secs(120),
            meta::fetch(&wire, &credential, request),
        )
        .await
        .map_err(|_| Error::Internal)?
    }
    pub async fn commerce(
        &self,
        sync: &Synchronization,
        job: Job,
        origin: String,
        credential: crate::provider_credentials::ReadKey,
    ) -> Result<commerce::Workspace> {
        let Period::Commerce {
            start,
            end,
            currency,
        } = &job.period
        else {
            return Err(Error::Internal);
        };
        let binding = commerce::Binding::new(
            job.client.clone(),
            job.connection.clone(),
            start.clone(),
            end.clone(),
            currency.clone(),
        )?;
        let wire = Fenced {
            sync: sync.clone(),
            job,
            transport: self.transport.clone(),
        };
        tokio::time::timeout(
            Duration::from_secs(120),
            commerce::fetch(&wire, &origin, &credential, binding),
        )
        .await
        .map_err(|_| Error::Internal)?
    }
}

fn collected_now() -> Result<String> {
    crate::history_cursor::canonical(&crate::validation::now())
}
fn collected_span(start: &str, end: &str) -> Result<()> {
    if crate::history_cursor::canonical(start).map_err(|_| Error::Internal)? != start
        || crate::history_cursor::canonical(end).map_err(|_| Error::Internal)? != end
    {
        return Err(Error::Internal);
    }
    let start = chrono::DateTime::parse_from_rfc3339(start).map_err(|_| Error::Internal)?;
    let end = chrono::DateTime::parse_from_rfc3339(end).map_err(|_| Error::Internal)?;
    use chrono::Datelike;
    if start.year() < 2000 || end < start || (end - start) > chrono::Duration::seconds(121) {
        return Err(Error::Internal);
    }
    Ok(())
}
#[async_trait::async_trait]
trait Requestor: Send + Sync {
    async fn call(&self, origin: &str, call: Call<'_>) -> Result<Page>;
}
struct Fenced {
    sync: Synchronization,
    job: Job,
    transport: Transport,
}
#[async_trait::async_trait]
impl Requestor for Fenced {
    async fn call(&self, origin: &str, call: Call<'_>) -> Result<Page> {
        self.sync.fence(self.job.clone()).await?;
        self.transport.client(origin)?.call(call).await
    }
}
