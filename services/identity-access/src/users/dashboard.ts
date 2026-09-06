/* The administration dashboard: the access posture of the platform, read from the accounts, their sessions, the four-eyes
 * queue and the access review in progress.
 *
 * The yardsticks are the ones identity governance programmes report: second-factor coverage of the accounts a policy
 * requires it of, dormant accounts against a ninety-day rule, privileged accounts and whether each carries a second
 * factor, and how far the open access review has got against its due date. Nothing here is sampled — every account counts. */
type Instant = Date | string | number | null | undefined;
export interface DashUser {
  id: string; name: string; email: string; roleName: string; permissions: string[]; roleMfaRequired: boolean; roleSystem: boolean; active: boolean; department: string;
  createdAt: Instant; lastLoginAt: Instant; mfaEnrolledAt: Instant; mfaDueAt: Instant; dormantSince: Instant;
}
export interface DashSession { userId: string; expiresAt: Instant; revokedAt: Instant; lastUsedAt: Instant }
export interface DashLock { identity: string; failures: number; firstFailureAt: Instant; lockedUntil: Instant }
export interface DashChange { kind: string; status: string; requestedAt: Instant; decidedAt: Instant }
export interface DashReview { id: string; openedAt: Instant; dueAt: Instant; closedAt: Instant; total: number; items: { decision: string; privileged: boolean }[] }
export interface AdminInput { users: DashUser[]; sessions: DashSession[]; locks: DashLock[]; changes: DashChange[]; review: DashReview | null }
export interface AdminPolicy { dormantDays: number }
/** The permissions that make an account privileged: it can change who may do what, or what the platform does. */
export const PRIVILEGED_PERMS = ['*', 'users.manage', 'roles.manage', 'settings.manage', 'agents.configure', 'models.deploy'] as const;

const D = 86_400_000;
const ms = (d: Instant) => (d == null || d === '' ? NaN : new Date(d).getTime());
const has = (d: Instant) => !Number.isNaN(ms(d));
const iso = (d: Instant) => (has(d) ? new Date(ms(d)).toISOString() : null);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
export const isPrivilegedPerms = (perms: string[]) => perms.some((p) => (PRIVILEGED_PERMS as readonly string[]).includes(p));

