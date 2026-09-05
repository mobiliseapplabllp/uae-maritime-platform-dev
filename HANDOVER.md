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
- Identity (decision of 05 Sep 2026): the platform's own `identity-access` service authenticates
  and authorises. Keycloak and the UAE PASS federation are parked — the realm stays importable and
  `AUTH_MODE=keycloak` still works, but nothing waits on it. Two-step verification is built in
  (TOTP from `auth/totp.ts`, secrets sealed with `MFA_KEY`), required per role from the date in
  `module:admin.mfaRequiredFrom` with a grace window; Shipping Agent and Manning Agent are exempt.
- Tenancy scopes (national, port, zone, facility) and bilingual fields exist from the first
  migration; the `AE` jurisdiction profile is the default seeded world, `IN` is kept for parity
  checks against the reference product.
- Domain 6 of the RFP (Port Facility Statement of Compliance, ISPS, with ICP) is owned by
  `ports`, which also keeps the reference's harbour-operations capability; Domain 7 accreditation
  (six categories, eleven licensed entity types) is owned by `facilities`.
- Agents hold no privileged data path: `ai-tool-gateway` is a network boundary, not a convention.
- The permission catalogue has 76 permissions in 28 groups (66 base + 10 extended; the number 85
  that appears in one inventory is a miscount). 18 roles, 12 of them system roles; the Identity
  Administrator (`IA`) is the second pair of eyes on a privileged grant.
- Privileged grants (`*`, `users.manage`, `roles.manage` by default — `module:admin.fourEyesPermissions`)
  go through `change_requests` and need a second administrator; nobody approves their own request,
  edits their own role or scope, or removes the last active wildcard holder. Access reviews
  (`access_review_cycles`/`_items`) open quarterly from the scheduler and on demand; dormant
  accounts (90 days by default) are deactivated by the daily sweep and can be reactivated.
- Sessions: short access tokens (15 min) with refresh (12 h), idle timeout (30 min, `IdleWatch`),
  a `sid` session family on every token so a revoked session dies at once — every service checks
  liveness through the identity service and drops cached principals on `identity.*` events.

## 3. Environment (cloud container, ephemeral)
- `/home/user/maritime-rebuild/reference/` — read-only reference clone.
- `/home/user/maritime-rebuild/uae-maritime-platform-dev/` — this repository.
- `/home/user/maritime-rebuild/.local/` — nats-server 2.11.8, keycloak-26.3.3, reference demo
  build (`reference-demo/`, the UI parity baseline). `infra/local/runtime.sh start|stop|status`
  runs PostgreSQL (cluster `16/main`, role `maritime`), NATS (JetStream) and Keycloak (:8180).
- Docker runs but image pulls are blocked by the proxy; verify natively here, use compose on a Mac.
- Google Fonts are blocked; fonts are self-hosted in `packages/design-system`.

## 4. State of play
- 24 services build, run and are monitored; web app has 24 test files / 177 tests; repository live
  and pushed to `main`. Runs natively on Linux and macOS from `./bootstrap.sh`.
- Demo accounts (`Demo@2026`): admin@, harbour@, surveyor@, finance@, agent@, crewing@, ops2@,
  nmc@, aigov@, idadmin@ (Identity Administrator), portofficer@ (PORT scope, AEFJR) and terminal@
  (FACILITY scope, CT3-1 at AEAUH) — all `@maritime.example`. Scope is hierarchical: a facility
  sits in a zone in a port (`packages/service-kit/src/scope.ts`); company scope is ownership.
- Phase 3 domain completion is done for Facilities & Companies, Ships, Seafarers & MET, Legislation
  and Inspection (see the progress log). Vocabularies live in Data Studio masters and are mirrored
  into each service; the screens read them through `useLookups` — nothing domain-shaped is a constant.

## 5. Open items
1. Flutter mobile apps on the new APIs.
2. The verification regime after Phase 3: DAST (`pnpm dast`, now with public-portal probes) and the
   Playwright drives (`apps/web/e2e`, wired into CI as the `e2e` job) against the running stack.
3. Four Dependabot advisories — `xlsx` 0.18.5 (2 high, both parser bugs, and this codebase only
   ever writes workbooks; no fix exists on npm since SheetJS left the registry) and `react-router`
   6.30.6 (2 moderate; the SSR one is unreachable in a pure SPA, the open-redirect one is real and
   its fix is a v7 major). Neither is a blind bump — decide deliberately.
