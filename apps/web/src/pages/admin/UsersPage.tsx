import { useEffect, useState } from 'react';
import { IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Chip, Stack, List, ListItem, ListItemText, Typography } from '@mui/material';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';
import PhonelinkEraseRoundedIcon from '@mui/icons-material/PhonelinkEraseRounded';
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded';
import { passwordProblems, PASSWORD_RULE_TEXT, SCOPE_LEVELS, type TenancyScope } from '@maritime/contracts';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import CrudPage from '../../components/common/CrudPage';
import EntityHover from '../../components/common/EntityHover';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { fmtDT } from '../../utils/format';
import ScopeEditor from './ScopeEditor';
import ApprovalsPanel from './ApprovalsPanel';

interface RoleLite { id: string; name: string; permissions?: string[] }
interface UserRow {
  id: string; name: string; email: string; role?: RoleLite; roleId?: string; designation?: string; department?: string; phone?: string; active: boolean; lastLoginAt?: string | null;
  scope?: TenancyScope; mfa?: { enrolled: boolean; required: boolean }; dormantSince?: string | null; deactivatedReason?: string; pendingChange?: { id: string; kind: string } | null;
}
interface SessionRow { id: string; device: string; ip: string; lastUsedAt: string; startedAt: string }
const scopeLabel = (s?: TenancyScope) => !s || s.level === 'NATIONAL' ? 'National' : `${s.level.charAt(0)}${s.level.slice(1).toLowerCase()}: ${[...(s.ports ?? []), ...(s.zones ?? []), ...(s.facilities ?? []), ...(s.companies ?? [])].join(', ') || '—'}`;

