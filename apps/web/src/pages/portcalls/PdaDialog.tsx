import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Skeleton, Table, TableHead, TableBody, TableRow, TableCell, Divider, Chip, Stack } from '@mui/material';
import RequestQuoteRoundedIcon from '@mui/icons-material/RequestQuoteRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import api, { type ApiError } from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { useProfile } from '../../config/runtime';
import { fmtD, fmtMoney, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import type { PdaData, PdaLine } from './types';

/* Proforma Disbursement Account — a pre-arrival cost estimate the agent can carry, then, once the call is invoiced, the estimate-vs-actual variance.
 * Money and the tax head follow the jurisdiction profile. */
const deltaColor = (d: number) => (d > 0 ? 'error.main' : d < 0 ? 'success.main' : 'text.secondary');

export default function PdaDialog({ callId, open, onClose }: { callId: string; open: boolean; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const [data, setData] = useState<PdaData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<PdaData>(`/port-calls/${callId}/pda`).then((r) => setData(r.data))
    .catch((e: ApiError) => { if (e.status === 404) setData({ pda: null, variance: null }); else dispatch(notify({ message: e.message, severity: 'error' })); }), [callId, dispatch]);
  useEffect(() => { if (open) load(); else setData(null); }, [open, load]);

  const generate = () => {
    setBusy(true);
    api.post(`/port-calls/${callId}/pda`)
      .then(() => { dispatch(notify('Cost estimate generated')); load(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })))
      .finally(() => setBusy(false));
  };

  const download = async () => {
    if (!data?.pda) return;
    const pda = data.pda;
    const { exportPdf } = await import('../../utils/exportUtils');
    exportPdf({
      name: pda.number.replace(/\//g, '-'), title: `Proforma Disbursement Account — ${pda.number}`, subtitle: `Generated ${fmtD(pda.generatedAt)} · ${profile.tax.name} ${pda.taxRate}%`,
      sections: [{
        heading: 'Estimated charges',
        columns: [
          { key: 'description', label: 'Description' }, { key: 'unit', label: 'Unit' },
          { key: 'qty', label: 'Qty', align: 'right' }, { key: 'rate', label: `Rate (${profile.currency.code})`, align: 'right', value: (r: PdaLine) => r.rate.toFixed(2) },
          { key: 'amount', label: 'Amount', align: 'right', value: (r: PdaLine) => fmtMoney(r.amount) },
        ],
        rows: pda.lines,
      }],
    });
  };

  const canGenerate = hasPerm(user, 'invoices.create');
  const pda = data?.pda;
  const variance = data?.variance;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><RequestQuoteRoundedIcon aria-hidden sx={{ color: '#BD3861' }} /> Cost Estimate (PDA)</DialogTitle>
      <DialogContent dividers>
        {!data && <Skeleton variant="rounded" height={220} />}
        {data && !pda && (
          <Box sx={{ textAlign: 'center', py: 3 }}>
            <Typography color="text.secondary" sx={{ mb: 2 }}>No cost estimate has been generated for this call yet.</Typography>
            {canGenerate && <Button variant="contained" onClick={generate} disabled={busy}>Generate estimate</Button>}
          </Box>
        )}
        {pda && (
          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontFamily: MONO, fontWeight: 700 }}>{pda.number}</Typography>
              <Chip size="small" label={`Generated ${fmtD(pda.generatedAt)}`} variant="outlined" />
            </Stack>
            <Table size="small" aria-label="Estimated charges">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 11, fontWeight: 700 }}>Description</TableCell>
                  <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>Qty</TableCell>
                  <TableCell align="right" sx={{ fontSize: 11, fontWeight: 700 }}>Amount</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pda.lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontSize: 12.5 }}>{l.description}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 12.5 }}>{fmtNum(l.qty)} {l.unit}</TableCell>
                    <TableCell align="right" sx={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(l.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow><TableCell colSpan={2} sx={{ fontSize: 12.5 }}>Subtotal</TableCell><TableCell align="right" sx={{ fontSize: 12.5 }}>{fmtMoney(pda.subtotal)}</TableCell></TableRow>
                <TableRow><TableCell colSpan={2} sx={{ fontSize: 12.5 }}>{profile.tax.name} @ {pda.taxRate}%</TableCell><TableCell align="right" sx={{ fontSize: 12.5 }}>{fmtMoney(pda.taxAmount)}</TableCell></TableRow>
                <TableRow><TableCell colSpan={2} sx={{ fontSize: 13.5, fontWeight: 800 }}>Estimated total</TableCell><TableCell align="right" sx={{ fontSize: 13.5, fontWeight: 800 }}>{fmtMoney(pda.total)}</TableCell></TableRow>
              </TableBody>
            </Table>

            {variance && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>Estimate vs. final invoice {variance.invoiceNumber}</Typography>
                <Table size="small" aria-label="Estimate against the final invoice">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontSize: 10.5, fontWeight: 700 }}>Head</TableCell>
                      <TableCell align="right" sx={{ fontSize: 10.5, fontWeight: 700 }}>Estimated</TableCell>
                      <TableCell align="right" sx={{ fontSize: 10.5, fontWeight: 700 }}>Actual</TableCell>
                      <TableCell align="right" sx={{ fontSize: 10.5, fontWeight: 700 }}><span aria-label="Delta">Δ</span></TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {variance.lines.map((l) => (
                      <TableRow key={l.code}>
                        <TableCell sx={{ fontSize: 12 }}>{l.code}</TableCell>
                        <TableCell align="right" sx={{ fontSize: 12 }}>{fmtMoney(l.estimated)}</TableCell>
                        <TableCell align="right" sx={{ fontSize: 12 }}>{fmtMoney(l.actual)}</TableCell>
                        <TableCell align="right" sx={{ fontSize: 12, fontWeight: 700, color: deltaColor(l.delta) }}>{l.delta > 0 ? '+' : ''}{fmtMoney(l.delta)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ fontSize: 13, fontWeight: 800 }}>Total</TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 800 }}>{fmtMoney(variance.estimatedTotal)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 800 }}>{fmtMoney(variance.actualTotal)}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 13, fontWeight: 800, color: variance.delta > 0 ? 'error.main' : 'success.main' }}>{variance.delta > 0 ? '+' : ''}{fmtMoney(variance.delta)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </>
            )}
            {!variance && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Variance appears once this call has an issued invoice.</Typography>}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit">Close</Button>
        {pda && canGenerate && <Button startIcon={<RefreshRoundedIcon />} onClick={generate} disabled={busy}>Regenerate</Button>}
        {pda && <Button variant="contained" startIcon={<PictureAsPdfRoundedIcon />} onClick={download}>Download PDF</Button>}
      </DialogActions>
    </Dialog>
  );
}
