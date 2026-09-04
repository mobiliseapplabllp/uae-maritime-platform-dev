# syntax=docker/dockerfile:1.7
# Generic image for any workspace service. Build from the repository root, for example:
#   docker build -f infra/docker/service.Dockerfile --build-arg SERVICE=services/mdm --build-arg PORT=5402 -t maritime/mdm .
# SERVICE is the workspace path of the service; PORT is baked as the default listening port and used by the
# health check. The service is installed with `pnpm deploy --prod` so the runtime image carries only production
# dependencies, and runs as the unprivileged `node` user.
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=10.33.0
ENV CI=true npm_config_store_dir=/pnpm/store
RUN npm install -g "pnpm@${PNPM_VERSION}" --no-fund --no-audit
WORKDIR /repo

FROM base AS build
ARG SERVICE
RUN test -n "${SERVICE}" || { echo "build-arg SERVICE is required, e.g. SERVICE=services/mdm" >&2; exit 1; }
COPY . .
# The braces matter. `--filter "./services/mdm..."` reads the whole string as a directory pattern and
# selects that one package; the trailing dots do nothing. `--filter "{./services/mdm}..."` is the form that
# takes a directory and adds its workspace dependencies. With the first form the shared packages were never
# installed or built, so every service that imports the kit failed its own typecheck inside the image with
# "cannot find module @maritime/service-kit". The gateway is the only service that imports none of them,
# which is why it was the one that passed.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "{./${SERVICE}}..." \
 && pnpm --filter "{./${SERVICE}}..." build \
 && pnpm --filter "./${SERVICE}" deploy --prod --legacy /out

FROM ${NODE_IMAGE} AS runtime
ARG PORT=5400
ENV NODE_ENV=production HOST=0.0.0.0 PORT=${PORT}
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE ${PORT}
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
