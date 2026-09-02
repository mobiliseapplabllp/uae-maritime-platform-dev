# syntax=docker/dockerfile:1.7
# Web application image: builds apps/web with pnpm and serves apps/web/dist from an unprivileged nginx with an
# SPA fallback; /api is proxied to the gateway (GATEWAY_URL, default http://gateway:5200). Build from the root:
#   docker build -f infra/docker/web.Dockerfile -t maritime/web .
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=10.33.0
ENV CI=true npm_config_store_dir=/pnpm/store
RUN npm install -g "pnpm@${PNPM_VERSION}" --no-fund --no-audit
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "./apps/web..." \
 && pnpm --filter "./apps/web..." build \
 && test -f apps/web/dist/index.html

FROM ${NGINX_IMAGE} AS runtime
ENV GATEWAY_URL=http://gateway:5200
COPY infra/docker/nginx.web.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
