import { useCallback, useEffect, useState } from 'react';
import { Grid, Card, Box, Typography, List, ListItem, ListItemButton, ListItemText, Button, Checkbox, Table, TableHead, TableRow, TableCell, TableBody, Chip, TextField, Dialog, DialogTitle, DialogContent, DialogActions, Stack, Skeleton, Divider, IconButton, Switch, FormControlLabel } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import ConfirmDialog from '../../components/common/ConfirmDialog';

interface Role { id: string; name: string; description: string; permissions: string[]; system: boolean; usersCount: number; mfaRequired: boolean; pendingChange?: { id: string; kind: string } | null }
interface Group { module: string; label: string; actions: string[] }
const COLS = ['view', 'create', 'edit', 'delete', 'manage', 'transition', 'close', 'issue', 'pay', 'approve', 'apply', 'assess', 'grant', 'use', 'configure', 'review'];

export default function RolesPage() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<Role | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [mfaRequired, setMfaRequired] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newVals, setNewVals] = useState({ name: '', description: '' });
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = hasPerm(user, 'roles.manage');
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));

  const load = useCallback((keepId?: string) => Promise.all([api.get<Role[]>('/roles'), api.get<{ permissionGroups: Group[] }>('/meta')]).then(([r, m]) => {
    setRoles(r.data); setGroups(m.data.permissionGroups);
    setSelected((prev) => { const pick = r.data.find((x) => x.id === (keepId || prev?.id)) || r.data[0]; setPerms(pick?.permissions || []); setMfaRequired(pick?.mfaRequired ?? true); setDirty(false); return pick; });
  }).catch(err), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  if (!roles) return <Skeleton variant="rounded" height={420} />;
  const isSuper = !!selected?.permissions.includes('*');
  const editable = canManage && !!selected && !isSuper;
  const usedCols = COLS.filter((a) => groups.some((g) => g.actions.includes(a)));
  const toggle = (p: string) => { if (!editable) return; setPerms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p])); setDirty(true); };
  const toggleModule = (g: Group) => { if (!editable) return; const all = g.actions.map((a) => `${g.module}.${a}`); const has = all.every((p) => perms.includes(p)); setPerms((x) => (has ? x.filter((p) => !all.includes(p)) : [...new Set([...x, ...all])])); setDirty(true); };

  return (
    <>
      <PageHeader icon={AdminPanelSettingsRoundedIcon} iconColor="#0A2239" title="Roles & permissions" sub="What each role can see and do — changes apply at once; a change to a privileged role waits for a second administrator"
        actions={canManage && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={() => { setNewVals({ name: '', description: '' }); setCreating(true); }}>New role</Button>} />
      <Grid container spacing={2}>
        <Grid item xs={12} md={3.5}>
          <Card>
            <List dense disablePadding aria-label="Roles">
              {roles.map((r) => (
                <ListItem key={r.id} disablePadding secondaryAction={canManage && !r.system ? <IconButton size="small" color="error" edge="end" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton> : undefined}>
                  <ListItemButton selected={selected?.id === r.id} onClick={() => { setSelected(r); setPerms(r.permissions); setMfaRequired(r.mfaRequired ?? true); setDirty(false); }}>
                    <ListItemText primary={<Stack direction="row" spacing={1} alignItems="center"><span style={{ fontWeight: 600 }}>{r.name}</span>{r.system && <Chip size="small" variant="outlined" label="system" sx={{ height: 18, fontSize: 10 }} />}{r.pendingChange && <Chip size="small" color="warning" label="awaiting approval" sx={{ height: 18, fontSize: 10 }} />}</Stack>}
                      secondary={`${r.usersCount} user(s) · ${r.permissions.includes('*') ? 'all permissions' : `${r.permissions.length} permissions`}`} />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Card>
        </Grid>
        <Grid item xs={12} md={8.5}>
          <Card>
            <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Box sx={{ flex: 1, minWidth: 220 }}><Typography variant="h6" sx={{ fontSize: 15 }}>{selected?.name}</Typography><Typography variant="caption" color="text.secondary">{selected?.description}</Typography></Box>
              {isSuper && <Chip color="primary" size="small" label="Full access — not editable" />}
              <FormControlLabel control={<Switch size="small" checked={isSuper || mfaRequired} disabled={!editable} onChange={(e) => { setMfaRequired(e.target.checked); setDirty(true); }} inputProps={{ 'aria-label': 'Two-step verification required' }} />} label={<Typography variant="body2">Two-step verification required</Typography>} />
              {editable && dirty && <Button variant="contained" size="small" disabled={busy} onClick={() => { if (!selected) return; setBusy(true); api.put<Role>(`/roles/${selected.id}`, { permissions: perms, mfaRequired }).then((r) => { dispatch(notify(r.data.pendingChange ? 'Sent for approval — a second administrator must approve a change to a privileged role' : 'Permissions saved')); load(selected.id); }).catch(err).finally(() => setBusy(false)); }}>Save changes</Button>}
            </Box>
            <Divider />
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead><TableRow><TableCell>Module</TableCell>{usedCols.map((a) => <TableCell key={a} align="center" sx={{ px: 0.5 }}>{a}</TableCell>)}</TableRow></TableHead>
                <TableBody>
                  {groups.map((g) => {
                    const all = g.actions.map((a) => `${g.module}.${a}`);
                    const allOn = isSuper || all.every((p) => perms.includes(p));
                    return (
                      <TableRow key={g.module} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}><Checkbox size="small" checked={allOn} disabled={!editable} indeterminate={!allOn && !isSuper && all.some((p) => perms.includes(p))} onChange={() => toggleModule(g)} sx={{ p: 0.25, mr: 0.75 }} inputProps={{ 'aria-label': `All ${g.label}` }} /><b>{g.label}</b></TableCell>
                        {usedCols.map((a) => (
                          <TableCell key={a} align="center" sx={{ px: 0.5 }}>
                            {g.actions.includes(a) ? <Checkbox size="small" sx={{ p: 0.25 }} disabled={!editable} checked={isSuper || perms.includes(`${g.module}.${a}`)} onChange={() => toggle(`${g.module}.${a}`)} inputProps={{ 'aria-label': `${g.label} ${a}` }} /> : <Typography component="span" sx={{ color: 'divider' }}>·</Typography>}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>
          </Card>
        </Grid>
      </Grid>
      <Dialog open={creating} onClose={() => !busy && setCreating(false)} maxWidth="xs" fullWidth>
        <DialogTitle>New role</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}><Stack spacing={2}><TextField autoFocus label="Role name" value={newVals.name} onChange={(e) => setNewVals((v) => ({ ...v, name: e.target.value }))} /><TextField label="Description" value={newVals.description} onChange={(e) => setNewVals((v) => ({ ...v, description: e.target.value }))} /></Stack></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
          <Button variant="contained" disabled={busy || !newVals.name} onClick={() => { setBusy(true); api.post<Role>('/roles', { ...newVals, permissions: ['dashboard.view'] }).then((r) => { dispatch(notify('Role created — now set its permissions')); setCreating(false); load(r.data.id); }).catch(err).finally(() => setBusy(false)); }}>Create</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={!!deleting} busy={busy} title={`Delete role "${deleting?.name}"?`} message="Roles still assigned to users cannot be deleted." onClose={() => setDeleting(null)}
        onConfirm={() => { if (!deleting) return; setBusy(true); api.delete(`/roles/${deleting.id}`).then(() => { dispatch(notify('Role deleted')); setDeleting(null); load(); }).catch(err).finally(() => setBusy(false)); }} />
    </>
  );
}
