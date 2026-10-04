# Frontend in the application image

The root [Dockerfile](../Dockerfile) builds the frontend and Go API into one production image under [#32](https://github.com/theroisey/else/issues/32). Run `docker compose build backend` from the repository root. The Go process serves built React assets and API on the same origin at port 8080; Compose publishes loopback port 5173 by default. There is no separate frontend/Nginx runtime image.

Node/npm exist only in the build stage. The root allowlisted .dockerignore excludes local environment files, dependencies, credentials and generated assets. Runtime files are read-only and the process is nonroot. Host npm/Vite development remains available; source changes require rebuilding the Docker application image.

See [Docker operations](../docs/docker.md), [browser headers](../docs/browser-security.md) and [publication gates](../docs/ci.md). Final container and browser evidence is required before readiness; changing image topology does not authorize rollout.
