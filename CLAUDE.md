# CLAUDE.md — Maritime Platform (greenfield rebuild)

**New here? Read `HANDOVER.md` first** — state of play, decisions, gotchas, open items.

This repository is the from-scratch rebuild of the maritime digital-services platform on its
target architecture: PostgreSQL per service, independently deployable NestJS microservices behind
an API gateway, NATS JetStream events, a built-in low-code/no-code service engine, a supervised
agentic-AI layer (Python/FastAPI), a React/MUI web application whose UI/UX is identical to the
reference product, an insights app, and Flutter mobile apps. The reference product lives in the
separate repository `maritime-project-presentation` (branch
`claude/maritime-project-presentation-g9sphj`) and is consulted read-only; nothing is copied.

## Rules — non-negotiable

1. **Code only in git.** Source, contracts, migrations, definitions, infrastructure, tests,
   runbooks and these three memory files (`CLAUDE.md`, `AGENTS.md`, `HANDOVER.md`). Proposal
   documents, decks, plans and reports are delivered outside the repository.
2. **Data rules.** Real infrastructure and public statistics are fine. Every transaction, agent,
   incident, invoice, licence and crew record is fictional. The eight documented real liner callers
   (MSC Anna, APL Raffles, MSC Al Rawdah, Maersk Kensington, Maersk Chicago, CMA CGM Ural, ESL Wafa,
   Folk Jazan) may appear for schedule realism only and carry clean records — code excludes them
   from incidents, inspections, billing and watchlists. Identifiers of the sample kind are marked
   `(sample)`. MT Bangus is excluded from every register.
3. **Secrets never enter git.** Environment files are ignored; `.env.example` files document names
   only. Certificate-signing keys are never rotated in a way that invalidates issued instruments —
   key history is retained so every signature verifies for its full validity.
4. **No model identifiers** in commits, code comments or pushed artefacts.
5. **Branches.** Foundation work lands on `main`; every later phase goes through a feature branch
   and a draft pull request. Never push elsewhere.
6. **Agents hold no privileged data path.** Every AI action goes through `ai-tool-gateway` to the
   same governed APIs, with the same authorisation and the same audit ledger as a human user.
7. **Do not apply the MALL SDLC skill** here; the user asked for direct execution.

## Architecture in one paragraph
Eight domain services (`ships`, `seafarers`, `legislation`, `maritime-centre`, `inspection`,
`ports`, `facilities`, `revenue`) and ten platform services (`identity-access`, `mdm`,
`workflow`, `rules`, `instruments`, `documents`, `notifications`, `audit-ledger`, `scheduler`,
`integration-hub`) plus `reporting` (CQRS read models), `gateway`, and four AI services
(`ai-tool-gateway`, `ai-agents`, `ai-assistant`, `ai-platform`). Each service owns its
PostgreSQL schema, publishes CloudEvents-style domain events through a transactional outbox to
NATS JetStream, consumes through an idempotent inbox, exposes an OpenAPI contract generated from
code, validates Keycloak JWTs itself, and writes audit entries for every mutation. Service
definitions (forms, workflow, rules, fees, documents, templates, notifications, agent behaviour)
are versioned JSON interpreted by one runtime; the Service Studio in `apps/web` is their design
surface. Tenancy scopes (national, port, zone, facility) and bilingual fields exist from the first
migration.

## Commands
```bash
infra/local/runtime.sh start|stop|status   # native PostgreSQL, NATS, Keycloak for this container
pnpm install && pnpm -r build              # workspace build
pnpm -r test                               # unit + contract tests
pnpm --filter <service> migrate            # apply that service's migrations
pnpm --filter <service> seed               # seed that service from packages/world
pnpm --filter web dev                      # web app on :5300 (gateway on :5200)
pnpm e2e                                   # Playwright drives + parity diffs
```

## Conventions
- Permissions are `module.action` strings; the catalogue in `packages/contracts` is the single
  source for guards, seeds and the roles matrix editor. Deny by default.
- Every mutating endpoint writes an audit entry (actor, entity, before/after, correlation id).
- State machines are declared transition tables in `packages/contracts`, enforced server-side.
- Responses use `{ success, data, meta }`; errors `{ success, message }`; pagination
  `page/limit/sort/q` with `meta.total`.
- Numbering series are atomic (sequence tables); never count-based.
- Seeds are deterministic (fixed PRNG) and shared through `packages/world`; the `AE` profile is
  the default world, `IN` is kept for parity checks against the reference product.
- Money is integer minor units; times are UTC in storage, local in rendering.
- English strings are i18n keys; Arabic values live in the catalogues; every definition,
  instrument and notification carries `*_ar` fields.

## Verification bar
Before calling a change done: unit and contract tests green, integration tests on the native
runtime, both bundles building, a Playwright drive with screenshots, parity diff against the
reference demo build for ported screens, security scans clean, and a push.
