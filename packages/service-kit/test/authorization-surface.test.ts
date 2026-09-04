import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The platform's authorisation surface, asserted as a whole.
 *
 * `AuthGuard` denies by default for *authentication*: a route with no `@Public()` needs a session. It cannot
 * deny by default for *authorisation*, because a route that legitimately serves any signed-in caller — their
 * own profile, their own notifications — has no permission to name. That leaves a gap a reviewer has to hold
 * open by hand, and a gap held open by hand closes silently the day someone adds a route and forgets.
 *
 * So the gap is written down instead. Every route that carries neither `@RequirePerm`, `@Public` nor
 * `@ServiceOnly` has to appear below with the reason it is there. A new one fails this test, which is the
 * point: the failure is a prompt to decide, not a rule to satisfy.
 */
const ROOT = join(__dirname, '..', '..', '..');
const VERBS = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\s*\(/;

/** Routes reachable by any signed-in caller, each with the reason it needs no permission. */
const SELF_SERVICE_OR_ROW_GUARDED: Record<string, string> = {
  'services/identity-access/src/auth/auth.controller.ts': 'the caller\'s own session: profile, password, sign-out',
  'services/identity-access/src/meta/meta.controller.ts': 'the reference lists every screen needs to render',
  'services/notifications/src/notifications.controller.ts': 'the caller\'s own notifications, filtered by recipient',
  'services/mdm/src/settings.controller.ts': 'per-module display settings; secrets are masked and live behind settings.view',
  'services/documents/src/documents.controller.ts': 'guarded per row instead: audience permission and tenancy, both enforced in the query',
  'services/reporting/src/stats.controller.ts': 'each scope names and checks its own permission inside the handler',
  'services/reporting/src/search.controller.ts': 'each result group checks its own permission and tenancy before it runs',
  'services/reporting/src/cards.controller.ts': 'each card type names its own permission and tenancy policy',
};

/** Routes served with no session at all, each with the reason the public may reach it. */
const PUBLIC: Record<string, string> = {
  'services/instruments/src/public.controller.ts': 'certificate verification and the published signing key — the point of a verifiable instrument',
  'services/documents/src/files.controller.ts': 'signed download links: the HMAC over id and expiry is the credential, compared in constant time',
  'services/mdm/src/settings.controller.ts': 'the jurisdiction profile the sign-in screen renders before anyone has signed in',
  'services/identity-access/src/auth/auth.controller.ts': 'sign-in and token refresh',
  'services/integration-hub/src/hub.controller.ts': 'liveness',
  'services/observability/src/platform.controller.ts': 'liveness',
  'services/scheduler/src/jobs.controller.ts': 'liveness',
};

function controllers(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) controllers(full, out);
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Route { file: string; line: number; decorator: string; guarded: boolean; isPublic: boolean }

/** Every HTTP route in the workspace, with the guard decorators that apply to it. */
function routes(): Route[] {
  const found: Route[] = [];
  for (const file of controllers(join(ROOT, 'services'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    // decorators on the class itself apply to every route in it
    const head = lines.slice(0, lines.findIndex((l) => /^export class /.test(l)) + 1).join('\n');
    const classGuarded = /@RequirePerm\(|@ServiceOnly\(\)/.test(head.split('@Controller')[0] ?? '');
    for (let i = 0; i < lines.length; i++) {
      if (!VERBS.test(lines[i])) continue;
      let guarded = classGuarded; let isPublic = false;
      // the decorator block runs from the verb back a few lines and on to the method signature
      for (let j = Math.max(0, i - 6); j <= Math.min(lines.length - 1, i + 6); j++) {
        if (j !== i && VERBS.test(lines[j])) continue;
        if (/@Public\(\)/.test(lines[j])) isPublic = true;
        if (/@RequirePerm\(|@ServiceOnly\(\)/.test(lines[j])) guarded = true;
        if (j > i && /^\s{2}(async\s+)?[A-Za-z_]\w*\s*\(/.test(lines[j])) break;
      }
      found.push({ file: relative(ROOT, file), line: i + 1, decorator: lines[i].trim(), guarded, isPublic });
    }
  }
  return found;
}

describe('authorization surface', () => {
  const all = routes();

  it('finds the routes to check', () => {
    expect(all.length).toBeGreaterThan(300);
  });

  it('guards every route, or records why it does not', () => {
    const ungoverned = all.filter((r) => !r.guarded && !r.isPublic);
    const undeclared = ungoverned.filter((r) => !(r.file in SELF_SERVICE_OR_ROW_GUARDED));
    expect(
      undeclared.map((r) => `${r.file}:${r.line} ${r.decorator}`),
      'A route reachable by any signed-in caller. Add @RequirePerm, or record the reason in SELF_SERVICE_OR_ROW_GUARDED.',
    ).toEqual([]);
  });

  it('records why every public route is public', () => {
    const undeclared = all.filter((r) => r.isPublic).filter((r) => !(r.file in PUBLIC));
    expect(
      undeclared.map((r) => `${r.file}:${r.line} ${r.decorator}`),
      'A route served with no session at all. Remove @Public(), or record the reason in PUBLIC.',
    ).toEqual([]);
  });

  it('keeps the recorded exceptions honest', () => {
    // an entry left behind after its routes were guarded is a stale licence to leave the next one open
    for (const file of Object.keys(SELF_SERVICE_OR_ROW_GUARDED)) {
      expect(all.some((r) => r.file === file && !r.guarded && !r.isPublic), `${file} no longer has any unguarded route`).toBe(true);
    }
    for (const file of Object.keys(PUBLIC)) {
      expect(all.some((r) => r.file === file && r.isPublic), `${file} no longer has any public route`).toBe(true);
    }
  });

  it('holds the great majority of routes behind an explicit permission', () => {
    const guarded = all.filter((r) => r.guarded && !r.isPublic).length;
    expect(guarded / all.length).toBeGreaterThan(0.85);
  });
});
