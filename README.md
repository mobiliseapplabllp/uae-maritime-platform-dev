# Maritime Platform

Rebuild of the maritime digital-services platform on its target architecture: PostgreSQL per
service, NestJS microservices behind an API gateway, NATS JetStream events, a built-in low-code
service engine, a supervised agentic-AI layer, a React/MUI web application and Flutter mobile apps.

## Run locally (Linux/macOS, native runtime)
```bash
infra/local/runtime.sh start      # PostgreSQL 16 (+PostGIS, pgvector), NATS JetStream, Keycloak
pnpm install
pnpm build
pnpm migrate && pnpm seed          # per-service schemas and the fictional world (AE profile)
pnpm dev                           # gateway :5200, services :54xx, web :5300
```
On a Mac with Docker Desktop: `docker compose -f infra/compose/docker-compose.yml up --build`.

## Layout
`apps/` web, insights, mobile · `services/` platform and domain services · `ai/` AI services ·
`packages/` contracts, service-kit, design-system, world · `definitions/` versioned service
definitions per drop · `infra/` local runtime, compose, Helm, OpenTofu, gateway, stubs, evidence ·
`security/` threat models and control mapping · `tools/` migration, export, exit, escrow ·
`tests/` contract, e2e, perf, accessibility/RTL · `runbooks/` operations.

See `CLAUDE.md` for the rules and conventions and `HANDOVER.md` for the state of play.
