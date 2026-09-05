import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography, Box, Skeleton } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import BedtimeRoundedIcon from '@mui/icons-material/BedtimeRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { fmtDT } from '../../utils/format';

export interface Cycle { id: string; openedAt: string; dueAt: string; closedAt: string | null; openedBy: string; closedBy: string; total: number; note: string; pending: number; confirmed: number; revoked: number; status: 'OPEN' | 'OVERDUE' | 'CLOSED' }
export const statusColor = (s: Cycle['status']) => (s === 'CLOSED' ? 'default' : s === 'OVERDUE' ? 'error' : 'warning') as 'default' | 'error' | 'warning';

/** Who still holds what: every cycle, and the buttons that open the next one or sweep for dormant accounts now. */
export default function AccessReviewsPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useUser();
  const canManage = hasPerm(user, 'users.manage');
  const [rows, setRows] = useState<Cycle[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<Cycle[]>('/access-reviews').then((r) => setRows(r.data)).catch(err), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const open = () => { setBusy(true); api.post<Cycle & { created: boolean }>('/access-reviews', {}).then((r) => { dispatch(notify(r.data.created ? `Review opened — ${r.data.total} accounts to attest` : 'A review is already open')); navigate(`/admin/access-reviews/${r.data.id}`); }).catch(err).finally(() => setBusy(false)); };
  const sweep = () => { setBusy(true); api.post<{ flagged: number; deactivated: number; examined: number; action: string; dormantAfterDays: number }>('/access-reviews/dormant-sweep', {}).then((r) => dispatch(notify(`Dormant sweep: ${r.data.examined} examined, ${r.data.flagged} flagged, ${r.data.deactivated} deactivated (idle over ${r.data.dormantAfterDays} days)`))).catch(err).finally(() => { setBusy(false); setSweeping(false); }); };
  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#0A2239" title="Access reviews" sub="Every active account attested by a second person, on the cadence the security settings set — and a daily look for accounts nobody uses"
        actions={canManage && <Stack direction="row" spacing={1}><Button startIcon={<BedtimeRoundedIcon />} onClick={() => setSweeping(true)} disabled={busy}>Run dormant sweep</Button><Button variant="contained" startIcon={<PlayArrowRoundedIcon />} onClick={open} disabled={busy} data-testid="open-review">Open a review</Button></Stack>} />
      {!rows ? <Skeleton variant="rounded" height={280} /> : (
        <Card>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Access review cycles">
              <TableHead><TableRow><TableCell>Opened</TableCell><TableCell>Due</TableCell><TableCell>Status</TableCell><TableCell align="right">Accounts</TableCell><TableCell align="right">Confirmed</TableCell><TableCell align="right">Revoked</TableCell><TableCell align="right">Pending</TableCell><TableCell>Opened by</TableCell><TableCell>Closed</TableCell></TableRow></TableHead>
              <TableBody>
                {rows.length === 0 && <TableRow><TableCell colSpan={9}><Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>No review has been opened yet. The scheduler opens one every quarter; an administrator can open one now.</Typography></TableCell></TableRow>}
                {rows.map((c) => (
                  <TableRow key={c.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/access-reviews/${c.id}`)} data-testid="review-row">
                    <TableCell>{fmtDT(c.openedAt)}</TableCell><TableCell>{fmtDT(c.dueAt)}</TableCell>
                    <TableCell><Chip size="small" color={statusColor(c.status)} label={c.status} sx={{ height: 20, fontSize: 11 }} /></TableCell>
                    <TableCell align="right">{c.total}</TableCell><TableCell align="right">{c.confirmed}</TableCell><TableCell align="right">{c.revoked}</TableCell><TableCell align="right">{c.pending}</TableCell>
                    <TableCell>{c.openedBy}</TableCell><TableCell>{c.closedAt ? `${fmtDT(c.closedAt)} · ${c.closedBy}` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </Card>
      )}
      <ConfirmDialog open={sweeping} busy={busy} title="Run the dormant account sweep now?" message="Accounts idle beyond the policy's window are flagged or deactivated, as the security settings say. The last administrator is never touched." onClose={() => setSweeping(false)} onConfirm={sweep} />
    </>
  );
}
