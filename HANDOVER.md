# Handover — Maritime Platform greenfield rebuild

**Last updated:** 2 September 2026 · repository `mobiliseapplabllp/uae-maritime-platform-dev` (private) · branch `main`

Read this first if you are picking the project up cold. `CLAUDE.md` holds the rules and
conventions; this file holds the state of play, the decisions and what is open.

## 1. What this is
A from-scratch rebuild of the maritime digital-services platform (the reference product lives in
`maritime-project-presentation`, branch `claude/maritime-project-presentation-g9sphj`, head
`825c06b`) on the target architecture presented to L&T Technology Services (prime contractor) and
the Ministry of Energy and Infrastructure: eight domain services and ten platform services on
PostgreSQL 16, NATS JetStream events, Keycloak identity, a built-in low-code/no-code service engine
with a Service Studio, a supervised agentic-AI layer, a React/MUI web app with UI/UX identical to
the reference, an insights app, and Flutter mobile apps. The verified rebuild plan (version 2)
and its traceability appendices (RFP, decks and annexures, TAD, proposal) are delivered to the
user as documents and are not in git.

## 2. Decisions already taken
- Repository name chosen by the user ("uae-martime-platform-dev" typed; spelling corrected to
  `uae-maritime-platform-dev` and flagged). Private. Foundation on `main`, later phases through
  draft pull requests.
- Stack: TypeScript/NestJS 11 services (SWC build, Vitest), React 18 + Vite 6 + MUI 5 web,
  Flutter mobile, Python 3.11/FastAPI AI services, PostgreSQL 16 + PostGIS + pgvector, NATS
  JetStream, Keycloak 26, Kong/Envoy gateway (Node dev gateway), OpenTofu + Helm, Drizzle ORM.
- Keycloak authenticates; `identity-access` authorises. The existing login page is kept by using
  the direct-access grant behind it; UAE PASS arrives as a federated identity provider; MFA is
  required for staff realm roles.
- Tenancy scopes (national, port, zone, facility) and bilingual fields exist from the first
  migration; the `AE` jurisdiction profile is the default seeded world, `IN` is kept for parity
  checks against the reference product.
- Domain 6 of the RFP (Port Facility Statement of Compliance, ISPS, with ICP) is owned by
  `ports`, which also keeps the reference's harbour-operations capability; Domain 7 accreditation
  (six categories, eleven licensed entity types) is owned by `facilities`.
- Agents hold no privileged data path: `ai-tool-gateway` is a network boundary, not a convention.
- The permission catalogue has 66 permissions in 24 groups (the number 85 that appears in one
  inventory is a miscount).

## 3. Environment (cloud container, ephemeral)
- `/home/user/maritime-rebuild/reference/` — read-only reference clone.
- `/home/user/maritime-rebuild/uae-maritime-platform-dev/` — this repository.
- `/home/user/maritime-rebuild/.local/` — nats-server 2.11.8, keycloak-26.3.3, reference demo
  build (`reference-demo/`, the UI parity baseline). `infra/local/runtime.sh start|stop|status`
  runs PostgreSQL (cluster `16/main`, role `maritime`), NATS (JetStream) and Keycloak (:8180).
- Docker runs but image pulls are blocked by the proxy; verify natively here, use compose on a Mac.
- Google Fonts are blocked; fonts are self-hosted in `packages/design-system`.

## 4. State of play
- Plan verified against the RFP and every solution document; repository skeleton not yet pushed
  because the GitHub integration cannot create repositories (403). The user creates the empty
  private repository; then `add_repo` (push) and push `main`.
- Nothing built yet beyond `infra/local/runtime.sh` and the three memory files.

## 5. Open items
1. User to create the GitHub repository (empty, private, no README).
2. Phase 0 foundation build (see the plan §9).
3. Decide whether the analytics portal stays a separate `apps/insights` or folds into the web app.
4. Document reconciliations listed in the plan's appendix D (currency, credits, ownership, totals,
   hosting stack wording) — outside this repository.

### Progress log (latest first)
- AI layer committed: `ai-agents` (:5502, 51 tests) and `ai-assistant` (:5501, 37 tests), databases `maritime_ai_agents` and `maritime_ai_assistant`. The autonomy ladder is enforced by the runtime in one pure function (`services/ai-agents/src/autonomy.ts`): suggest-only → act-with-confirmation → act-within-limits, and an agent escalates rather than acts when it is below its threshold, below the platform floor, outside its rung, over its hourly ceiling, suspended, disabled, or the effect is irreversible — no rung ever applies an irreversible effect. Decisions are append-only (a review writes a superseding row), carry weighted factors, and project as read-model kind `agentDecision`. Drift, bias (across flag, vessel type, age band, class society, service code) and the RFP service levels including the high-risk false-positive rate are computed from reviewer outcomes. The assistant retrieves over a seed-time corpus (legislation, service catalogue, reference data) with a deterministic offline tf-idf embedding, scopes retrieval and every tool call to the asking user's permissions before it reads anything, quotes record content that carries instructions instead of following it, and drafts notices, decision letters and inspection summaries. The completion client is an injected interface: the deterministic local composer is the default everywhere, a model-gateway implementation is selected only by configuration and is never exercised here.
- Foundation green: contracts, service-kit, world (all registers), identity-access, mdm, audit-ledger, notifications, gateway (16 tests), reporting (read models fed by `readmodel.upserted` events, seeded through the same projections). Web: shell + login + command centre + admin + Data Studio + settings + berth board; module pages in progress.
- Operational notes: the sandbox was OOM-killed once when six build agents ran in parallel — keep concurrent builds to three. Native runtime: `infra/local/runtime.sh start`, then `infra/local/services.sh seed && infra/local/services.sh start`.
- Read-model contract: every domain service publishes `readmodel.upserted { kind, entity }` (kinds in `services/reporting/src/consumer.ts`) after each write, plus its business event; reporting/search/cards/dashboards read only their projections.
- LCNC runtime committed (94ff708): rules (:5408, 77 tests), workflow (:5407, 10 tests; consumes `instruments.instrument.issued` to link the number back), documents (:5410, 20 tests, local/S3 storage, signed URLs, ClamAV), scheduler (:5405, 13 tests, eight seeded jobs firing `scheduler.*` events).
- Instruments service committed (1d45ea6, :5409, 9 tests): one lifecycle for every regulated instrument; Ed25519 signature over `licenseNo|entityType|subjectKind|subjectRef|entityName|issueDate|expiryDate|ISSUED` with the key history kept in `signing_keys` (never rotate `CERT_SIGNING_SECRET` once instruments are signed); subject facts projected locally from `readmodel.upserted`; statutory certificates carry survey endorsements and go out of force when a window closes unendorsed; public verification at `/api/public/verify/:no`; consumes `workflow.request.issued` (idempotent per request) and `scheduler.reminders.licences`.
- Web: Harbour Operations and Live Traffic pages ported (port calls, SOF/PDA dialogs, berth planner, quay view, schedule, marine services, fleet utilisation, traffic map) and wired; typecheck + 22 tests green.
- Container restarts (usage-limit pauses) kill background agents: their partial work survives on disk under the repo; check `git status`, finish or relaunch.
- Repository live at github.com/mobiliseapplabllp/uae-maritime-platform-dev (private). Cloud pushes to `main` over HTTPS; local pulls with `./run-local.sh update`, which rebuilds and restarts so each service applies its own new migrations on boot. First local run is `./bootstrap.sh`, which installs prerequisites, creates and seeds the 21 databases and starts everything.
