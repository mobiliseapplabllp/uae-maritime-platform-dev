import { useEffect, useState } from 'react';
import { IconButton, Tooltip, Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Chip } from '@mui/material';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';
import { passwordProblems, PASSWORD_RULE_TEXT } from '@maritime/contracts';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import CrudPage from '../../components/common/CrudPage';
import EntityHover from '../../components/common/EntityHover';
import { fmtDT } from '../../utils/format';

interface RoleLite { id: string; name: string }
interface UserRow { id: string; name: string; email: string; role?: RoleLite; roleId?: string; designation?: string; department?: string; phone?: string; active: boolean; lastLoginAt?: string | null }

export default function UsersPage() {
  const dispatch = useAppDispatch();
  const [roles, setRoles] = useState<RoleLite[]>([]);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState(false);
  // The same policy the API enforces, checked against the account being reset.
  const pwdProblems = pwd ? passwordProblems(pwd, { email: resetFor?.email, name: resetFor?.name }) : [];
  useEffect(() => { api.get<RoleLite[]>('/roles').then((r) => setRoles(r.data)).catch(() => {}); }, []);
  const roleOpts = roles.map((r) => ({ value: r.id, label: r.name }));
  return (
    <>
      <CrudPage<UserRow>
        statsScope="users" icon={GroupRoundedIcon} iconColor="#0A2239" title="Users" sub="Portal accounts and their roles" entityName="user" endpoint="/users" defaultSort="name"
        perms={{ create: 'users.manage', edit: 'users.manage', del: 'users.manage' }} searchPlaceholder="Search name, email…"
        columns={[
          { key: 'name', label: 'Name', render: (r) => <EntityHover type="user" id={r.id}><b>{r.name}</b></EntityHover> },
          { key: 'email', label: 'Email', mono: true },
          { key: 'role', label: 'Role', render: (r) => <Chip size="small" variant="outlined" label={r.role?.name || '—'} sx={{ height: 20, fontSize: 11 }} /> },
          { key: 'designation', label: 'Designation' }, { key: 'department', label: 'Department', render: (r) => r.department || '—' },
          { key: 'active', label: 'Status', render: (r) => <Chip size="small" label={r.active ? 'Active' : 'Disabled'} color={r.active ? 'success' : 'default'} sx={{ height: 20, fontSize: 11 }} /> },
          { key: 'lastLoginAt', label: 'Last login', render: (r) => fmtDT(r.lastLoginAt) },
        ]}
        filters={[{ name: 'role', label: 'Role', options: roleOpts }]}
        formFields={(editing) => [
          { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email', required: true, type: 'email' },
          ...(!(editing && 'id' in editing) ? [{ name: 'password', label: 'Initial password', required: true, helper: PASSWORD_RULE_TEXT, type: 'password' as const }] : []),
          { name: 'roleId', label: 'Role', type: 'select', required: true, options: roleOpts },
          { name: 'designation', label: 'Designation' }, { name: 'department', label: 'Department' }, { name: 'phone', label: 'Phone' },
          { name: 'active', label: 'Account active', type: 'switch' },
        ]}
        defaults={{ active: true }}
        toForm={(row) => ({ name: row.name, email: row.email, roleId: row.role?.id || row.roleId, designation: row.designation, department: row.department, phone: row.phone, active: row.active })}
        rowActionsExtra={(row) => <Tooltip title="Reset password"><IconButton size="small" aria-label="Reset password" onClick={() => { setResetFor(row); setPwd(''); }}><KeyRoundedIcon fontSize="inherit" /></IconButton></Tooltip>}
        deleteMessage={(r) => `Delete ${r?.name}? Their audit history is retained.`} />
      <Dialog open={!!resetFor} onClose={() => !busy && setResetFor(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Reset password — {resetFor?.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><TextField autoFocus fullWidth type="password" label="New password" value={pwd} error={pwdProblems.length > 0} onChange={(e) => setPwd(e.target.value)} helperText={pwdProblems.length ? pwdProblems.join('. ') : `${PASSWORD_RULE_TEXT} Share it with the user securely.`} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setResetFor(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={busy || !pwd || pwdProblems.length > 0} onClick={() => { if (!resetFor) return; setBusy(true); api.post(`/users/${resetFor.id}/reset-password`, { password: pwd }).then(() => { dispatch(notify('Password reset')); setResetFor(null); }).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false)); }}>Reset</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
