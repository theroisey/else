# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global npm@11.19.0 --strict-ssl=true && npm ci --strict-ssl=true
COPY frontend/ ./
RUN npm run build

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
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/healthcheck ./cmd/healthcheck

# The only application runtime image. Tools use an explicit entrypoint override.
FROM scratch AS production
COPY --from=backend-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend-build /out/ /
COPY --from=frontend-build /app/dist /frontend
USER 65532:65532
ENV HTTP_ADDRESS=0.0.0.0:8080 FRONTEND_DIRECTORY=/frontend
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 CMD ["/healthcheck"]
ENTRYPOINT ["/api"]
