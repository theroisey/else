# Meta manual read-token synchronization

Existing #25 implements one supported manual lifecycle. An operator provisions a **user token with ads_read**, authorized for the permanently bound numeric ad account, through their Meta application. This application does not issue OAuth tokens, escalate permissions, collect app secrets, refresh tokens or perform provider writes/revocation. Token expiration/revocation requires review and explicit replacement. A successful request proves API access at collection time, not legal ownership or perpetual authorization.

## Official authorization and transport evidence

Verified 2026-10-04 through approved official GitHub sources:

- Meta's [Permission.swift at 8ae022c6bbc5fa8464012f7b6ae30c18ab367e43](https://github.com/facebook/facebook-ios-sdk/blob/8ae022c6bbc5fa8464012f7b6ae30c18ab367e43/FBSDKCoreKit/FBSDKCoreKit/Permission.swift) explicitly describes ads_read as access to Ads Insights reports for ad accounts the user can access.
- Current Business SDK 26.0.2 [User.get_permissions](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/user.py) specifies GET /permissions. [Permission](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/permission.py) supplies permission/status and granted/declined/expired values.
- The same pinned [AdAccount](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adaccount.py) supplies account_id/currency/timezone_name and GET account/insights contracts. [API config](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/apiconfig.py) pins v26.0.
- Meta's official [WooCommerce API transport at c4d3d339cef493411e08e9d7d9ab711723ab3e7a](https://github.com/facebook/facebook-for-woocommerce/blob/c4d3d339cef493411e08e9d7d9ab711723ab3e7a/includes/API.php) corroborates graph.facebook.com and Authorization: Bearer transport. Its older API version is not adopted here.

The worker checks ads_read **granted** using GET `/v26.0/me/permissions?fields=permission,status&limit=100`. This bounded manual user-token subset fails safely if permissions are missing, incomplete or incompatible. Other returned permissions are ignored; the application does not assert that the independently issued token possesses only ads_read. Applications requiring app-secret proof or an incompatible token class cannot collect with this setup. No implicit fallback, broad permission request or secret query parameter exists.

## Collection and privacy

Compile only HTTPS GETs to graph.facebook.com/v26.0 with Bearer Authorization. The shared public-DNS/TLS layer rejects redirects and unsafe resolution. No arbitrary endpoint or provider navigation URL is followed. Read exactly id/account_id/currency/timezone_name for the account; require immutable account agreement, valid currency and IANA timezone. Fetch the seven minimal daily account fields from [the exact interpretation contract](meta-insights.md) with level=account, time_increment=1, explicit inclusive dates and limit=31. Maximum 31 unique dates, four 64-KiB Insights pages, bounded noncycling after cursors, plus bounded permission/context checks. Oversized/incomplete/expanded/misbound data fails atomically.

After collection, reread the first page, account context and granted permission. Observed first-page/context changes refuse publication. Complete collection lasts at most 120 seconds; its recorded UTC-microsecond interval is not a transactional snapshot guarantee. Every request and final publication rechecks current local client, requester grants, connection revision/generation, encrypted credential revision and lease. There is no database transaction across network work. Failure records a fixed safe reason and requires explicit business retry. Provider responses, account IDs, tokens, cursor/link values and user details do not enter public reports, audit snapshots or logs.

## Durable jobs and operations

Apply migration **25** and reviewed runtime grants before running the updated worker/API. Date parameters remain account-local inclusive calendars, maximum 31 days, distinct from WooCommerce UTC half-open periods. Private shared job/snapshot tables distinguish meta_ads, ga4 and woocommerce; one global maximum of **two** live jobs applies across all providers and worker replicas. The existing `/analytics-worker` checks providers in rotating order with fallback, using the **same single application image**. Use the same protected key source and least-privilege runtime database identity; API requests never perform collection. Worker pool limits, lease 180 seconds, operation 150 seconds and three interrupted-attempt limit are unchanged.

Token setup validates bounded Bearer syntax, irreversibly reserves/audits encryption budget, binds ciphertext to meta_ads/access_token, stores it under current lifecycle fences, and queues work atomically with safe audits. Replacement cancels/audits old work and invalidates older-generation reports. Complete publication is idempotent by connection/generation/provider/since/until, independently validates exact metric formulas/sums in Go and SQL, and atomically records snapshot/job/connection events. Failed refresh preserves a valid snapshot within the current generation. Reads require clients.view plus analytics.view independently of integration view/manage. Setup/create/sync requires current clients.view plus integrations.manage and an active client.

Retention is the shared 90-day aggregate policy with bounded audited pruning; credential budget, job, binding and audit history remain retained. Down migration refuses any Meta job/snapshot history, even after aggregate pruning. Do not remove historical migrations, delete retained work to force rollback or refund consumed encryption units. A version-24 worker cannot handle Meta jobs; rollback needs the reviewed compatible-image procedure and retained migration 25. Local disconnect immediately fences access; remote revocation must be completed separately in Meta settings and is never claimed verified.

## API

- POST `/api/v1/clients/:client/integrations/meta_ads` with account_id creates pending immutable metadata.
- POST `/api/v1/clients/:client/integrations/:connection/meta_ads/credentials` with revision, since, until, access_token encrypts and queues.
- POST the matching `/sync` with revision, since, until queues the saved token.
- GET `/api/v1/clients/:client/marketing[/:connection]` lists safe keyset metadata or reads a stored report with since/until query values.

Authenticated mutations require same-origin CSRF, strict JSON fields, no URL credentials, and exact revision checks. Missing protected keyring yields safe 503 for setup without fabricated success. Reads remain available when no keyring is configured. GETs use no-store and never trigger synchronization. Stored read aliases under the matching integration path preserve the same permission checks.
