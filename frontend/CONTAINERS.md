# Frontend containers

Related Issue: [#5](https://github.com/theroisey/else/issues/5). The companion backend PR supplies Compose, PostgreSQL TLS, runtime configuration, and startup instructions.

Build from the `frontend/` context. `development` runs Vite as the Node user on port 5173; `production` serves only the compiled assets with unprivileged nginx on port 8080. Both require a reachable `backend:8080` service on their container network. The browser uses the same origin for `/health`, `/ready`, and future `/api/v1/` endpoints. Unknown versioned API paths still return the backend's 404; no domain API is added here.

```sh
docker build --target development -t else-frontend:dev frontend
docker build --target production -t else-frontend:local frontend
```

Builds use the package lock and explicit base-image versions. Registry image availability and immutable digest resolution must be verified before release publication in Issue #6. No runtime database secrets are passed to the frontend. The build context includes only application source/configuration and package manifests; local environment files, keys, dependencies, and generated output are excluded.

The container Vite configuration leaves ordinary host development unchanged. Compose may mount `src/` and `public/` for hot reload without mounting over the container's installed dependencies. nginx `/status` checks static-server liveness; `/ready` passes through real backend readiness.

In a managed proxy environment, pass the session CA as a BuildKit secret (`--secret id=proxy_ca,src="$CODEX_PROXY_CERT"`). The optional CA mount is consumed only during dependency installation, with certificate verification enabled, and is never copied into a layer. Ordinary local builds omit this secret.
