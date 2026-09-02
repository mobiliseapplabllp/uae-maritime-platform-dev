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
- Foundation green: contracts, service-kit, world (all registers), identity-access, mdm, audit-ledger, notifications, gateway (16 tests), reporting (read models fed by `readmodel.upserted` events, seeded through the same projections). Web: shell + login + command centre + admin + Data Studio + settings + berth board; module pages in progress.
- Operational notes: the sandbox was OOM-killed once when six build agents ran in parallel — keep concurrent builds to three. Native runtime: `infra/local/runtime.sh start`, then `infra/local/services.sh seed && infra/local/services.sh start`.
- Read-model contract: every domain service publishes `readmodel.upserted { kind, entity }` (kinds in `services/reporting/src/consumer.ts`) after each write, plus its business event; reporting/search/cards/dashboards read only their projections.
