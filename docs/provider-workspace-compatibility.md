# Selected-provider workspace compatibility

[#117](https://github.com/theroisey/else/issues/117) prepares the existing integration workspace for user-selected GA4/WooCommerce under #26/#27. No backend schema, credential, authorization, transport, setup, synchronization, metric or provider success changes. Backend remains Meta-only until its guarded connection/crypto catalog is separately expanded.

The strict seven-field connection DTO accepts exactly `meta_ads`, `ga4` and `woocommerce`, displaying Meta Ads, Google Analytics 4 and WooCommerce. Unknown identifiers/private fields/malformed IDs/revisions/states/timestamps stay rejected. Local-disable responses must preserve the original provider/client/connection, expected revision and unavailable/unverified remote revocation; an allowed different provider is still an invalid response.

List/detail show the recorded provider. Existing “Connected (recorded)” and metadata/live-observation wording, independent scope gates, fresh active-client/state checks, confirmation and uncertain-outcome recovery remain. Manual attention names the provider account settings without inventing an endpoint, verifying remote success or exposing a key/account ID. No new action is offered.

Contract/flow tests cover all identifiers and cross-provider mutation rejection. The Meta browser flow retains real SQL/session/grant/confirmation/audit/revocation checks. Additional **test-only authenticated response projections** change its detail DTO's provider field for GA4/WooCommerce desktop/mobile verification. Screenshots say “Synthetic provider DTO projection · no backend/provider activation”; tests assert no mutation and SQL still contains only Meta records. This proves frontend compatibility, not persisted GA4/WooCommerce state or provider access.

Local focused 54 cases pass. Full lint/typecheck/unit/build and secured browser verification plus all six exact-head CI gates are required before ready; final results belong in #117/its PR. Parent setup/background ingestion/metrics/UI acceptance stays open. Future backend must preserve this exact private seven-field contract.
