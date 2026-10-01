# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS build
WORKDIR /src
ENV GOTOOLCHAIN=local CGO_ENABLED=0
COPY go.mod go.sum ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    go mod download
COPY . .
RUN go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/api ./cmd/api \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/migrate ./cmd/migrate \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/bootstrap-admin ./cmd/bootstrap-admin \
    && go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/healthcheck ./cmd/healthcheck

FROM scratch AS common
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
USER 65532:65532

FROM common AS migration
COPY --from=build /out/migrate /migrate
ENTRYPOINT ["/migrate"]
CMD ["status"]

FROM common AS bootstrap
COPY --from=build /out/bootstrap-admin /bootstrap-admin
ENTRYPOINT ["/bootstrap-admin"]

FROM common AS production
COPY --from=build /out/api /api
COPY --from=build /out/healthcheck /healthcheck
ENV HTTP_ADDRESS=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 CMD ["/healthcheck"]
ENTRYPOINT ["/api"]
