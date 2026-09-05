import { useCallback, useEffect, useState } from 'react';
import { Card, Box, Typography, Stack, Chip, Button, TextField, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import HowToVoteRoundedIcon from '@mui/icons-material/HowToVoteRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { fmtDT } from '../../utils/format';

export interface ChangeRequest { id: string; kind: string; subjectId: string; subjectLabel: string; payload: Record<string, unknown>; reason: string; requestedById: string | null; requestedBy: string; requestedAt: string; status: string; approvalPerm: string }
const KIND: Record<string, string> = { USER_CREATE: 'Activate new account', USER_ROLE: 'Grant role', USER_ACTIVATE: 'Reactivate account', ROLE_MATRIX: 'Change privileged role' };

/**
 * Privileged grants waiting for a second administrator. The person who asked sees their request and may withdraw it;
 * anyone else holding the approving permission decides it.
 */
export default function ApprovalsPanel({ onChanged }: { onChanged?: () => void }) {
  const dispatch = useAppDispatch();
  const user = useUser();
  const [rows, setRows] = useState<ChangeRequest[]>([]);
  const [deciding, setDeciding] = useState<{ row: ChangeRequest; action: 'approve' | 'reject' | 'cancel' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get<ChangeRequest[]>('/users/changes', { params: { status: 'PENDING' }, headers: { 'X-Quiet': '1' } }).then((r) => setRows(r.data)).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  if (!rows.length) return null;
  const decide = () => {
    if (!deciding) return; setBusy(true);
    api.post(`/users/changes/${deciding.row.id}/${deciding.action}`, { note })
      .then(() => { dispatch(notify(deciding.action === 'approve' ? 'Approved and applied' : deciding.action === 'reject' ? 'Rejected' : 'Request withdrawn')); setDeciding(null); setNote(''); load(); onChanged?.(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  return (
    <Card sx={{ p: 2, mb: 2, borderLeft: 4, borderColor: 'warning.main' }} data-testid="approvals-panel">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><HowToVoteRoundedIcon color="warning" /><Typography variant="h6" sx={{ fontSize: 15 }}>Awaiting a second administrator</Typography><Chip size="small" label={rows.length} /></Stack>
      <Stack spacing={1}>
        {rows.map((r) => {
          const mine = r.requestedById === user?.id;
          const may = hasPerm(user, r.approvalPerm) && !mine;
          return (
            <Box key={r.id} sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', p: 1, borderRadius: 1, bgcolor: 'action.hover' }} data-testid="approval-row">
              <Chip size="small" variant="outlined" label={KIND[r.kind] ?? r.kind} />
              <Box sx={{ flex: 1, minWidth: 220 }}>
                <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{r.subjectLabel}</Typography>
                <Typography variant="caption" color="text.secondary">Requested by {r.requestedBy} · {fmtDT(r.requestedAt)}{r.reason ? ` · ${r.reason}` : ''}{mine ? ' · your request' : ''}</Typography>
              </Box>
              {may && <Button size="small" variant="contained" onClick={() => { setDeciding({ row: r, action: 'approve' }); setNote(''); }}>Approve</Button>}
              {may && <Button size="small" color="error" onClick={() => { setDeciding({ row: r, action: 'reject' }); setNote(''); }}>Reject</Button>}
              {mine && <Button size="small" color="inherit" onClick={() => { setDeciding({ row: r, action: 'cancel' }); setNote(''); }}>Withdraw</Button>}
              {!may && !mine && <Typography variant="caption" color="text.secondary">Needs {r.approvalPerm}</Typography>}
            </Box>
          );
        })}
      </Stack>
      <Dialog open={!!deciding} onClose={() => !busy && setDeciding(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{deciding?.action === 'approve' ? 'Approve' : deciding?.action === 'reject' ? 'Reject' : 'Withdraw'} — {deciding?.row.subjectLabel}</DialogTitle>
        <DialogContent><TextField autoFocus fullWidth size="small" label="Note" value={note} onChange={(e) => setNote(e.target.value)} sx={{ mt: 1 }} /></DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setDeciding(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" color={deciding?.action === 'reject' ? 'error' : 'primary'} onClick={decide} disabled={busy} data-testid="approval-confirm">Confirm</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
