import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Box, Grid, Typography, Button, Stack, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Skeleton, Divider, Chip } from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import PaidRoundedIcon from '@mui/icons-material/PaidRounded';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import RequestQuoteRoundedIcon from '@mui/icons-material/RequestQuoteRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import EntityHover from '../../components/common/EntityHover';
import { INVOICE_STATUS_META } from '../../utils/status';
import { fmtD, fmtMoney, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import { useProfile } from '../../config/runtime';
import PdaDialog from '../portcalls/PdaDialog';
import type { Invoice, InvoiceLine, OrgSettings, PayPayload } from './types';

/* One invoice — the printable document with its lines, the tax head and the payment record, plus the issue / pay / cancel actions and the call's cost estimate for variance. */
export default function InvoiceDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const profile = useProfile();
  const { t } = useTranslation();
  const [doc, setDoc] = useState<Invoice | null>(null);
  const [org, setOrg] = useState<OrgSettings>({});
  const [payDlg, setPayDlg] = useState(false);
  const [payRef, setPayRef] = useState('');
  const [cancelDlg, setCancelDlg] = useState(false);
  const [delDlg, setDelDlg] = useState(false);
  const [pdaOpen, setPdaOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<Invoice>(`/invoices/${id}`).then((r) => setDoc(r.data)).catch(err), [id, err]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!hasPerm(user, 'settings.view')) return;
    api.get<{ values: { org?: OrgSettings } }>('/settings', { headers: { 'X-Quiet': '1' } }).then((r) => setOrg(r.data.values?.org || {})).catch(() => {});
  }, [user]);

  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const taxName = doc.taxName || profile.tax.name;
  const taxLabel = doc.billTo?.taxIdLabel || profile.tax.registrationLabel;
  const vesselName = doc.vesselName || doc.vessel?.name || '—';
  const vcn = doc.vcn || doc.portCall?.vcn || '—';
  const run = (url: string, done: string, close?: () => void) => {
    setBusy(true);
    api.post(url, payDlg ? ({ paymentRef: payRef } as PayPayload) : undefined).then(() => { dispatch(notify(done)); close?.(); load(); }).catch(err).finally(() => setBusy(false));
  };
  const download = async () => {
    const { exportPdf } = await import('../../utils/exportUtils');
    const totals = [{ label: t('invoices.subtotal'), amount: fmtMoney(doc.subtotal) }, { label: `${taxName} @ ${doc.taxRatePct}%`, amount: fmtMoney(doc.taxAmount) }, { label: t('invoices.totalPayable'), amount: fmtMoney(doc.total) }];
    await exportPdf({
      name: doc.number.replace(/\//g, '-'), title: `${t('invoices.invoice')} ${doc.number}`, subtitle: `${doc.billTo?.name || ''} · ${vesselName} · ${vcn} · ${INVOICE_STATUS_META[doc.status]?.label || doc.status}`,
      sections: [
        { heading: t('invoices.charges'), columns: [{ key: 'code', label: t('invoices.code') }, { key: 'description', label: t('invoices.description') }, { key: 'unit', label: t('invoices.unit') }, { key: 'qty', label: t('invoices.qty'), align: 'right', value: (l: InvoiceLine) => fmtNum(l.qty) }, { key: 'rate', label: `${t('invoices.rate')} (${profile.currency.code})`, align: 'right', value: (l: InvoiceLine) => l.rate.toFixed(2) }, { key: 'amount', label: t('invoices.amount'), align: 'right', value: (l: InvoiceLine) => fmtMoney(l.amount) }], rows: doc.lines },
        { columns: [{ key: 'label', label: '' }, { key: 'amount', label: t('invoices.amount'), align: 'right' }], rows: totals },
      ],
    });
  };

  return (
    <>
      <Box sx={{ displayPrint: 'none' }}>
        <PageHeader crumbs={[{ label: t('invoices.title'), to: '/invoices' }, { label: doc.number }]}
          title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span>{doc.number}</span>{doc.status === 'DRAFT' && <Chip size="small" variant="outlined" color="info" label={t('invoices.proForma')} sx={{ height: 20 }} />}</Stack>}
          sub={t('invoices.detailSub', { vessel: vesselName, vcn })}
          actions={<>
            <Button variant="outlined" startIcon={<PrintRoundedIcon />} onClick={() => window.print()}>{t('invoices.print')}</Button>
            <Button variant="outlined" startIcon={<PictureAsPdfRoundedIcon />} onClick={download}>{t('invoices.downloadPdf')}</Button>
            {doc.portCallId && <Button variant="outlined" startIcon={<RequestQuoteRoundedIcon />} onClick={() => setPdaOpen(true)}>{t('invoices.costEstimate')}</Button>}
            {hasPerm(user, 'invoices.issue') && doc.status === 'DRAFT' && <Button variant="contained" startIcon={<SendRoundedIcon />} disabled={busy} onClick={() => run(`/invoices/${id}/issue`, t('invoices.issuedDone'))}>{t('invoices.issueInvoice')}</Button>}
            {hasPerm(user, 'invoices.pay') && doc.status === 'ISSUED' && <Button variant="contained" color="success" startIcon={<PaidRoundedIcon />} onClick={() => { setPayRef(''); setPayDlg(true); }}>{t('invoices.recordPayment')}</Button>}
            {hasPerm(user, 'invoices.issue') && ['DRAFT', 'ISSUED'].includes(doc.status) && <Button variant="outlined" color="error" startIcon={<BlockRoundedIcon />} onClick={() => setCancelDlg(true)}>{t('common.cancel')}</Button>}
            {hasPerm(user, 'invoices.delete') && doc.status === 'DRAFT' && <Button variant="outlined" color="error" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => setDelDlg(true)}>{t('invoices.deleteDraft')}</Button>}
          </>} />
      </Box>

      <Card sx={{ p: { xs: 2.5, md: 4 }, maxWidth: 860, '@media print': { border: 0, boxShadow: 'none' } }} component="article" aria-label={`${t('invoices.invoice')} ${doc.number}`}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{org.portName || profile.portGeo?.name || profile.name}</Typography>
            <Typography variant="body2" color="text.secondary">{org.operator || profile.authority}</Typography>
            {org.address && <Typography variant="body2" color="text.secondary">{org.address}</Typography>}
            {org.taxId && <Typography variant="body2" color="text.secondary">{org.taxIdLabel || profile.tax.registrationLabel}: {org.taxId}</Typography>}
          </Box>
          <Box sx={{ textAlign: 'right' }}>
            <Typography sx={{ fontFamily: MONO, fontSize: 13, fontWeight: 600 }}>{doc.number}</Typography>
            <Box sx={{ mt: 0.5 }}><StatusChip value={doc.status} map={INVOICE_STATUS_META} size="medium" /></Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{doc.issuedAt ? t('invoices.issuedOn', { date: fmtD(doc.issuedAt) }) : t('invoices.notYetIssued')}</Typography>
            {doc.dueAt && doc.status === 'ISSUED' && <Typography variant="body2" color="text.secondary">{t('invoices.dueOn', { date: fmtD(doc.dueAt) })}</Typography>}
            {doc.paidAt && <Typography variant="body2" color="success.main">{t('invoices.paidOn', { date: fmtD(doc.paidAt), ref: doc.paymentRef || '—' })}</Typography>}
          </Box>
        </Box>
        <Divider sx={{ my: 2.5 }} />
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Typography variant="caption" color="text.secondary">{t('invoices.billedToCaps')}</Typography>
            <Typography sx={{ fontWeight: 700 }}>{doc.billTo?.companyId ? <EntityHover type="company" id={doc.billTo.companyId}><span>{doc.billTo.name}</span></EntityHover> : doc.billTo?.name || '—'}</Typography>
            {doc.billTo?.address && <Typography variant="body2" color="text.secondary">{doc.billTo.address}</Typography>}
            {doc.billTo?.taxId && <Typography variant="body2" color="text.secondary">{taxLabel}: {doc.billTo.taxId}</Typography>}
          </Grid>
          <Grid item xs={12} md={6}>
            <Typography variant="caption" color="text.secondary">{t('invoices.vesselCallCaps')}</Typography>
            <Typography sx={{ fontWeight: 700 }}>{doc.vesselId ? <EntityHover type="vessel" id={doc.vesselId}><span>{vesselName}</span></EntityHover> : vesselName}{doc.vessel?.imo ? ` (IMO ${doc.vessel.imo})` : ''}</Typography>
            <Typography variant="body2" color="text.secondary">
              {t('invoices.callLine', { vcn })}{doc.vessel?.grt ? ` · GRT ${fmtNum(doc.vessel.grt)}` : ''}{doc.portCall?.atd ? ` · ${t('invoices.sailed')} ${fmtD(doc.portCall.atd)}` : ''}
            </Typography>
            {doc.portCallId && <Button size="small" sx={{ px: 0, displayPrint: 'none' }} onClick={() => navigate(`/port-calls/${doc.portCallId}`)}>{t('invoices.openCall')}</Button>}
          </Grid>
        </Grid>
        <TableContainer sx={{ mt: 3, overflowX: 'auto' }}>
          <Table size="small" aria-label={t('invoices.charges')}>
            <TableHead><TableRow>
              <TableCell>{t('invoices.code')}</TableCell><TableCell>{t('invoices.description')}</TableCell><TableCell>{t('invoices.unit')}</TableCell>
              <TableCell align="right">{t('invoices.qty')}</TableCell><TableCell align="right">{t('invoices.rate')}</TableCell><TableCell align="right">{t('invoices.amount')}</TableCell>
            </TableRow></TableHead>
            <TableBody>
              {doc.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{l.code}</TableCell>
                  <TableCell>{l.description}</TableCell>
                  <TableCell>{l.unit}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(l.qty)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(l.rate)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtMoney(l.amount)}</TableCell>
                </TableRow>
              ))}
              {doc.lines.length === 0 && <TableRow><TableCell colSpan={6}><Typography color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>{t('invoices.noLines')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
          <Stack spacing={0.75} sx={{ minWidth: 300 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2" color="text.secondary">{t('invoices.subtotal')}</Typography><Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(doc.subtotal)}</Typography></Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2" color="text.secondary">{taxName} @ {doc.taxRatePct}%</Typography><Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(doc.taxAmount)}</Typography></Box>
            <Divider />
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography sx={{ fontWeight: 700 }}>{t('invoices.totalPayable')}</Typography><Typography sx={{ fontWeight: 800, fontFamily: 'Archivo', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(doc.total)}</Typography></Box>
          </Stack>
        </Box>
        {doc.notes && <Typography variant="body2" sx={{ mt: 2 }}><b>{t('invoices.notes')}:</b> {doc.notes}</Typography>}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>{t('invoices.demoFooter')}</Typography>
      </Card>

      <Dialog open={payDlg} onClose={() => !busy && setPayDlg(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('invoices.recordPayment')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{t('invoices.paymentHint', { amount: fmtMoney(doc.total) })}</Typography>
          <TextField autoFocus fullWidth size="small" label={t('invoices.paymentRef')} value={payRef} onChange={(e) => setPayRef(e.target.value)} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setPayDlg(false)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" color="success" disabled={busy} onClick={() => run(`/invoices/${id}/pay`, t('invoices.paymentRecorded'), () => setPayDlg(false))}>{t('invoices.markPaid')}</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={cancelDlg} busy={busy} title={t('invoices.cancelTitle')} confirmLabel={t('invoices.cancelConfirm')} message={t('invoices.cancelMessage', { number: doc.number })} onClose={() => setCancelDlg(false)}
        onConfirm={() => run(`/invoices/${id}/cancel`, t('invoices.cancelledDone'), () => setCancelDlg(false))} />
      <ConfirmDialog open={delDlg} busy={busy} title={t('invoices.deleteTitle')} message={t('invoices.deleteMessage', { number: doc.number })} onClose={() => setDelDlg(false)}
        onConfirm={() => { setBusy(true); api.delete(`/invoices/${id}`).then(() => { dispatch(notify(t('invoices.deletedDone'))); navigate('/invoices'); }).catch(err).finally(() => setBusy(false)); }} />
      {doc.portCallId && <PdaDialog callId={doc.portCallId} open={pdaOpen} onClose={() => setPdaOpen(false)} />}
    </>
  );
}