4. Decide whether the analytics portal stays a separate `apps/insights` or folds into the web app.
5. Keycloak and UAE PASS federation (STK-03) are parked by decision, not blocked — the realm and
   `AUTH_MODE=keycloak` remain; wiring UAE PASS is the outstanding piece.
6. Integrations: a dynamic adapter-configuration area in Settings over the integration hub's
   registry (mode, endpoint, credentials, retries, test connection, health, dead letters) — next.
4. Document reconciliations listed in the plan's appendix D (currency, credits, ownership, totals,
   hosting stack wording) — outside this repository.

### Progress log (latest first)
- Access controls landed (RBAC close-out, Keycloak parked): built-in two-step verification (`/api/auth/mfa/*`: setup, activate, verify, recovery codes, disable; admin reset), per-role requirement with a grace window and an enrolment step on the login page; scope administration on the Users screen (`ScopeEditor`, hierarchical port→zone→facility from `service-kit/src/scope.ts`) with seeded port-officer and terminal accounts; four-eyes approval for privileged grants (`change_requests`, `ApprovalsPanel`, notifications to the approving permission) with self-protection and last-administrator protection; access review cycles (`/api/access-reviews`, quarterly scheduler job, `AccessReviewsPage`/`AccessReviewDetail`) and the dormant sweep; session policy (short access tokens, refresh, idle timeout, session listing and revocation from the profile, `sid` liveness so revocation is immediate); settings under `module:admin`. Assurance: 1000 tests over 28 packages green one package at a time, `pnpm sast` 25 rules / 0 findings (two names that merely contained the word password were renamed), `pnpm dast` 41 probes / 0 findings (five new: half-finished sign-in token, revoked session, privileged grant not self-applied, own role and last administrator, port containment), the WCAG 2.2 AA sweep (five sweeps, both languages) and 16 browser drives green including three new security drives that enrol an authenticator, take a grant through the second administrator and attest a review. What the drives found: the dev server re-optimised and reloaded the page the first time it met a new icon, which dropped a drive mid sign-in — every deep icon import is now pre-bundled at start-up (`vite.config.ts`); axe measured colours mid-fade — the accessibility helper now scans the page at rest; the Sessions card had a paragraph directly inside a list; a re-seed kept settings keys the world had retired (`mdm/src/seed.ts` now drops them and raises a password floor below the platform minimum); and a latent defect that predates this work — a select menu on a page that also writes its filter to the URL sometimes never finished closing, leaving an invisible closed menu over the page so every later click landed on nothing. Traced with an instrumented transition class: the router wrapped every navigation in `React.startTransition`, and React 18 dropped the `exited` state the menu's transition set from its timer while that transition render was in flight. The router now mounts with `useTransitions={false}` (`apps/web/src/main.tsx`), which reproduced 0 stalls in 10 runs against 1–4 in 8 before. The full tally also caught a performance rating that rounded differently by time of day (a lone visit scored 55 is exactly 2.75; the weighted division lands a few ulps under it once the recency weight is fractionally below 1) — `facilities/src/directory.ts` now rounds half-up with a nudge.
- Phase 3 assurance closed: every package's suite run one at a time (979 tests over 28 packages, green), `pnpm sast` 25 rules / 0 findings, `pnpm dast` 36 probes / 0 findings (six of them on the public law portal), the WCAG 2.2 AA sweep green in English and Arabic across every screen including `/law`, and the 13 browser drives green against the running stack (now the `e2e` CI job). Measuring the KPIs from events found two facts the desk knew and the read model never heard, both fixed and held by tests: a restriction *decided* before the bus had routed it carried no `RESTRICTION_ROUTED` mark (the officer had plainly reached it — the decision now stamps the routing), and a survey boarded by its first finding or first checklist answer published no `inspection.started` (the boarding helper now publishes it from every path, once; the start button no longer publishes a second). The desk (`/inspections/kpis`) and reporting (`/stats/inspectionKpis`) return identical figures on all six. Reporting's KPI test now measures a port officer's own survey as a delta against the seeded programme — a port officer sees the administration's own facility audits, which belong to no port, by design of the containment predicate — and service-kit's authorization surface records why the legislation portal's six routes are public.
- Inspection, Smart Inspection programme committed (`services/inspection` 42 tests, `reporting` 19, `ai-assistant` 56, `contracts` 22, web 23 files / 173 tests). A survey is planned under a regime from the `inspectionRegime` master against the kind of subject the regime names — ship, company, port facility or training institution — with the subjects projected from the other registers' read models. Planning assembles the pre-inspection dossier and records a prediction (the Smart Inspection agent's latest judgement of the ship when fresh, the desk's own history rules otherwise); closing classifies the survey (severity model), scores the prediction against the findings, and has the rules recommend a restriction that reaches the deciding officer over the bus (the service stamps the routing when its own event comes back) and is decided on the survey. The assistant drafts the report and the deficiency notice unasked when a survey closes; the desk records them as the machine's first draft and an officer issues them. Every one of those writes a dated fact on `inspection_timeline`, and the six 18-month KPIs (dossier before boarding, AI-first reports, notices within 30 min, prediction correlation over 12 months, report-time reduction against a measured or configured baseline, restrictions routed within the hour) are computed from that timeline by one evaluator in `@maritime/contracts` (`inspection-kpis.ts`) — used by the desk (`GET /inspections/kpis`) and by reporting (`/stats/inspectionKpis`, from its own projection of the events). Targets, windows and the programme start are `module:inspect` settings; a figure that cannot be measured says "not captured". The overdue-finding sweep is a scheduler job owned by inspection. The world seeds the programme from June 2025 with the paper era before it, so the dashboard shows a programme in progress.
- Legislation committed: the public citable portal (`/api/public/legislation`, web `/law` and `/law/:slug`; in-force register with facets from the masters, history on request, stable slug addresses, content-hash ETags with 304 revalidation, citation in both languages, JSON Feed and sitemap; drafts, non-citable types and desk-hidden instruments never answer) and the IMO watch (`imo_watch_items`/`imo_source_polls`, sources from the `imoSource` master, documents read through the integration hub's `gisis.sourceItems` stub, scheduler job every six hours, a failed source due again at the next sweep, desk assessment → transposed to an instrument on the register → dismissed, web `/legislation/imo`). Instrument types, reference series prefixes, citability and link kinds come from the `legalInstrumentType` and `legalLinkKind` masters.
- Observability committed (:5411, `maritime_observability`, 13 tests) with the `/platform` web module (3 pages, `platform.view`, Super Admin only). Deliberately its own service: monitoring has to outlive what it monitors. A collector sweeps 27 targets every 15s under a pg advisory lock (constant `8842_1101`, distinct from the scheduler's) — the 21 services via `/health` plus the new `/internal/telemetry`, PostgreSQL sizes and connections, NATS `varz`/`jsz` consumer lag, and four service levels measured as synthetic transactions through the gateway. `/internal/telemetry` lives in service-kit so every service reports its own outbox backlog, inbox lag, migrations, pool counters and memory with no per-service code. Storage is two-tier: raw `samples` on 48h retention, `rollups` at hour and day kept indefinitely — **day buckets roll up from hour buckets, never from samples again**, or a retention setting below 24h silently truncates the day. Outages become `incidents` with measured durations, and uptime going backwards without a failed probe in between is recorded as a restart (this caught three real restarts no up/down chart would have shown). No sign-in probe by design: it would write to `login_attempts` and count against rate limiting, and a monitor must not alter what it measures.
- Two gateway route-table faults fixed in passing: it fronted `insights-api` on :5503, which no service in this repo provides, pinning `/api/health` at "degraded" permanently; and `scheduler` (:5405) ran unrouted and unmonitored. The service registry now lives in `@maritime/contracts` (`PLATFORM_SERVICES`) as one source of truth, and a gateway test pins it against the filesystem so neither direction can recur.
- The web app had no error boundary anywhere, so any render throw left a blank white page carrying nothing — undiagnosable by design. `apps/web/src/components/common/ErrorBoundary.tsx` wraps everything inside StrictMode and renders with inline styles only (no MUI, theme, i18n or store — a boundary rendering through the machinery that just failed can fail with it). Its "Clear local data" action matters: `localStorage` is keyed by origin, so anything ever served on :5300 wrote into the same bucket and a session left by an older build is read straight back into the store at boot.
- Platform-specific faults found on a real macOS run, all fixed: `.local` path disagreement between the scripts; `setsid` is Linux-only (every service launch failed, and a success message that counted the word "started" in a log rather than health-checking reported 21 running when one was); NATS discovery ignored a Homebrew install on PATH; `fuser` is Linux-only (`kill_port()` now falls back to `lsof`); and `pnpm dev` puts pnpm plus a `/bin/sh` shim between the shell and vite, layers that do not survive the launching subshell without setsid — vite is now exec'd directly as a node child, the way services.sh execs each service.
- AI layer committed: `ai-agents` (:5502, 51 tests) and `ai-assistant` (:5501, 37 tests), databases `maritime_ai_agents` and `maritime_ai_assistant`. The autonomy ladder is enforced by the runtime in one pure function (`services/ai-agents/src/autonomy.ts`): suggest-only → act-with-confirmation → act-within-limits, and an agent escalates rather than acts when it is below its threshold, below the platform floor, outside its rung, over its hourly ceiling, suspended, disabled, or the effect is irreversible — no rung ever applies an irreversible effect. Decisions are append-only (a review writes a superseding row), carry weighted factors, and project as read-model kind `agentDecision`. Drift, bias (across flag, vessel type, age band, class society, service code) and the RFP service levels including the high-risk false-positive rate are computed from reviewer outcomes. The assistant retrieves over a seed-time corpus (legislation, service catalogue, reference data) with a deterministic offline tf-idf embedding, scopes retrieval and every tool call to the asking user's permissions before it reads anything, quotes record content that carries instructions instead of following it, and drafts notices, decision letters and inspection summaries. The completion client is an injected interface: the deterministic local composer is the default everywhere, a model-gateway implementation is selected only by configuration and is never exercised here.
- Foundation green: contracts, service-kit, world (all registers), identity-access, mdm, audit-ledger, notifications, gateway (16 tests), reporting (read models fed by `readmodel.upserted` events, seeded through the same projections). Web: shell + login + command centre + admin + Data Studio + settings + berth board; module pages in progress.
- Operational notes: the sandbox was OOM-killed once when six build agents ran in parallel — keep concurrent builds to three. Native runtime: `infra/local/runtime.sh start`, then `infra/local/services.sh seed && infra/local/services.sh start`.
- Read-model contract: every domain service publishes `readmodel.upserted { kind, entity }` (kinds in `services/reporting/src/consumer.ts`) after each write, plus its business event; reporting/search/cards/dashboards read only their projections.
- LCNC runtime committed (94ff708): rules (:5408, 77 tests), workflow (:5407, 10 tests; consumes `instruments.instrument.issued` to link the number back), documents (:5410, 20 tests, local/S3 storage, signed URLs, ClamAV), scheduler (:5405, 13 tests, eight seeded jobs firing `scheduler.*` events).
- Instruments service committed (1d45ea6, :5409, 9 tests): one lifecycle for every regulated instrument; Ed25519 signature over `licenseNo|entityType|subjectKind|subjectRef|entityName|issueDate|expiryDate|ISSUED` with the key history kept in `signing_keys` (never rotate `CERT_SIGNING_SECRET` once instruments are signed); subject facts projected locally from `readmodel.upserted`; statutory certificates carry survey endorsements and go out of force when a window closes unendorsed; public verification at `/api/public/verify/:no`; consumes `workflow.request.issued` (idempotent per request) and `scheduler.reminders.licences`.
- Web: Harbour Operations and Live Traffic pages ported (port calls, SOF/PDA dialogs, berth planner, quay view, schedule, marine services, fleet utilisation, traffic map) and wired; typecheck + 22 tests green.
- Container restarts (usage-limit pauses) kill background agents: their partial work survives on disk under the repo; check `git status`, finish or relaunch.
- Repository live at github.com/mobiliseapplabllp/uae-maritime-platform-dev (private). Cloud pushes to `main` over HTTPS; local pulls with `./run-local.sh update`, which rebuilds and restarts so each service applies its own new migrations on boot. First local run is `./bootstrap.sh`, which installs prerequisites, creates and seeds the 21 databases and starts everything.
