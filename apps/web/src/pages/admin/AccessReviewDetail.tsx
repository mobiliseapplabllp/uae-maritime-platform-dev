import { useCallback, useEffect, useState } from 'react';
import { useParams, Link as RouterLink } from 'react-router-dom';
import { Button, Card, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography, Box, Skeleton, TextField, MenuItem, Dialog, DialogTitle, DialogContent, DialogActions, Breadcrumbs, Link } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT } from '../../utils/format';
import { statusColor, type Cycle } from './AccessReviewsPage';

interface Item { id: string; userId: string; userName: string; userEmail: string; roleName: string; scope: { level: string; ports?: string[]; facilities?: string[]; companies?: string[] }; lastLoginAt: string | null; dormant: boolean; privileged: boolean; decision: 'PENDING' | 'CONFIRMED' | 'REVOKED'; decidedBy: string; decidedAt: string | null; note: string }
const scopeText = (s: Item['scope']) => (!s || s.level === 'NATIONAL' ? 'National' : `${s.level}: ${[...(s.ports ?? []), ...(s.facilities ?? []), ...(s.companies ?? [])].join(', ')}`);

/** One cycle: every account, who attested it, and the two decisions a reviewer can take. */
export default function AccessReviewDetail() {
  const { id = '' } = useParams();
  const dispatch = useAppDispatch();
  const user = useUser();
  const canManage = hasPerm(user, 'users.manage');
  const [cycle, setCycle] = useState<(Cycle & { items: Item[] }) | null>(null);
  const [decision, setDecision] = useState('PENDING');
  const [q, setQ] = useState('');
  const [deciding, setDeciding] = useState<{ item: Item; decision: 'CONFIRMED' | 'REVOKED' } | null>(null);
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<Cycle & { items: Item[] }>(`/access-reviews/${id}`, { params: { decision: decision === 'ALL' ? undefined : decision, q: q || undefined } }).then((r) => setCycle(r.data)).catch(err), [id, decision, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const decide = () => {
    if (!deciding) return; setBusy(true);
    api.post(`/access-reviews/${id}/items/${deciding.item.id}`, { decision: deciding.decision, note })
      .then(() => { dispatch(notify(deciding.decision === 'REVOKED' ? `${deciding.item.userName} revoked and deactivated` : `${deciding.item.userName} confirmed`)); setDeciding(null); setNote(''); load(); })
      .catch(err).finally(() => setBusy(false));
  };
  const close = () => { setBusy(true); api.post(`/access-reviews/${id}/close`, { note }).then(() => { dispatch(notify('Review closed')); setClosing(false); setNote(''); load(); }).catch(err).finally(() => setBusy(false)); };
  if (!cycle) return <Skeleton variant="rounded" height={420} />;
  const open = cycle.status !== 'CLOSED';
  return (
    <>
      <Breadcrumbs sx={{ mb: 1 }}><Link component={RouterLink} to="/admin/access-reviews" underline="hover" color="inherit">Access reviews</Link><Typography color="text.primary">{fmtDT(cycle.openedAt)}</Typography></Breadcrumbs>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#0A2239" title={`Access review — opened ${fmtDT(cycle.openedAt)}`} sub={`Due ${fmtDT(cycle.dueAt)} · opened by ${cycle.openedBy}${cycle.closedAt ? ` · closed ${fmtDT(cycle.closedAt)} by ${cycle.closedBy}` : ''}`}
        actions={<Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" color={statusColor(cycle.status)} label={cycle.status} data-testid="review-status" />
          <Chip size="small" variant="outlined" label={`${cycle.confirmed} confirmed · ${cycle.revoked} revoked · ${cycle.pending} pending`} />
          {canManage && open && <Button variant="contained" size="small" disabled={busy || cycle.pending > 0} onClick={() => { setClosing(true); setNote(''); }} data-testid="close-review">Close review</Button>}
        </Stack>} />
      <Card>
        <Stack direction="row" spacing={1} sx={{ p: 1.5 }} flexWrap="wrap">
          <TextField select size="small" label="Decision" value={decision} onChange={(e) => setDecision(e.target.value)} sx={{ minWidth: 160 }}>{['PENDING', 'CONFIRMED', 'REVOKED', 'ALL'].map((d) => <MenuItem key={d} value={d}>{d === 'ALL' ? 'All' : d.charAt(0) + d.slice(1).toLowerCase()}</MenuItem>)}</TextField>
          <TextField size="small" label="Search name, email, role" value={q} onChange={(e) => setQ(e.target.value)} sx={{ minWidth: 260 }} />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Accounts under review">
            <TableHead><TableRow><TableCell>Account</TableCell><TableCell>Role</TableCell><TableCell>Scope</TableCell><TableCell>Last sign-in</TableCell><TableCell>Flags</TableCell><TableCell>Decision</TableCell><TableCell align="right">Attest</TableCell></TableRow></TableHead>
            <TableBody>
              {cycle.items.length === 0 && <TableRow><TableCell colSpan={7}><Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nothing matches.</Typography></TableCell></TableRow>}
              {cycle.items.map((it) => {
                const own = it.userId === user?.id;
                return (
                  <TableRow key={it.id} hover data-testid="review-item">
                    <TableCell><b>{it.userName}</b><br /><Typography variant="caption" color="text.secondary">{it.userEmail}</Typography></TableCell>
                    <TableCell>{it.roleName}</TableCell><TableCell>{scopeText(it.scope)}</TableCell><TableCell>{it.lastLoginAt ? fmtDT(it.lastLoginAt) : 'never'}</TableCell>
                    <TableCell><Stack direction="row" spacing={0.5}>{it.privileged && <Chip size="small" color="warning" variant="outlined" label="privileged" sx={{ height: 20, fontSize: 11 }} />}{it.dormant && <Chip size="small" color="error" variant="outlined" label="dormant" sx={{ height: 20, fontSize: 11 }} />}</Stack></TableCell>
                    <TableCell>{it.decision === 'PENDING' ? <Chip size="small" label="Pending" sx={{ height: 20, fontSize: 11 }} /> : <><Chip size="small" color={it.decision === 'CONFIRMED' ? 'success' : 'error'} label={it.decision === 'CONFIRMED' ? 'Confirmed' : 'Revoked'} sx={{ height: 20, fontSize: 11 }} /><Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{it.decidedBy} · {fmtDT(it.decidedAt)}{it.note ? ` · ${it.note}` : ''}</Typography></>}</TableCell>
                    <TableCell align="right">
                      {canManage && open && it.decision === 'PENDING' && !own && <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Button size="small" variant="outlined" onClick={() => { setDeciding({ item: it, decision: 'CONFIRMED' }); setNote(''); }} aria-label={`Confirm ${it.userName}`}>Confirm</Button>
                        <Button size="small" color="error" onClick={() => { setDeciding({ item: it, decision: 'REVOKED' }); setNote(''); }} aria-label={`Revoke ${it.userName}`}>Revoke</Button>
                      </Stack>}
                      {own && it.decision === 'PENDING' && <Typography variant="caption" color="text.secondary">Your own account — another reviewer attests it</Typography>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Card>
      <Dialog open={!!deciding} onClose={() => !busy && setDeciding(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{deciding?.decision === 'REVOKED' ? 'Revoke access' : 'Confirm access'} — {deciding?.item.userName}</DialogTitle>
        <DialogContent>
          {deciding?.decision === 'REVOKED' && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>The account is deactivated now and every session it holds ends.</Typography>}
          <TextField autoFocus fullWidth size="small" label="Note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setDeciding(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" color={deciding?.decision === 'REVOKED' ? 'error' : 'primary'} onClick={decide} disabled={busy} data-testid="decide-confirm">{deciding?.decision === 'REVOKED' ? 'Revoke' : 'Confirm'}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={closing} onClose={() => !busy && setClosing(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Close this review?</DialogTitle>
        <DialogContent><TextField autoFocus fullWidth size="small" label="Closing note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ mt: 1 }} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setClosing(false)} disabled={busy}>Cancel</Button><Button variant="contained" onClick={close} disabled={busy}>Close review</Button></DialogActions>
      </Dialog>
    </>
  );
}