export function adminDashboard(input: AdminInput, now = new Date(), policy: AdminPolicy = { dormantDays: 90 }) {
  const t = now.getTime(); const d30 = t - 30 * D; const d7 = t - 7 * D; const d1 = t - D; const dormantBefore = t - policy.dormantDays * D;
  const { users, sessions, locks, changes, review } = input;
  const active = users.filter((u) => u.active);
  const enrolled = (u: DashUser) => has(u.mfaEnrolledAt);
  const dormant = (u: DashUser) => u.active && (has(u.dormantSince) || (has(u.lastLoginAt) ? ms(u.lastLoginAt) < dormantBefore : has(u.createdAt) && ms(u.createdAt) < dormantBefore));
  const privileged = (u: DashUser) => u.active && isPrivilegedPerms(u.permissions ?? []);
  const mfaRequired = active.filter((u) => u.roleMfaRequired);
  const mfaEnrolled = mfaRequired.filter(enrolled);
  const dormantUsers = active.filter(dormant);
  const privilegedUsers = active.filter(privileged);
  const liveSessions = sessions.filter((s) => !has(s.revokedAt) && has(s.expiresAt) && ms(s.expiresAt) > t);
  const locked = locks.filter((l) => has(l.lockedUntil) && ms(l.lockedUntil) > t);
  const pending = changes.filter((c) => c.status === 'PENDING');
  const decided30 = changes.filter((c) => c.status !== 'PENDING' && has(c.decidedAt) && ms(c.decidedAt) >= d30);
  const openReview = review && !has(review.closedAt) ? review : null;
  const reviewDecided = openReview ? openReview.items.filter((i) => i.decision !== 'PENDING').length : 0;
  const reviewProgress = openReview ? pct(reviewDecided, openReview.items.length || openReview.total) : null;
  const groupBy = <T extends string>(list: DashUser[], key: (u: DashUser) => T) => { const m = new Map<T, DashUser[]>(); for (const u of list) { const k = key(u); const l = m.get(k); if (l) l.push(u); else m.set(k, [u]); } return m; };
  const byRole = [...groupBy(users, (u) => u.roleName || '—')].map(([role, list]) => ({
    role, users: list.length, active: list.filter((u) => u.active).length, mfaRequired: list[0]?.roleMfaRequired ?? false, mfaEnrolled: list.filter((u) => u.active && enrolled(u)).length,
    privileged: list.filter(privileged).length, dormant: list.filter(dormant).length, system: list[0]?.roleSystem ?? false,
  })).sort((a, b) => b.users - a.users || a.role.localeCompare(b.role));
  const byDepartment = [...groupBy(active, (u) => u.department || '—')].map(([department, list]) => ({ department, users: list.length })).sort((a, b) => b.users - a.users || a.department.localeCompare(b.department)).slice(0, 10);
  const daysSince = (d: Instant) => (has(d) ? Math.floor((t - ms(d)) / D) : null);
  const kindMap = new Map<string, { kind: string; pending: number; approved: number; rejected: number; cancelled: number }>();
  for (const c of changes) { const acc = kindMap.get(c.kind) ?? { kind: c.kind, pending: 0, approved: 0, rejected: 0, cancelled: 0 }; const k = c.status.toLowerCase() as 'pending' | 'approved' | 'rejected' | 'cancelled'; if (k in acc) acc[k] += 1; kindMap.set(c.kind, acc); }
  const coverage = pct(mfaEnrolled.length, mfaRequired.length);
  const privilegedMfa = pct(privilegedUsers.filter(enrolled).length, privilegedUsers.length);
  // one number for the posture: second factors where required, privileged accounts covered, few dormant accounts, the review moving
  const posture = Math.round(coverage * 0.4 + (privilegedUsers.length ? privilegedMfa : 100) * 0.25 + (100 - pct(dormantUsers.length, active.length)) * 0.2 + (openReview ? reviewProgress ?? 0 : 100) * 0.15);
  return {
    kpis: {
      users: users.length, active: active.length, inactive: users.length - active.length, newUsers30d: users.filter((u) => has(u.createdAt) && ms(u.createdAt) >= d30).length,
      mfaRequired: mfaRequired.length, mfaEnrolled: mfaEnrolled.length, mfaCoveragePct: coverage, mfaOverdue: mfaRequired.filter((u) => !enrolled(u) && has(u.mfaDueAt) && ms(u.mfaDueAt) < t).length,
      dormant: dormantUsers.length, dormantDays: policy.dormantDays, privileged: privilegedUsers.length, privilegedWithoutMfa: privilegedUsers.filter((u) => !enrolled(u)).length, privilegedMfaPct: privilegedMfa,
      loggedIn24h: users.filter((u) => has(u.lastLoginAt) && ms(u.lastLoginAt) >= d1).length, loggedIn7d: users.filter((u) => has(u.lastLoginAt) && ms(u.lastLoginAt) >= d7).length,
      activeSessions: liveSessions.length, sessionUsers: new Set(liveSessions.map((s) => s.userId)).size, sessionsUsed24h: liveSessions.filter((s) => has(s.lastUsedAt) && ms(s.lastUsedAt) >= d1).length,
      lockedAccounts: locked.length, failedLogins24h: locks.filter((l) => has(l.firstFailureAt) && ms(l.firstFailureAt) >= d1).reduce((s, l) => s + (Number(l.failures) || 0), 0),
      changesPending: pending.length, changesDecided30d: decided30.length, changesApproved30d: decided30.filter((c) => c.status === 'APPROVED').length, changesRejected30d: decided30.filter((c) => c.status === 'REJECTED').length,
      postureScore: posture,
    },
    review: openReview ? {
      id: openReview.id, openedAt: iso(openReview.openedAt), dueAt: iso(openReview.dueAt), total: openReview.items.length || openReview.total, decided: reviewDecided,
      confirmed: openReview.items.filter((i) => i.decision === 'CONFIRMED').length, revoked: openReview.items.filter((i) => i.decision === 'REVOKED').length,
      pendingPrivileged: openReview.items.filter((i) => i.decision === 'PENDING' && i.privileged).length, progressPct: reviewProgress,
      daysLeft: has(openReview.dueAt) ? Math.ceil((ms(openReview.dueAt) - t) / D) : null, overdue: has(openReview.dueAt) && ms(openReview.dueAt) < t,
    } : null,
    byRole, byDepartment, changesByKind: [...kindMap.values()].sort((a, b) => a.kind.localeCompare(b.kind)),
    dormantList: dormantUsers.map((u) => ({ id: u.id, name: u.name, roleName: u.roleName, department: u.department, lastLoginAt: iso(u.lastLoginAt), days: daysSince(u.lastLoginAt ?? u.createdAt) })).sort((a, b) => (b.days ?? 0) - (a.days ?? 0)).slice(0, 10),
    privilegedList: privilegedUsers.map((u) => ({ id: u.id, name: u.name, roleName: u.roleName, mfaEnrolled: enrolled(u), lastLoginAt: iso(u.lastLoginAt) })).sort((a, b) => Number(a.mfaEnrolled) - Number(b.mfaEnrolled) || a.name.localeCompare(b.name)).slice(0, 12),
    generatedAt: now.toISOString(),
  };
}
export type AdminDashboard = ReturnType<typeof adminDashboard>;
