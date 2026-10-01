# Frontend containers

Related Issue: [#5](https://github.com/theroisey/else/issues/5). The companion backend PR supplies Compose, PostgreSQL TLS, runtime configuration, and startup instructions.

Build from the `frontend/` context. `development` runs Vite as the Node user on port 5173; `production` serves only the compiled assets with unprivileged nginx on port 8080. Both require a reachable `backend:8080` service on their container network. The browser uses the same origin for `/health`, `/ready`, and future `/api/v1/` endpoints. Unknown versioned API paths still return the backend's 404; no domain API is added here.

```sh
docker build --target development -t else-frontend:dev frontend
docker build --target production -t else-frontend:local frontend
```

Builds use the package lock and explicit base-image versions/digests, including the Dockerfile frontend. Node's digest was observed in the successful CI build; nginx's index digest was resolved from the registry during Issue #6. Runtime verification still depends on the combined Compose gate. No runtime database secrets are passed to the frontend. The build context includes only application source/configuration and package manifests; local environment files, keys, dependencies, and generated output are excluded.

The container Vite configuration leaves ordinary host development unchanged. Compose mounts `src/` for hot reload without mounting over the container's installed dependencies. nginx `/status` checks static-server liveness; `/ready` passes through real backend readiness.

The development stage transfers ownership of installed dependencies to the Node user so Vite can write its config bundle and dependency cache. Issue #6's companion CI checks exercise development startup and same-origin routing, then the static runtime.

Validation with Node 24.21.0/npm 11.19.0: clean installation, lint, 16 tests, typecheck, production build, and resolved container/host routing checks pass. Full image builds and nginx checks are blocked because Docker Hub rejects unauthenticated image pulls with `toomanyrequests`. Keep the companion PRs draft until container and Compose runtime verification succeeds.

In a managed proxy environment, pass the session CA as a BuildKit secret (`--secret id=proxy_ca,src="$CODEX_PROXY_CERT"`). The optional CA mount is consumed only during dependency installation, with certificate verification enabled, and is never copied into a layer. Ordinary local builds omit this secret.
