//! Native MCP protocol and delegated authorization; domain services remain authoritative.
pub mod access;
pub mod management;
pub mod oauth;
#[cfg(test)]
mod tests;

pub mod commands;

pub mod registry;

pub mod context;
pub mod protocol;
pub mod transport;

pub mod metrics;

pub mod analytics;

pub mod output;
