# Independent client websites

Issue #129 introduces 0..N relational properties under a client. Company identity, contacts, finance, pricing, general tasks and reminders retain their existing client scope. A website has its own name, URL, derived domain, description, active/archive state, revision, primary flag and history. The client and selected website remain visible in its workspace and switcher. Active properties can be selected from the switcher; the paginated portfolio includes archived properties and larger portfolios.

## Migration and integrity

Migration 26 creates `app.client_websites` and `app.website_integrations`. Every nonempty legacy `clients.website` value is preserved byte for byte in one legacy property. Conservative valid HTTP(S) values receive a domain; ambiguous values remain visible with a review flag. The original client column is retained. New client creation with an initial URL creates a property and records its audit event atomically. Later changes to the legacy profile field do not overwrite independently managed properties.

Client reads accept bounded legacy website text for escaped, non-linked display, so an uncertain old URL does not block the independent website workspace. New profile writes retain the existing strict URL validation; repairing a reviewed website does not silently rewrite the legacy profile value.

URLs are identifiers, never fetched by the website service. Valid new URLs accept HTTP/HTTPS or an implicit HTTPS domain, retain paths and subdomains, lowercase DNS hosts, and reject credentials, queries, fragments, IP literals and single-label hosts and control characters. International domains use ASCII punycode. Domain is derived rather than trusted from the request.

An active client can have at most one active primary website. Selecting a primary demotes the prior primary, advances both revisions and audits both changes in one transaction. Mutations require the current revision; conflicts and uncertain outcomes require an explicit reload. Archive retains data and associations, clears primary status and blocks editing/new assignments. It does not disconnect provider access or delete stored reports. Website-scoped provider requests remain readable after archive but reject mutations. Existing client-level integration management and background jobs retain their established lifecycle.

Rollback refuses independent websites, edited legacy rows, associations or website audit history. An untouched migration-only backfill can be removed because the original client values are retained. Back up the database before deployment and use forward repair after meaningful business writes.

## API and permissions

All routes use cookie authentication, no-store responses, bounded pagination and existing CSRF checks for mutations. Client and website IDs are checked together.

| Route relative to `/api/v1/clients/:client/websites` | Method | Purpose |
| --- | --- | --- |
| `/` | GET | List using `status=active/archived/all`, UUID cursor, limit 1–100 (default 25) |
| `/` | POST | Create name, URL and description |
| `/:website` | GET | Read property |
| `/:website` | PUT/PATCH | Replace editable fields with `expected_revision` |
| `/:website/primary` | POST | Select primary with revision and `confirm: true` |
| `/:website/archive` | POST | Archive with revision and confirmation |
| `/:website/connections` | GET | Paginated safe assigned connections |
| `/:website/connections` | POST | Explicit attach/remove with connection ID, revision, boolean `attach`, confirmation |
| `/:website/activity` | GET | Paginated safe website changes |
| `/:website/{analytics,commerce,marketing,integrations}/:connection/...` | Existing provider methods | Check website association, then reuse the original provider handler |

Reads require `clients.view`; edits require `clients.view` and `clients.update`; archive requires `clients.archive` in addition to view. Assigned connection lists also require `integrations.view` or `analytics.view`. Assignment management requires `integrations.manage`; activity requires `activity.view`. The original provider handlers independently enforce their existing permissions. A website does not introduce a second ACL hierarchy or an ownership bypass.

Existing connections remain unassigned until a manager confirms an association. Connections keep their immutable client owner, credential encryption context, provider job generations and stored report contracts. Composite foreign keys forbid cross-client associations. Each connection belongs to at most one website; moving it requires removing its current assignment first. GA4, WooCommerce and appropriate Meta accounts appear in site modules only after explicit assignment. Client-wide provider views retain separate connections and do not combine unrelated totals.

## Audit

Creation, editing, primary demotion/selection, archive and connection assignment changes use the existing atomic audit writer. Association changes also record `website_integration.created/deleted`. Safe snapshots contain existence/revision markers, not URLs, descriptions, tokens or provider secrets. Client activity includes website events; website activity is restricted to that property. Failed writes create no successful audit event.

Verification covers migration byte preservation, 0/1/multiple properties, primary races, stale revisions, pagination, wrong ownership, permissions, CSRF, archived reads/writes, binding conflicts and safe audit records. Real browser tests exercise the two-property workflow and stored-report association boundaries without installing live provider credentials.
