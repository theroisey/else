//! Pingora background service in the application process, never a second server.
use crate::{
    error::{Error, Result},
    provider_credentials::Credential,
    providers::{Providers, workspace::Workspace},
    synchronization::Synchronization,
};
use pingora_core::{server::ShutdownWatch, services::background::BackgroundService};
use std::{sync::Arc, time::Duration};
use tokio::task::JoinSet;

pub struct Worker {
    sync: Synchronization,
    providers: Arc<Providers>,
}
impl Worker {
    pub fn new(sync: Synchronization) -> Result<Self> {
        Ok(Self {
            sync,
            providers: Arc::new(Providers::new()?),
        })
    }
    pub async fn run_once(&self) -> Result<bool> {
        tokio::time::timeout(Duration::from_secs(150), async {
            let Some(job) = self.sync.claim().await? else {
                return Ok(false);
            };
            if job.state == "failed" {
                return Ok(true);
            }
            let workspace = match self.sync.credential(job.clone()).await {
                Ok((account, Credential::Ga4(credential))) => self
                    .providers
                    .ga4(&self.sync, job.clone(), account, credential)
                    .await
                    .map(|w| Workspace::Ga4(Box::new(w)))
                    .ok(),
                Ok((account, Credential::Commerce(credential))) => self
                    .providers
                    .commerce(&self.sync, job.clone(), account, credential)
                    .await
                    .map(|w| Workspace::Commerce(Box::new(w)))
                    .ok(),
                Ok((account, Credential::Meta(credential))) => self
                    .providers
                    .meta(&self.sync, job.clone(), account, credential)
                    .await
                    .map(|w| Workspace::Meta(Box::new(w)))
                    .ok(),
                Err(_) => None,
            };
            self.sync.finish(job, workspace).await?;
            Ok(true)
        })
        .await
        .map_err(|_| Error::Busy)?
    }
}
#[async_trait::async_trait]
impl BackgroundService for Worker {
    async fn start(&self, mut shutdown: ShutdownWatch) {
        let mut work = JoinSet::new();
        for _ in 0..2 {
            let worker = Self {
                sync: self.sync.clone(),
                providers: self.providers.clone(),
            };
            work.spawn(async move {
                loop {
                    let delay = match worker.run_once().await {
                        Ok(true) => Duration::from_millis(100),
                        Ok(false) => Duration::from_secs(1),
                        Err(error) => {
                            tracing::warn!(error_code = error.code(), "provider_job_cycle_failed");
                            Duration::from_secs(1)
                        }
                    };
                    tokio::time::sleep(delay).await;
                }
            });
        }
        let mut prune = tokio::time::interval(Duration::from_secs(900));
        prune.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _=shutdown.changed()=>{self.sync.stop();work.abort_all();while work.join_next().await.is_some(){};break;},
                _=prune.tick()=>{if let Err(error)=self.sync.prune().await {tracing::warn!(error_code=error.code(),"provider_retention_failed");}},
                _=work.join_next()=>{tracing::error!(error_code="provider_worker_stopped","application_failed");std::process::exit(1);},
            }
        }
    }
}
