//! Maintained upstream client, with its own HTTP transport and model decoding.
//! Input credentials arrive on stdin, never process arguments or test logs.
use rmcp::{
    ClientLifecycleMode, ClientServiceExt,
    model::{
        CallToolRequestParams, ClientConfig, GetPromptRequestParams, ProtocolVersion,
        ReadResourceRequestParams,
    },
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!(
            "Independent MCP interoperability failed (details withheld to protect credentials)."
        );
        std::process::exit(1)
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut raw = String::new();
    tokio::io::stdin()
        .take(16384)
        .read_to_string(&mut raw)
        .await?;
    let input: Value = serde_json::from_str(&raw)?;
    let endpoint = input["endpoint"].as_str().ok_or("endpoint")?;
    let token = input["access_token"].as_str().ok_or("access")?;
    let client = input["client_id"].as_str().ok_or("client")?;
    for modern in [true, false] {
        let config = StreamableHttpClientTransportConfig::with_uri(endpoint).auth_header(token);
        let transport = StreamableHttpClientTransport::from_config(config);
        let lifecycle = if modern {
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            }
        } else {
            ClientLifecycleMode::Initialize
        };
        let peer = ClientConfig::default()
            .serve_with_lifecycle(transport, lifecycle)
            .await?;
        let tools = peer.list_all_tools().await?;
        if tools.len() < 100 {
            return Err("tool discovery incomplete".into());
        }
        let result = peer
            .call_tool(
                CallToolRequestParams::new("else_clients_get").with_arguments(
                    json!({"client_id":client})
                        .as_object()
                        .ok_or("args")?
                        .clone(),
                ),
            )
            .await?;
        if result.is_error == Some(true)
            || result
                .structured_content
                .as_ref()
                .and_then(|v| v["data"]["id"].as_str())
                != Some(client)
        {
            return Err("tool result".into());
        }
        let resources = peer.list_resources(None).await?;
        if resources.resources.is_empty() {
            return Err("resources".into());
        }
        let resource = peer
            .read_resource(ReadResourceRequestParams::new(format!(
                "else://clients/{client}"
            )))
            .await?;
        if resource.contents.is_empty() {
            return Err("resource".into());
        }
        let prompts = peer.list_prompts(None).await?;
        if prompts.prompts.is_empty() {
            return Err("prompts".into());
        }
        let prompt = peer
            .get_prompt(
                GetPromptRequestParams::new("client_brief").with_arguments(
                    json!({"client_id":client})
                        .as_object()
                        .ok_or("args")?
                        .clone(),
                ),
            )
            .await?;
        if prompt.messages.is_empty() {
            return Err("prompt".into());
        }
        peer.cancel().await?;
        println!(
            "Official rmcp 3.5.1: {} discovery, tools, resources and prompts passed.",
            if modern { "2026-07-28" } else { "2025-11-25" }
        );
    }
    Ok(())
}
