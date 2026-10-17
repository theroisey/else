//! Shared typed wire contracts. Domain read projections remain the native API's
//! selected object/array DTOs; mutation receipts and errors have exact schemas.
use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::{Arc, OnceLock};
#[derive(Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Envelope<T> {
    pub data: T,
    pub request_id: String,
}
#[derive(Serialize, schemars::JsonSchema)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Committed {
        command_id: String,
        id: String,
        resource_kind: String,
        revision: Option<String>,
        request_id: String,
    },
    ApprovalRequired {
        approval_id: String,
        approval_state: String,
        review_path: String,
        command_id: String,
    },
    Reconciled {
        command_id: String,
        record: Value,
    },
}
#[derive(Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub error: FailureDetail,
    pub retry: String,
}
#[derive(Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FailureDetail {
    pub code: String,
    pub message: String,
}
#[derive(Serialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum WriteData {
    Mutation(Mutation),
    Failure(Failure),
}
#[derive(Serialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum ReadData {
    Object(Map<String, Value>),
    Array(Vec<Value>),
}
pub fn value<T: Serialize>(v: T) -> Result<Value> {
    serde_json::to_value(v).map_err(|_| Error::Internal)
}
pub fn schema(write: bool) -> Arc<Map<String, Value>> {
    static READ: OnceLock<Arc<Map<String, Value>>> = OnceLock::new();
    static WRITE: OnceLock<Arc<Map<String, Value>>> = OnceLock::new();
    let selected = if write { &WRITE } else { &READ };
    selected
        .get_or_init(|| {
            let value = if write {
                serde_json::to_value(schemars::schema_for!(Envelope<WriteData>))
            } else {
                serde_json::to_value(schemars::schema_for!(Envelope<ReadData>))
            }
            .expect("compiled output schema");
            Arc::new(value.as_object().expect("object schema").clone())
        })
        .clone()
}
