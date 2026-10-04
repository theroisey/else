# Frontend browser security

Related: [#103](https://github.com/theroisey/else/issues/103), part of [#30](https://github.com/theroisey/else/issues/30). The Go application server applies the compiled `backend/internal/http/browser-headers.json` policy to SPA, asset, public, API and error responses:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The server sets one canonical value per header; API nosniff uses the same value. Scripts, styles, fonts and connections must stay on the same origin; images additionally allow data URLs for the bundled favicon. Objects, base overrides and embedding are denied. There is no inline/eval exception or invented reporting endpoint. These controls supplement escaping, authorization, cookies and CSRF; malicious same-origin code remains dangerous.

Font Awesome's official CSS is bundled, and `runtime-security.ts` disables runtime stylesheet injection before rendering. Every schema imports Zod through `lib/validation.ts`, which enables the supported `jitless` parser before object construction. An entrypoint-only setting was insufficient: shared production chunks construct schemas before the entrypoint executes, and Zod's caught Function capability probe still emits a CSP violation. The shared configured import removes that probe without changing validation rules or dependencies. ESLint rejects direct Zod imports elsewhere; the normal validation/UI test suite uses this configuration.

## Evidence and reproduction

Container integration runs `frontend/scripts/check-security-headers.py` against the actual nonroot application image with the actual API. It verifies exact, nonduplicated headers and expected statuses for the SPA, built JavaScript/CSS, `/status`, `/health`, `/ready`, unauthenticated session and API 404 routes. This proves Go runtime header application; it does not run a browser inside the production container.

Browser authentication builds the artifact and starts one compiled Go server with FRONTEND_DIRECTORY pointing to a disposable copy of that build. The same server handles UI, API and readiness against real disposable PostgreSQL. Chromium checks sign-in rendering, visible bundled icon CSS, failed-login validation and same-origin readiness with zero spontaneous CSP violations. Controlled eval/inline/external scripts, inline style, base override, hostile form and framing attempts must be blocked. No attacker request is accepted for the script/form probes. Fixtures contain only synthetic public values; no successful session is added before the original 15 cookie/auth/audit browser tests, which run against the same Go-served artifact. Occupied-port refusal and owned cleanup apply throughout.

Run `sh frontend/scripts/test-auth-browser.sh` with the pinned Node/npm/Go toolchains, Docker and Playwright Chromium. Port 5173 must be free; never terminate another developer's listener. Run `sh backend/scripts/test-compose.sh` after committing the tested source because that runner archives HEAD. Full exact-head Browser and Container CI outcomes remain required before ready review. Unit/lint/typecheck/build results do not substitute for those runtime checks.

## Operating limits

The disposable test artifact contains one fixed public synthetic same-origin eval probe in its assets directory. The production artifact/image has no probe. Loading that ordinary allowed script proves it executes before its dynamic-code attempt is denied. DevTools evaluation itself can bypass code-generation policy and cannot establish this negative control.

Browser tests exercise the compiled Go server and actual built frontend; container tests separately exercise the application image. HSTS, trusted TLS termination, production cookie policy, distributed edge throttling and deployed-header verification belong to an explicit deployment target under #32. No production rollout, provider activation or certification occurs here. New scripts, embeds, external assets, inline styles or dependency code generation require review and runtime compatibility checks; do not silently weaken the policy.

Reviewed official OWASP CheatSheetSeries commit `6b6a66bae11c9e001c3576bcc3de55cc0dc5e449`: [CSP guidance](https://github.com/OWASP/CheatSheetSeries/blob/6b6a66bae11c9e001c3576bcc3de55cc0dc5e449/cheatsheets/Content_Security_Policy_Cheat_Sheet.md) and [clickjacking defenses](https://github.com/OWASP/CheatSheetSeries/blob/6b6a66bae11c9e001c3576bcc3de55cc0dc5e449/cheatsheets/Clickjacking_Defense_Cheat_Sheet.md). Frame policy requires response headers, not a meta element.
