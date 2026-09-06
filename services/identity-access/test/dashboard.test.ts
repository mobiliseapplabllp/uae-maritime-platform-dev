import { describe, expect, it } from 'vitest';
import { adminDashboard, isPrivilegedPerms, type AdminInput, type DashUser } from '../src/users/dashboard';

/* Eight fictional accounts across four roles, arranged so that coverage, dormancy, privilege and the review each have
 * a worked answer. */
const NOW = new Date('2026-09-06T12:00:00Z'); const t = NOW.getTime(); const D = 86_400_000;
const ago = (days: number) => new Date(t - days * D).toISOString();
const user = (o: Partial<DashUser> & { id: string; roleName: string }): DashUser => ({ name: o.id, email: `${o.id}@maritime.example`, permissions: [], roleMfaRequired: true, roleSystem: false, active: true, department: 'Operations', createdAt: ago(400), lastLoginAt: ago(1), mfaEnrolledAt: null, mfaDueAt: null, dormantSince: null, ...o });
const input: AdminInput = {
  users: [
    user({ id: 'admin', roleName: 'Super Admin', permissions: ['*'], roleSystem: true, mfaEnrolledAt: ago(100), lastLoginAt: ago(0.2) }),
    user({ id: 'idadmin', roleName: 'Identity Administrator', permissions: ['users.manage', 'roles.view'], roleSystem: true, lastLoginAt: ago(3) }), // privileged, no second factor
    user({ id: 'hm1', roleName: 'Harbour Master', permissions: ['portcalls.view'], mfaEnrolledAt: ago(50) }),
    user({ id: 'hm2', roleName: 'Harbour Master', permissions: ['portcalls.view'], lastLoginAt: ago(120) }), // dormant by the ninety-day rule
    user({ id: 'hm3', roleName: 'Harbour Master', permissions: ['portcalls.view'], mfaDueAt: ago(2) }), // enrolment overdue
    user({ id: 'viewer', roleName: 'Management Viewer', permissions: ['dashboard.view'], roleMfaRequired: false, lastLoginAt: null, createdAt: ago(200), department: 'Management' }), // never logged in, old account: dormant
    user({ id: 'new', roleName: 'Management Viewer', permissions: ['dashboard.view'], roleMfaRequired: false, createdAt: ago(5), lastLoginAt: ago(5), department: 'Management' }),
    user({ id: 'gone', roleName: 'Harbour Master', permissions: ['portcalls.view'], active: false, lastLoginAt: ago(300) }),
  ],
  sessions: [
    { userId: 'admin', expiresAt: ago(-1), revokedAt: null, lastUsedAt: ago(0.1) }, { userId: 'admin', expiresAt: ago(-1), revokedAt: null, lastUsedAt: ago(3) },
    { userId: 'hm1', expiresAt: ago(-1), revokedAt: ago(0.5), lastUsedAt: ago(0.5) }, { userId: 'hm3', expiresAt: ago(1), revokedAt: null, lastUsedAt: ago(1) },
  ],
  locks: [{ identity: 'hm2@maritime.example', failures: 5, firstFailureAt: ago(0.3), lockedUntil: ago(-0.01) }, { identity: 'x@maritime.example', failures: 2, firstFailureAt: ago(3), lockedUntil: null }],
  changes: [
    { kind: 'USER_ROLE', status: 'PENDING', requestedAt: ago(1), decidedAt: null }, { kind: 'USER_ROLE', status: 'APPROVED', requestedAt: ago(2), decidedAt: ago(1) },
    { kind: 'USER_ROLE', status: 'REJECTED', requestedAt: ago(10), decidedAt: ago(9) }, { kind: 'ROLE_MATRIX', status: 'APPROVED', requestedAt: ago(60), decidedAt: ago(59) },
  ],
  review: { id: 'cycle-1', openedAt: ago(1), dueAt: ago(-13), closedAt: null, total: 7, items: [{ decision: 'CONFIRMED', privileged: true }, { decision: 'PENDING', privileged: true }, { decision: 'REVOKED', privileged: false }, { decision: 'PENDING', privileged: false }] },
};

describe('administration dashboard', () => {
  const d = adminDashboard(input, NOW, { dormantDays: 90 });
  it('measures second-factor coverage where the policy requires it', () => {
    expect(d.kpis.users).toBe(8); expect(d.kpis.active).toBe(7); expect(d.kpis.inactive).toBe(1); expect(d.kpis.newUsers30d).toBe(1);
    expect(d.kpis.mfaRequired).toBe(5); expect(d.kpis.mfaEnrolled).toBe(2); expect(d.kpis.mfaCoveragePct).toBe(40); expect(d.kpis.mfaOverdue).toBe(1);
  });
  it('finds the dormant and the privileged accounts', () => {
    expect(d.kpis.dormant).toBe(2); expect(d.dormantList.map((u) => u.id)).toEqual(['viewer', 'hm2']);
    expect(d.kpis.privileged).toBe(2); expect(d.kpis.privilegedWithoutMfa).toBe(1); expect(d.kpis.privilegedMfaPct).toBe(50);
    expect(d.privilegedList[0]).toMatchObject({ id: 'idadmin', mfaEnrolled: false });
    expect(isPrivilegedPerms(['settings.manage'])).toBe(true); expect(isPrivilegedPerms(['portcalls.view'])).toBe(false);
  });
  it('counts sessions, lockouts and the four-eyes queue', () => {
    expect(d.kpis.activeSessions).toBe(2); expect(d.kpis.sessionUsers).toBe(1); expect(d.kpis.sessionsUsed24h).toBe(1); // one revoked, one expired
    expect(d.kpis.lockedAccounts).toBe(1); expect(d.kpis.failedLogins24h).toBe(5);
    expect(d.kpis.loggedIn24h).toBe(3); expect(d.kpis.loggedIn7d).toBe(5); // a login exactly a day ago still counts
    expect(d.kpis.changesPending).toBe(1); expect(d.kpis.changesDecided30d).toBe(2); expect(d.kpis.changesApproved30d).toBe(1); expect(d.kpis.changesRejected30d).toBe(1);
    expect(d.changesByKind).toEqual([{ kind: 'ROLE_MATRIX', pending: 0, approved: 1, rejected: 0, cancelled: 0 }, { kind: 'USER_ROLE', pending: 1, approved: 1, rejected: 1, cancelled: 0 }]);
  });
  it('follows the open access review against its due date', () => {
    expect(d.review).toMatchObject({ id: 'cycle-1', total: 4, decided: 2, confirmed: 1, revoked: 1, pendingPrivileged: 1, progressPct: 50, daysLeft: 13, overdue: false });
    expect(d.byRole[0]).toMatchObject({ role: 'Harbour Master', users: 4, active: 3, mfaEnrolled: 1, dormant: 1 });
    expect(d.byDepartment).toEqual([{ department: 'Operations', users: 5 }, { department: 'Management', users: 2 }]);
    // 40% coverage, half the privileged covered, two of seven dormant, the review half done
    expect(d.kpis.postureScore).toBe(Math.round(40 * 0.4 + 50 * 0.25 + (100 - 29) * 0.2 + 50 * 0.15));
  });
  it('stands on an empty directory', () => {
    const e = adminDashboard({ users: [], sessions: [], locks: [], changes: [], review: null }, NOW);
    expect(e.kpis.mfaCoveragePct).toBe(0); expect(e.review).toBeNull(); expect(e.kpis.postureScore).toBe(Math.round(0 + 25 + 20 + 15));
  });
});
