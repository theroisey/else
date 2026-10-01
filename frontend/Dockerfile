# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Optional session CA remains outside image layers; normal local builds need none.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --strict-ssl=true

FROM dependencies AS development
COPY --chown=node:node . .
USER node
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
    CMD node -e 'fetch("http://127.0.0.1:5173/").then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))'
CMD ["./node_modules/.bin/vite", "--config", "vite.docker.config.ts"]

FROM dependencies AS build
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29.1-alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/status || exit 1
