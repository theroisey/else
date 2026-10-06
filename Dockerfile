# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# Both the static Rust binary and frontend are built and checked BEFORE Docker.
# Missing artifacts fail COPY; this image has no networked build or compiler stage.
FROM scratch
ARG BUILD_REVISION=""
ARG BUILD_TIME=""
LABEL org.opencontainers.image.source="https://github.com/theroisey/else" \
      org.opencontainers.image.revision=$BUILD_REVISION \
      org.opencontainers.image.created=$BUILD_TIME
COPY --chmod=0555 build/roisey-else /roisey-else
COPY build/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY build/licenses/ /licenses/
COPY frontend/dist/ /app/frontend/
# Copy a named directory entry. COPY of an empty directory's contents does not
# consistently preserve its destination metadata across Docker builders.
COPY --chown=65532:65532 build/data/ /var/lib/
USER 65532:65532
ENV HTTP_ADDRESS=0.0.0.0:8080 \
    DATABASE_PATH=/var/lib/roisey-else/else.sqlite3 \
    FRONTEND_DIRECTORY=/app/frontend \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 CMD ["/roisey-else", "health"]
ENTRYPOINT ["/roisey-else"]
CMD ["serve"]
