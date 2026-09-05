import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import GppBadRoundedIcon from '@mui/icons-material/GppBadRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import type { FieldSpec } from '../../types';
import { KindChip, REG_STATUS_META, REGISTRY_STATE_META, words } from './shared';
import type { MasterRecord, TransactionType, TranscriptAttestation, TranscriptVerification } from './types';

/* The master record: everything the register holds on one ship, assembled from the entry and the ledger. The
 * registrar records direct transactions — a mortgage, its discharge, a caveat, a change of manager — from here, and
 * issues the attested transcript a bank or a purchaser asks for. */
const mono = { fontFamily: MONO, fontSize: 12.5 } as const;
const Fact = ({ label, value, isMono }: { label: string; value?: React.ReactNode; isMono?: boolean }) => (
  <Box><Typography variant="caption" color="text.secondary">{label}</Typography><Typography sx={{ fontWeight: 700, ...(isMono ? mono : {}) }}>{value ?? '—'}</Typography></Box>
);

export default function MasterRecordPanel({ vesselId, record, onChanged }: { vesselId: string; record: MasterRecord; onChanged: () => void }) {
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser();
  const types = useLookups('registryTransactionType');
  const [direct, setDirect] = useState<TransactionType[]>([]);
  const [dlg, setDlg] = useState<'transaction' | 'transcript' | null>(null); const [vals, setVals] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<Record<string, TranscriptVerification>>({});
  const canRecord = hasPerm(user, 'registry.assess') || hasPerm(user, 'registry.grant');
  useEffect(() => { if (canRecord) api.get<TransactionType[]>('/registry/transaction-types', { headers: { 'X-Quiet': '1' } }).then((r) => setDirect(r.data.filter((t) => t.direct))).catch(() => setDirect([])); }, [canRecord]);
  const st = record.registry;
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const fieldsFor = (type: string): FieldSpec[] => {
    switch (type) {
      case 'MORTGAGE_REGISTRATION': return [{ name: 'holder', label: 'In favour of', required: true, cols: 12 }, { name: 'amount', label: 'Amount', type: 'number' }, { name: 'reference', label: 'Deed reference' }];
      case 'MORTGAGE_DISCHARGE': return [{ name: 'encumbranceId', label: 'Charge released', type: 'select', required: true, cols: 12, options: record.encumbrances.map((e) => ({ value: e.id, label: `${words(e.kind)} — ${e.holder} (${fmtNum(e.amount)} ${e.currency})` })) }, { name: 'reference', label: 'Release reference' }];
      case 'CAVEAT': return [{ name: 'lodgedBy', label: 'Lodged by', required: true, cols: 12 }, { name: 'ground', label: 'Ground', cols: 12 }];
      case 'CAVEAT_WITHDRAWAL': return [{ name: 'caveatId', label: 'Caveat lifted', type: 'select', required: true, cols: 12, options: record.caveats.map((c) => ({ value: c.id, label: `${c.number} — ${c.particulars.lodgedBy ?? ''}` })) }];
      case 'CHANGE_OF_MANAGER': return [{ name: 'manager', label: 'New manager', required: true, cols: 12 }];
      case 'TRANSCRIPT': return [{ name: 'purpose', label: 'Purpose', cols: 12 }];
      default: return [{ name: 'reference', label: 'Reference', cols: 12 }];
    }
  };
  const record_ = () => {
    setBusy(true);
    const { type, notes, ...particulars } = vals;
    api.post(`/vessels/${vesselId}/registry/transactions`, { type, particulars, notes: notes || '' })
      .then((r: any) => { dispatch(notify(r.data?.transaction?.number ? `${r.data.transaction.number} recorded` : 'Recorded')); setDlg(null); onChanged(); })
      .catch(err).finally(() => setBusy(false));
  };
  const issue = () => {
    setBusy(true);
    api.post<{ attestation: TranscriptAttestation }>(`/vessels/${vesselId}/registry/transcripts`, { purpose: vals.purpose || '' })
      .then((r) => { dispatch(notify(`Transcript ${r.data.attestation.number} issued and sealed`)); setDlg(null); onChanged(); })
      .catch(err).finally(() => setBusy(false));
  };
  const verify = (no: string) => api.get<TranscriptVerification>(`/vessels/${vesselId}/registry/transcripts/${encodeURIComponent(no)}`).then((r) => setVerified((v) => ({ ...v, [no]: r.data }))).catch(err);
  const typeLabel = (code: string) => (types.byCode.has(code) ? types.label(code) : words(code));

  return (
    <>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <StatusChip value={st.state} map={REGISTRY_STATE_META} />
        {record.titleBlocked && <Chip size="small" color="error" label={`Caveat — title does not pass (${record.caveats.length})`} sx={{ height: 22 }} />}
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{record.registrar}{record.portOfRegistry ? ` · ${record.portOfRegistry.name}` : ''}</Typography>
        <Box sx={{ flex: 1 }} />
        {canRecord && record.onRegister !== false && st.state !== 'UNREGISTERED' && <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => { setVals({ type: direct[0]?.code ?? '' }); setDlg('transaction'); }}>Record transaction</Button>}
        {canRecord && st.state !== 'UNREGISTERED' && <Button size="small" variant="contained" startIcon={<ReceiptLongRoundedIcon />} onClick={() => { setVals({ purpose: '' }); setDlg('transcript'); }}>Issue attested transcript</Button>}
      </Stack>
      <Grid container spacing={2.5} sx={{ mb: 2 }}>
        <Grid item xs={6} sm={3}><Fact label="Official number" value={st.officialNumber || '—'} isMono /></Grid>
        <Grid item xs={6} sm={3}><Fact label="Certificate of registry" value={st.certificateNo || '—'} isMono /></Grid>
        <Grid item xs={6} sm={3}><Fact label="First registered" value={fmtD(record.firstRegistered)} /></Grid>
        <Grid item xs={6} sm={3}>
          <Fact label={st.state === 'CLOSED' ? 'Registry closed' : st.certificateExpiresOn ? (st.state === 'BAREBOAT_OUT' ? 'Charter ends' : 'Entry expires') : 'Tonnage'}
            value={st.state === 'CLOSED' ? fmtD(st.closedOn) : st.certificateExpiresOn ? fmtD(st.certificateExpiresOn) : record.tonnage ? `${fmtNum(record.tonnage.gross)} GT / ${fmtNum(record.tonnage.net)} NT` : '—'} />
        </Grid>
        {record.currentEntry && <Grid item xs={12} sm={6}><Fact label="Current entry" value={<Stack direction="row" spacing={1} alignItems="center"><KindChip kind={record.currentEntry.kind} /><span style={mono}>{record.currentEntry.applicationNo}</span>{record.currentEntry.particulars?.charterer && <span>· {String(record.currentEntry.particulars.charterer)}{record.currentEntry.particulars.registry ? ` (${String(record.currentEntry.particulars.registry)})` : ''}</span>}</Stack>} /></Grid>}
        <Grid item xs={12} sm={6}><Fact label="Manager · operator" value={`${record.vessel.manager || '—'} · ${record.vessel.operator || '—'}`} /></Grid>
      </Grid>
      {record.closure && <Chip size="small" color="error" sx={{ mb: 2 }} label={`Closed — ${words(record.closure.reason)}${record.closure.newFlag ? ` to ${record.closure.newFlag}` : ''} · ${record.closure.certificateNo ?? ''}`} />}

      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Registered ownership{record.shareLedger ? ` — ${record.shareLedger.held} of ${record.shareLedger.denominator} shares` : ''}</Typography>
      <TableContainer sx={{ mb: 2 }}><Table size="small" aria-label="Registered ownership">
        <TableHead><TableRow><TableCell>Owner</TableCell><TableCell>Kind</TableCell><TableCell>Registration</TableCell><TableCell align="right">Shares</TableCell></TableRow></TableHead>
        <TableBody>
          {record.owners.map((o, i) => <TableRow key={i}><TableCell sx={{ fontWeight: 600 }}>{o.name}</TableCell><TableCell>{words(o.kind)}</TableCell><TableCell sx={mono}>{o.cin || o.pan || (o as any).registrationNo || '—'}</TableCell><TableCell align="right">{o.shares}</TableCell></TableRow>)}
          {!record.owners.length && <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No ownership recorded.</TableCell></TableRow>}
        </TableBody>
      </Table></TableContainer>

      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Charges against the entry — {record.encumbrances.length} subsisting, {record.dischargedEncumbrances.length} discharged</Typography>
      <TableContainer sx={{ mb: 2 }}><Table size="small" aria-label="Charges against the entry">
        <TableHead><TableRow><TableCell>Charge</TableCell><TableCell>In favour of</TableCell><TableCell align="right">Amount</TableCell><TableCell>Registered on</TableCell><TableCell>Discharged</TableCell><TableCell>Reference</TableCell></TableRow></TableHead>
        <TableBody>
          {[...record.encumbrances, ...record.dischargedEncumbrances].map((e) => <TableRow key={e.id}><TableCell>{words(e.kind)}</TableCell><TableCell sx={{ fontWeight: 600 }}>{e.holder}</TableCell><TableCell align="right">{fmtNum(e.amount)} {e.currency}</TableCell><TableCell>{fmtD(e.registeredOn)}</TableCell><TableCell>{e.dischargedOn ? fmtD(e.dischargedOn) : <Chip size="small" color="warning" label="Live" sx={{ height: 20, fontSize: 10.5 }} />}</TableCell><TableCell sx={mono}>{e.reference || '—'}</TableCell></TableRow>)}
          {!record.encumbrances.length && !record.dischargedEncumbrances.length && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary' }}>Encumbrance register clear.</TableCell></TableRow>}
        </TableBody>
      </Table></TableContainer>

      {record.caveats.length > 0 && <Alert severity="warning" sx={{ mb: 2 }}>{record.caveats.map((c) => `${c.number} lodged by ${c.particulars.lodgedBy ?? 'a claimant'}${c.particulars.ground ? ` — ${c.particulars.ground}` : ''}`).join(' · ')}</Alert>}

      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Ledger — {record.transactions.length} transactions</Typography>
      <TableContainer sx={{ mb: 2 }}><Table size="small" aria-label="Registry ledger">
        <TableHead><TableRow><TableCell>Number</TableCell><TableCell>Transaction</TableCell><TableCell>Recorded</TableCell><TableCell>By</TableCell><TableCell>Application</TableCell><TableCell>Particulars</TableCell></TableRow></TableHead>
        <TableBody>
          {record.transactions.map((t) => (
            <TableRow key={t.id} hover>
              <TableCell sx={{ ...mono, fontWeight: 600 }}>{t.number}</TableCell><TableCell>{typeLabel(t.type)}</TableCell><TableCell>{fmtD(t.recordedOn)}</TableCell><TableCell>{t.recordedBy}</TableCell>
              <TableCell sx={mono}>{t.applicationNo ? <Button size="small" sx={{ p: 0, minWidth: 0, ...mono }} onClick={() => t.registrationId && navigate(`/registry/${t.registrationId}`)}>{t.applicationNo}</Button> : '—'}</TableCell>
              <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>{Object.entries(t.particulars).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && !['certificateNo'].includes(k)).slice(0, 4).map(([k, v]) => `${words(k.replace(/([A-Z])/g, ' $1'))}: ${String(v)}`).join(' · ')}</TableCell>
            </TableRow>
          ))}
          {!record.transactions.length && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary' }}>Nothing has been recorded against this entry.</TableCell></TableRow>}
        </TableBody>
      </Table></TableContainer>

      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Applications</Typography>
      <TableContainer sx={{ mb: 2 }}><Table size="small" aria-label="Registry applications">
        <TableHead><TableRow><TableCell>Application</TableCell><TableCell>Variant</TableCell><TableCell>Status</TableCell><TableCell>Certificate</TableCell><TableCell>Granted</TableCell></TableRow></TableHead>
        <TableBody>
          {record.applications.map((r) => (
            <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/registry/${r.id}`)}>
              <TableCell sx={{ ...mono, fontWeight: 600 }}>{r.applicationNo}</TableCell><TableCell><KindChip kind={r.kind} /></TableCell>
              <TableCell><StatusChip value={r.status} map={REG_STATUS_META} /></TableCell><TableCell sx={mono}>{r.certificateNo || '—'}</TableCell><TableCell>{fmtD(r.grantedOn)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></TableContainer>

      {record.transcripts.length > 0 && (
        <>
          <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Transcripts issued</Typography>
          <TableContainer><Table size="small" aria-label="Transcripts issued">
            <TableHead><TableRow><TableCell>Number</TableCell><TableCell>Issued</TableCell><TableCell>By</TableCell><TableCell>Purpose</TableCell><TableCell>Digest</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>{record.transcripts.map((t) => { const v = verified[t.transcriptNo]; return (
              <TableRow key={t.transcriptNo}><TableCell sx={{ ...mono, fontWeight: 600 }}>{t.transcriptNo}</TableCell><TableCell>{fmtD(t.issuedOn)}</TableCell><TableCell>{t.issuedBy}</TableCell><TableCell>{t.purpose || '—'}</TableCell><TableCell sx={{ ...mono, fontSize: 11 }}>{t.digest?.slice(0, 16)}…</TableCell>
                <TableCell align="right">{v ? <Tooltip title={v.reason}><Chip size="small" icon={v.matches ? <VerifiedRoundedIcon /> : <GppBadRoundedIcon />} color={v.matches ? 'success' : 'warning'} label={v.matches ? 'Attests the register' : `Register moved (${v.transactionsSince})`} sx={{ height: 22 }} /></Tooltip> : <Button size="small" onClick={() => verify(t.transcriptNo)}>Verify</Button>}</TableCell></TableRow>
            ); })}</TableBody>
          </Table></TableContainer>
        </>
      )}

      <Dialog open={dlg === 'transaction'} onClose={() => !busy && setDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Record a transaction — {record.vessel.name}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields values={vals} onChange={(v) => setVals(v.type !== vals.type ? { type: v.type } : v)} fields={[{ name: 'type', label: 'Transaction', type: 'select', required: true, cols: 12, options: direct.map((t) => ({ value: t.code, label: typeLabel(t.code) })) }, ...fieldsFor(vals.type), { name: 'notes', label: 'Notes', type: 'multiline', cols: 12 }]} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>Cancel</Button><Button variant="contained" onClick={record_} disabled={busy || !vals.type}>Record</Button></DialogActions>
      </Dialog>
      <Dialog open={dlg === 'transcript'} onClose={() => !busy && setDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Issue an attested transcript</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>The transcript is numbered, sealed with a digest of the register as it stands, and recorded on the ledger. It can be verified later against the register.</Typography>
          <FormFields values={vals} onChange={setVals} fields={[{ name: 'purpose', label: 'Purpose', cols: 12 }]} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button color="inherit" onClick={() => setDlg(null)} disabled={busy}>Cancel</Button><Button variant="contained" onClick={issue} disabled={busy}>Issue</Button></DialogActions>
      </Dialog>
    </>
  );
}
