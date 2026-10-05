# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global npm@11.19.0 --strict-ssl=true && npm ci --strict-ssl=true
COPY frontend/ ./
RUN npm run build \
    && mkdir -p /distribution/frontend /distribution/usr/share/licenses/else \
    && cp -R dist/. /distribution/frontend/ \
    && find /distribution/frontend -type d -exec chmod 0755 {} + \
    && find /distribution/frontend -type f -exec chmod 0644 {} + \
    && install -m 0644 node_modules/@fontsource-variable/manrope/LICENSE /distribution/usr/share/licenses/else/Manrope-OFL.txt \
    && install -m 0644 node_modules/@fontsource/instrument-serif/LICENSE /distribution/usr/share/licenses/else/Instrument-Serif-OFL.txt

FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS backend-build
WORKDIR /src
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    go mod download
COPY backend/ ./
ARG BUILD_VERSION=""
ARG BUILD_REVISION=""
ARG BUILD_TIME=""
RUN sh scripts/build-api.sh /out/api "$BUILD_VERSION" "$BUILD_REVISION" "$BUILD_TIME" \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/migrate ./cmd/migrate \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/bootstrap-admin ./cmd/bootstrap-admin \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/rotate-integration-credentials ./cmd/rotate-integration-credentials \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/analytics-worker ./cmd/analytics-worker \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/container-preflight ./cmd/container-preflight \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/healthcheck ./cmd/healthcheck

# PostgreSQL runtime plus a small PID-1 reaper from signed Debian packages.
FROM postgres:18.3@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db AS postgres-runtime
RUN rm -f /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends tini util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'else:x:65532:65532:Roisey Else:/nonexistent:/usr/sbin/nologin\nelse_operator:x:65533:65533:Roisey Else operator:/nonexistent:/usr/sbin/nologin\n' >> /etc/passwd \
    && printf 'else:x:65532:\nelse_operator:x:65533:\n' >> /etc/group

# Copy the runtime filesystem rather than inheriting PostgreSQL's anonymous
# /var/lib/postgresql VOLUME. The distribution has exactly one persistent volume.
FROM scratch AS production
ARG BUILD_VERSION=""
ARG BUILD_REVISION=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.source="https://github.com/theroisey/else" \
    org.opencontainers.image.version=$BUILD_VERSION \
    org.opencontainers.image.revision=$BUILD_REVISION \
    org.opencontainers.image.created=$BUILD_TIME
COPY --from=postgres-runtime / /
COPY --from=backend-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend-build /out/ /
COPY --from=frontend-build /distribution/ /
COPY --chmod=0755 docker/runtime/ /opt/else/
COPY --chmod=0644 backend/scripts/grant-runtime.sql /opt/else/grant-runtime.sql
USER 0:0
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin \
    LANG=en_US.utf8 HTTP_ADDRESS=0.0.0.0:8080 FRONTEND_DIRECTORY=/frontend
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=6 CMD ["/healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/else/start"]
