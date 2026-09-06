import { useTranslation } from 'react-i18next';
import { Grid, Stack, Typography } from '@mui/material';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';
import LoginRoundedIcon from '@mui/icons-material/LoginRounded';
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import HowToVoteRoundedIcon from '@mui/icons-material/HowToVoteRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import PersonAddRoundedIcon from '@mui/icons-material/PersonAddRounded';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, BarChart } from 'recharts';
import { useAppSelector } from '../../store';
import { CHART_SERIES, chartChrome } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import AiInsights from '../../components/ai/AiInsights';
import StatCard from '../../components/common/StatCard';
import { BucketBars, ChartCard, DashboardSkeleton, OpenLink, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { fmtD, fmtNum, fromNow } from '../../utils/format';

/* Administration dashboard — the access posture: second-factor coverage, dormant and privileged accounts, sessions and
 * lockouts, the four-eyes queue, the review in progress and the audit ledger's last fortnight. GET /users/dashboard and GET /audit/summary. */
export interface AdminData {
  kpis: { users: number; active: number; inactive: number; newUsers30d: number; mfaRequired: number; mfaEnrolled: number; mfaCoveragePct: number; mfaOverdue: number; dormant: number; dormantDays: number; privileged: number; privilegedWithoutMfa: number; privilegedMfaPct: number; loggedIn24h: number; loggedIn7d: number; activeSessions: number; sessionUsers: number; sessionsUsed24h: number; lockedAccounts: number; failedLogins24h: number; changesPending: number; changesDecided30d: number; changesApproved30d: number; changesRejected30d: number; postureScore: number };
  review: { id: string; openedAt: string | null; dueAt: string | null; total: number; decided: number; confirmed: number; revoked: number; pendingPrivileged: number; progressPct: number | null; daysLeft: number | null; overdue: boolean } | null;
  byRole: { role: string; users: number; active: number; mfaRequired: boolean; mfaEnrolled: number; privileged: number; dormant: number; system: boolean }[];
  byDepartment: { department: string; users: number }[];
  changesByKind: { kind: string; pending: number; approved: number; rejected: number; cancelled: number }[];
  dormantList: { id: string; name: string; roleName: string; department: string; lastLoginAt: string | null; days: number | null }[];
  privilegedList: { id: string; name: string; roleName: string; mfaEnrolled: boolean; lastLoginAt: string | null }[];
  generatedAt: string;
}
export interface AuditSummary { total: number; byAction: { action: string; count: number }[]; byDay: { day: string; events: number; logins: number; actors: number }[]; byService: { service: string; count: number }[]; last24h: number; last7d: number; activeActors7d: number }
const label = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function AdminDashboard() {
  const { t } = useTranslation();
  const { data } = useDashboard<AdminData>('/users/dashboard');
  const { data: audit } = useDashboard<AuditSummary>('/audit/summary');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const header = <PageHeader icon={AdminPanelSettingsRoundedIcon} iconColor="#0A2239" title={t('dash.admin.title', 'Administration')} sub={t('dash.admin.sub', { defaultValue: 'The access posture of the platform — accounts, second factors, sessions, approvals and the audit ledger at {{date}}', date: fmtD(new Date()) })}
    actions={<Stack direction="row" spacing={1} flexWrap="wrap"><OpenLink label={t('dash.admin.openUsers', 'Users')} to="/admin/users" /><OpenLink label={t('dash.admin.openRoles', 'Roles')} to="/admin/roles" /><OpenLink label={t('dash.admin.openReviews', 'Access reviews')} to="/admin/access-reviews" /><OpenLink label={t('dash.admin.openAudit', 'Audit log')} to="/admin/audit" /></Stack>} />;
  if (!data) return <>{header}<DashboardSkeleton /></>;
  const { kpis: k, review } = data;
  const dormantPct = k.active ? Math.round((k.dormant / k.active) * 100) : 0;
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="admin-dashboard">
        <Grid item xs={6} md={3}><StatCard icon={<GroupRoundedIcon />} label={t('dash.admin.activeUsers', 'Active accounts')} value={k.active} sub={`${k.inactive} ${t('dash.admin.inactive', 'deactivated')} · ${k.users} ${t('dash.admin.inAll', 'in all')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<LoginRoundedIcon />} label={t('dash.admin.signedIn', 'Signed in, 24 h')} value={k.loggedIn24h} sub={`${k.loggedIn7d} ${t('dash.admin.in7d', 'in the last 7 days')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<DevicesRoundedIcon />} label={t('dash.admin.sessions', 'Live sessions')} value={k.activeSessions} sub={`${k.sessionUsers} ${t('dash.admin.sessionUsers', 'people')} · ${k.sessionsUsed24h} ${t('dash.admin.usedToday', 'used today')}`} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<LockRoundedIcon />} label={t('dash.admin.locked', 'Locked out')} value={k.lockedAccounts} sub={`${k.failedLogins24h} ${t('dash.admin.failed', 'failed attempts, 24 h')}`} tone={k.lockedAccounts ? 'error.main' : 'success.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<HowToVoteRoundedIcon />} label={t('dash.admin.pendingChanges', 'Awaiting second approver')} value={k.changesPending} sub={`${k.changesApproved30d} ${t('dash.admin.approved', 'approved')} · ${k.changesRejected30d} ${t('dash.admin.rejected', 'rejected, 30 d')}`} tone={k.changesPending ? 'warning.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<FactCheckRoundedIcon />} label={t('dash.admin.review', 'Access review')} value={review ? `${review.progressPct ?? 0}%` : '—'} sub={review ? (review.overdue ? t('dash.admin.reviewOverdue', 'past its due date') : `${review.decided}/${review.total} ${t('dash.admin.reviewDecided', 'decided')} · ${review.daysLeft} ${t('dash.admin.daysLeft', 'days left')}`) : t('dash.admin.noReview', 'no cycle open')} tone={review?.overdue ? 'error.main' : 'primary.main'} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<HistoryRoundedIcon />} label={t('dash.admin.auditEvents', 'Audit events, 24 h')} value={audit ? fmtNum(audit.last24h) : '—'} sub={audit ? `${fmtNum(audit.last7d)} ${t('dash.admin.in7d', 'in the last 7 days')} · ${audit.activeActors7d} ${t('dash.admin.actors', 'people acting')}` : ''} /></Grid>
        <Grid item xs={6} md={3}><StatCard icon={<PersonAddRoundedIcon />} label={t('dash.admin.newUsers', 'Accounts opened, 30 d')} value={k.newUsers30d} sub={`${k.mfaOverdue} ${t('dash.admin.mfaOverdue', 'past their enrolment date')}`} /></Grid>
        <Grid item xs={12}><AiInsights module="admin" /></Grid>

        <Grid item xs={6} md={3}><Yardstick testId="yard-mfa" label={t('dash.admin.mfa', 'Second-factor coverage')} value={k.mfaCoveragePct} display={`${k.mfaCoveragePct}%`} target={95} targetLabel={`${t('dash.target', 'target')} ≥ 95%`} sub={`${k.mfaEnrolled}/${k.mfaRequired} ${t('dash.admin.mfaSub', 'where the role requires it')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-priv" label={t('dash.admin.privMfa', 'Privileged accounts covered')} value={k.privilegedMfaPct} display={`${k.privilegedMfaPct}%`} target={100} targetLabel={`${t('dash.target', 'target')} 100%`} sub={`${k.privileged} ${t('dash.admin.privileged', 'privileged')} · ${k.privilegedWithoutMfa} ${t('dash.admin.without', 'without')}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-dormant" label={t('dash.admin.dormant', 'Dormant accounts')} value={dormantPct} display={`${dormantPct}%`} target={5} higherIsBetter={false} targetLabel={`${t('dash.target', 'target')} ≤ 5%`} sub={`${k.dormant} ${t('dash.admin.dormantSub', { defaultValue: 'silent for {{days}} days', days: k.dormantDays })}`} /></Grid>
        <Grid item xs={6} md={3}><Yardstick testId="yard-posture" label={t('dash.admin.posture', 'Access posture')} value={k.postureScore} display={`${k.postureScore}`} target={80} targetLabel={`${t('dash.target', 'target')} ≥ 80`} sub={t('dash.admin.postureSub', 'coverage, privilege, dormancy and the review')} /></Grid>

        <Grid item xs={12} lg={7}>
          <ChartCard testId="chart-audit" title={t('dash.admin.auditByDay', 'The ledger, day by day')} sub={t('dash.admin.auditByDaySub', 'audit events recorded and sign-ins, last 14 days')} action={{ label: t('dash.admin.openAudit', 'Audit log'), to: '/admin/audit' }} explain={{ data: (audit?.byDay ?? []).map((d) => ({ ...d, label: fmtD(d.day).slice(0, 6) })) }}>
            <ResponsiveContainer>
              <ComposedChart data={(audit?.byDay ?? []).map((d) => ({ ...d, label: fmtD(d.day).slice(0, 6) }))} barCategoryGap="28%">
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                <Bar dataKey="events" name={t('dash.admin.events', 'Events')} fill={C.container} radius={[4, 4, 0, 0]} />
                <Line type="monotone" dataKey="logins" name={t('dash.admin.logins', 'Sign-ins')} stroke={C.liquid} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>
        <Grid item xs={12} lg={5}>
          <ChartCard testId="chart-roles" title={t('dash.admin.byRole', 'Accounts by role')} sub={t('dash.admin.byRoleSub', 'people in each role, and how many carry a second factor')} action={{ label: t('dash.admin.openRoles', 'Roles'), to: '/admin/roles' }} explain={{ data: data.byRole.slice(0, 9).map(({ role, ...r }) => ({ ...r, roleName: role })) }}>
            <ResponsiveContainer>
              <BarChart data={data.byRole.slice(0, 9).map(({ role, ...r }) => ({ ...r, roleName: role }))} layout="vertical" margin={{ left: 8, right: 24, top: 4 }} barCategoryGap="24%">
                <CartesianGrid stroke={grid} horizontal={false} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="roleName" width={132} tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                <Bar dataKey="users" name={t('dash.admin.people', 'People')} fill={C.dryBulk} radius={[0, 4, 4, 0]} />
                <Bar dataKey="mfaEnrolled" name={t('dash.admin.withMfa', 'With second factor')} fill={C.liquid} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </Grid>

        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-privileged" title={t('dash.admin.privilegedList', 'Privileged accounts')} sub={t('dash.admin.privilegedSub', 'those who can change who may do what — uncovered first')} action={{ label: t('dash.admin.openUsers', 'Users'), to: '/admin/users' }} explain={{ data: data.privilegedList.map((u) => ({ key: u.id, primary: u.name, secondary: `${u.roleName}${u.lastLoginAt ? ` · ${t('dash.admin.lastSeen', 'last seen')} ${fromNow(u.lastLoginAt)}` : ''}`, value: u.mfaEnrolled ? t('dash.admin.covered', 'covered') : t('dash.admin.noMfa', 'no second factor'), tone: u.mfaEnrolled ? 'success' : 'error', to: `/admin/users?q=${encodeURIComponent(u.name)}` })) }}>
            <RankList rows={data.privilegedList.map((u) => ({ key: u.id, primary: u.name, secondary: `${u.roleName}${u.lastLoginAt ? ` · ${t('dash.admin.lastSeen', 'last seen')} ${fromNow(u.lastLoginAt)}` : ''}`, value: u.mfaEnrolled ? t('dash.admin.covered', 'covered') : t('dash.admin.noMfa', 'no second factor'), tone: u.mfaEnrolled ? 'success' : 'error', to: `/admin/users?q=${encodeURIComponent(u.name)}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-dormant" title={t('dash.admin.dormantList', 'Dormant accounts')} sub={t('dash.admin.dormantListSub', 'longest silent first — confirm or revoke in the review')} action={{ label: t('dash.admin.openReviews', 'Access reviews'), to: '/admin/access-reviews' }} explain={{ data: data.dormantList.map((u) => ({ key: u.id, primary: u.name, secondary: `${u.roleName} · ${u.department || '—'}`, value: u.days === null ? t('dash.admin.never', 'never signed in') : `${u.days} d`, tone: 'warning', to: `/admin/users?q=${encodeURIComponent(u.name)}` })) }}>
            <RankList empty={t('dash.admin.noDormant', 'No dormant accounts')} rows={data.dormantList.map((u) => ({ key: u.id, primary: u.name, secondary: `${u.roleName} · ${u.department || '—'}`, value: u.days === null ? t('dash.admin.never', 'never signed in') : `${u.days} d`, tone: 'warning', to: `/admin/users?q=${encodeURIComponent(u.name)}` }))} />
          </PanelCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <PanelCard testId="panel-changes" title={t('dash.admin.changes', 'Four-eyes changes')} sub={t('dash.admin.changesSub', 'privileged grants by kind and outcome')} explain={{ data: data.changesByKind.map((c) => ({ label: label(c.kind), value: c.pending + c.approved + c.rejected + c.cancelled, display: `${c.pending + c.approved + c.rejected + c.cancelled}`, sub: `${c.pending} ${t('dash.admin.pending', 'pending')} · ${c.approved} ${t('dash.admin.approved', 'approved')} · ${c.rejected} ${t('dash.admin.rejectedShort', 'rejected')}` })) }}>
            <BucketBars rows={data.changesByKind.map((c) => ({ label: label(c.kind), value: c.pending + c.approved + c.rejected + c.cancelled, display: `${c.pending + c.approved + c.rejected + c.cancelled}`, sub: `${c.pending} ${t('dash.admin.pending', 'pending')} · ${c.approved} ${t('dash.admin.approved', 'approved')} · ${c.rejected} ${t('dash.admin.rejectedShort', 'rejected')}` }))} />
            {review && <Typography variant="body2" sx={{ mt: 2 }} data-testid="review-line">{t('dash.admin.reviewLine', { defaultValue: 'Review opened {{opened}}: {{confirmed}} confirmed, {{revoked}} revoked, {{privileged}} privileged still pending.', opened: review.openedAt ? fmtD(review.openedAt) : '—', confirmed: review.confirmed, revoked: review.revoked, privileged: review.pendingPrivileged })}</Typography>}
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>{t('dash.admin.byDepartment', 'Departments')}</Typography>
            <BucketBars rows={data.byDepartment.slice(0, 6).map((d) => ({ label: d.department, value: d.users }))} />
          </PanelCard>
        </Grid>
        {audit && <Grid item xs={12}>
          <PanelCard testId="panel-services" title={t('dash.admin.byService', 'Where the ledger writes come from')} sub={t('dash.admin.byServiceSub', 'events by service, all time — and the most frequent actions')} explain={{ data: audit.byService.slice(0, 8).map((s) => ({ label: s.service, value: s.count, display: fmtNum(s.count) })) }}>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}><BucketBars rows={audit.byService.slice(0, 8).map((s) => ({ label: s.service, value: s.count, display: fmtNum(s.count) }))} /></Grid>
              <Grid item xs={12} md={6}><BucketBars rows={audit.byAction.slice(0, 8).map((a) => ({ label: label(a.action), value: a.count, display: fmtNum(a.count) }))} /></Grid>
            </Grid>
          </PanelCard>
        </Grid>}
      </Grid>
    </>
  );
}