export default function UsersPage() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const [roles, setRoles] = useState<RoleLite[]>([]);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [mfaFor, setMfaFor] = useState<UserRow | null>(null);
  const [sessionsFor, setSessionsFor] = useState<UserRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const canManage = hasPerm(user, 'users.manage');
  // The same policy the API enforces, checked against the account being reset.
  const pwdProblems = pwd ? passwordProblems(pwd, { email: resetFor?.email, name: resetFor?.name }) : [];
  useEffect(() => { api.get<RoleLite[]>('/roles').then((r) => setRoles(r.data)).catch(() => {}); }, []);
  useEffect(() => { if (sessionsFor) { setSessions(null); api.get<SessionRow[]>(`/users/${sessionsFor.id}/sessions`).then((r) => setSessions(r.data)).catch(() => setSessions([])); } }, [sessionsFor]);
  const roleOpts = roles.map((r) => ({ value: r.id, label: r.name }));
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const statusChip = (r: UserRow) => {
    if (r.pendingChange) return <Chip size="small" color="warning" label="Awaiting approval" sx={{ height: 20, fontSize: 11 }} />;
    if (!r.active) return <Chip size="small" label={r.deactivatedReason === 'DORMANT' ? 'Disabled — dormant' : r.deactivatedReason === 'ACCESS_REVIEW' ? 'Disabled — review' : 'Disabled'} sx={{ height: 20, fontSize: 11 }} />;
    if (r.dormantSince) return <Chip size="small" color="warning" variant="outlined" label="Dormant" sx={{ height: 20, fontSize: 11 }} />;
    return <Chip size="small" label="Active" color="success" sx={{ height: 20, fontSize: 11 }} />;
  };
  return (
    <>
      <CrudPage<UserRow>
        key={refreshKey}
        statsScope="users" icon={GroupRoundedIcon} iconColor="#0A2239" title="Users" sub="Portal accounts, their roles and what each may see" entityName="user" endpoint="/users" defaultSort="name"
        perms={{ create: 'users.manage', edit: 'users.manage', del: 'users.manage' }} searchPlaceholder="Search name, email…"
        beforeTable={<ApprovalsPanel onChanged={() => setRefreshKey((k) => k + 1)} />}
        columns={[
          { key: 'name', label: 'Name', render: (r) => <EntityHover type="user" id={r.id}><b>{r.name}</b></EntityHover> },
          { key: 'email', label: 'Email', mono: true },
          { key: 'role', label: 'Role', render: (r) => <Chip size="small" variant="outlined" label={r.role?.name || '—'} sx={{ height: 20, fontSize: 11 }} /> },
          { key: 'scope', label: 'Scope', render: (r) => <Chip size="small" variant="outlined" color={!r.scope || r.scope.level === 'NATIONAL' ? 'default' : 'info'} label={scopeLabel(r.scope)} sx={{ height: 20, fontSize: 11 }} /> },
          { key: 'mfa', label: '2-step', render: (r) => <Chip size="small" color={r.mfa?.enrolled ? 'success' : r.mfa?.required ? 'warning' : 'default'} variant={r.mfa?.enrolled ? 'filled' : 'outlined'} label={r.mfa?.enrolled ? 'On' : r.mfa?.required ? 'Required' : 'Off'} sx={{ height: 20, fontSize: 11 }} /> },
          { key: 'active', label: 'Status', render: statusChip },
          { key: 'lastLoginAt', label: 'Last login', render: (r) => fmtDT(r.lastLoginAt) },
        ]}
        filters={[
          { name: 'role', label: 'Role', options: roleOpts },
          { name: 'level', label: 'Scope', options: SCOPE_LEVELS.map((l) => ({ value: l, label: `${l.charAt(0)}${l.slice(1).toLowerCase()}` })) },
          { name: 'mfa', label: '2-step', options: [{ value: 'enrolled', label: 'On' }, { value: 'missing', label: 'Not set up' }] },
          { name: 'pending', label: 'Approval', options: [{ value: 'true', label: 'Awaiting approval' }] },
          { name: 'dormant', label: 'Dormant', options: [{ value: 'true', label: 'Dormant accounts' }] },
        ]}
        formFields={(editing) => [
          { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', required: true, type: 'email' },
          ...(!(editing && 'id' in editing) ? [{ name: 'password', label: 'Initial password', required: true, helper: PASSWORD_RULE_TEXT, type: 'password' as const }] : []),
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOpts, helper: 'A role that manages users, roles or holds every permission is granted only when a second administrator approves' },
          { name: 'designation', label: 'Designation' }, { name: 'department', label: 'Department' }, { name: 'phone', label: 'Phone' },
          { name: 'active', label: 'Account active', type: 'switch' },
          { name: 'reason', label: 'Reason (recorded with an approval request)', cols: 12 },
        ]}
        defaults={{ active: true, scope: { level: 'NATIONAL' } }}
        toForm={(row) => ({ name: row.name, email: row.email, roleId: row.role?.id || row.roleId, designation: row.designation, department: row.department, phone: row.phone, active: row.active, scope: row.scope ?? { level: 'NATIONAL' } })}
        transformOut={(values) => values}
        drawerExtra={(_editing, values, setValues) => <ScopeEditor value={values.scope} onChange={(scope) => setValues({ ...values, scope })} disabled={!canManage} />}
        rowActionsExtra={(row) => (
          <Stack direction="row" spacing={0} component="span">
            <Tooltip title="Reset password"><IconButton size="small" aria-label={`Reset password for ${row.name}`} onClick={() => { setResetFor(row); setPwd(''); }}><KeyRoundedIcon fontSize="inherit" /></IconButton></Tooltip>
            {row.mfa?.enrolled && row.id !== user?.id && <Tooltip title="Reset two-step verification"><IconButton size="small" aria-label={`Reset two-step verification for ${row.name}`} onClick={() => setMfaFor(row)}><PhonelinkEraseRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
            <Tooltip title="Sessions"><IconButton size="small" aria-label={`Sessions of ${row.name}`} onClick={() => setSessionsFor(row)}><DevicesRoundedIcon fontSize="inherit" /></IconButton></Tooltip>
          </Stack>
        )}
        deleteMessage={(r) => `Delete ${r?.name}? Their audit history is retained.`} />
      <Dialog open={!!resetFor} onClose={() => !busy && setResetFor(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Reset password — {resetFor?.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><TextField autoFocus fullWidth type="password" label="New password" value={pwd} error={pwdProblems.length > 0} onChange={(e) => setPwd(e.target.value)} helperText={pwdProblems.length ? pwdProblems.join('. ') : `${PASSWORD_RULE_TEXT} Share it with the user securely. Their sessions end.`} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setResetFor(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={busy || !pwd || pwdProblems.length > 0} onClick={() => { if (!resetFor) return; setBusy(true); api.post(`/users/${resetFor.id}/reset-password`, { password: pwd }).then(() => { dispatch(notify('Password reset')); setResetFor(null); }).catch(err).finally(() => setBusy(false)); }}>Reset</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={!!mfaFor} busy={busy} title={`Reset two-step verification — ${mfaFor?.name}?`} message="Their authenticator is unlinked and every session ends. They set it up again at their next sign-in." onClose={() => setMfaFor(null)}
        onConfirm={() => { if (!mfaFor) return; setBusy(true); api.post(`/users/${mfaFor.id}/mfa/reset`, {}).then(() => { dispatch(notify('Two-step verification reset')); setMfaFor(null); setRefreshKey((k) => k + 1); }).catch(err).finally(() => setBusy(false)); }} />
      <Dialog open={!!sessionsFor} onClose={() => !busy && setSessionsFor(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Sessions — {sessionsFor?.name}</DialogTitle>
        <DialogContent>
          {sessions && sessions.length === 0 && <Typography variant="body2" color="text.secondary">No live sessions.</Typography>}
          <List dense disablePadding>
            {(sessions ?? []).map((s) => <ListItem key={s.id} disableGutters><ListItemText primary={s.device} secondary={`${s.ip || '—'} · started ${fmtDT(s.startedAt)} · last used ${fmtDT(s.lastUsedAt)}`} /></ListItem>)}
          </List>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setSessionsFor(null)} disabled={busy}>Close</Button>
          {canManage && !!sessions?.length && <Button variant="contained" color="error" disabled={busy} onClick={() => { if (!sessionsFor) return; setBusy(true); api.delete<{ revoked: number }>(`/users/${sessionsFor.id}/sessions`).then((r) => { dispatch(notify(`${r.data.revoked} session token(s) revoked`)); setSessions([]); }).catch(err).finally(() => setBusy(false)); }}>End all sessions</Button>}
        </DialogActions>
      </Dialog>
    </>
  );
}
