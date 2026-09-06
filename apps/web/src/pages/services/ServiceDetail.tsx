import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, Grid, MenuItem, Skeleton, Stack, Switch, TextField, Typography } from '@mui/material';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { OpenLink } from '../../components/dashboard/kit';
import { fmtMoney } from '../../utils/format';
import { MONO } from '../../theme';
import type { FormField, ServiceDetail as Detail } from './types';

/* One service as an applicant reads it: what it is for, whom it concerns, the form, the documents, the fee and the
 * service level — and the application itself, lodged from here against the published definition. GET /services/catalogue/:key,
 * POST /services/requests. */
const kindLabel: Record<string, string> = { VESSEL: 'Vessel', COMPANY: 'Company', SEAFARER: 'Seafarer', PORT_FACILITY: 'Port facility', MET_INSTITUTION: 'MET institution', NONE: '—' };

function Field({ f, value, onChange, ar }: { f: FormField; value: unknown; onChange: (v: unknown) => void; ar: boolean }) {
  const label = ar && f.labelAr ? f.labelAr : f.label;
  if (f.type === 'select' && f.options) return <TextField select fullWidth size="small" label={label} required={f.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} helperText={f.help}>{f.options.map((o) => <MenuItem key={o.value} value={o.value}>{ar && o.labelAr ? o.labelAr : o.label}</MenuItem>)}</TextField>;
  if (f.type === 'boolean' || f.type === 'checkbox') return <FormControlLabel control={<Switch checked={!!value} onChange={(e) => onChange(e.target.checked)} />} label={label} />;
  if (f.type === 'number') return <TextField fullWidth size="small" type="number" label={label} required={f.required} value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} helperText={f.help} />;
  if (f.type === 'date') return <TextField fullWidth size="small" type="date" label={label} required={f.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} InputLabelProps={{ shrink: true }} helperText={f.help} />;
  return <TextField fullWidth size="small" multiline={f.type === 'textarea'} minRows={f.type === 'textarea' ? 3 : undefined} label={label} required={f.required} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} helperText={f.help} />;
}

export default function ServiceDetail() {
  const { key = '' } = useParams(); const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser();
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const [svc, setSvc] = useState<Detail | null>(null);
  const [open, setOpen] = useState(false); const [subjectName, setSubjectName] = useState(''); const [form, setForm] = useState<Record<string, unknown>>({}); const [busy, setBusy] = useState(false); const [draft, setDraft] = useState(false);
  useEffect(() => { setSvc(null); api.get<Detail>(`/services/catalogue/${key}`).then((r) => setSvc(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [key, dispatch]);
  const mayApply = hasPerm(user, 'services.apply') || hasPerm(user, 'services.assess') || hasPerm(user, 'services.manage');
  const feeTotal = svc?.fees?.lines.reduce((s, l) => s + Number(l.amount || 0), 0) ?? svc?.fee.amount ?? 0;
  const apply = async () => {
    if (!svc) return; setBusy(true);
    try {
      const r = await api.post<{ id: string; number: string }>('/services/requests', { definitionKey: svc.key, subjectName: subjectName || null, formData: form, draft });
      dispatch(notify({ message: t('services.applied', { defaultValue: 'Application {{n}} {{what}}', n: r.data.number, what: draft ? t('services.savedDraft', 'saved as a draft') : t('services.lodged', 'lodged') }), severity: 'success' }));
      navigate(`/services/requests/${r.data.id}`);
    } catch (e) { dispatch(notify({ message: (e as Error).message, severity: 'error' })); } finally { setBusy(false); }
  };
  const header = <PageHeader icon={StorefrontRoundedIcon} iconColor="#0E7C86" title={svc ? (ar && svc.nameAr ? svc.nameAr : svc.name) : t('services.service', 'Service')} sub={svc ? `${svc.code} · v${svc.version} · ${svc.category}` : ''} crumbs={[{ label: t('services.catalogueTitle', 'Service catalogue'), to: '/services' }]}
    actions={<Stack direction="row" spacing={1}><OpenLink label={t('services.openRequests', 'Applications')} to={`/services/requests?definition=${key}`} />{mayApply && svc && <Button variant="contained" size="small" startIcon={<SendRoundedIcon />} onClick={() => setOpen(true)} data-testid="apply-button">{t('services.apply', 'Apply')}</Button>}</Stack>} />;
  if (!svc) return <>{header}<Skeleton variant="rounded" height={320} /></>;
  return (
    <>
      {header}
      <Grid container spacing={2} data-testid="service-detail">
        <Grid item xs={12} md={7}>
          <Card sx={{ p: 2, mb: 2 }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.about', 'About this service')}</Typography>
            <Typography variant="body2" sx={{ mb: 1.5 }}>{ar && svc.descriptionAr ? svc.descriptionAr : svc.description}</Typography>
            <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`${t('services.concerns', 'Concerns')}: ${kindLabel[svc.subjectKind] ?? svc.subjectKind}`} />
              <Chip size="small" label={`${t('services.owner', 'Owner')}: ${svc.ownerModule}`} />
              <Chip size="small" label={`${t('services.sla', 'Service level')}: ${svc.sla?.days ?? svc.slaDays} ${t('services.days', 'days')}`} />
              {svc.autoApprovable && <Chip size="small" color="success" variant="outlined" label={t('services.autoLong', 'Decided automatically when every check passes')} />}
              {(svc.outputs?.instrumentType || svc.instrumentType) && <Chip size="small" variant="outlined" label={t('services.issues', { defaultValue: 'Issues {{what}}', what: String(svc.outputs?.instrumentType ?? svc.instrumentType).replace(/_/g, ' ').toLowerCase() })} />}
            </Stack>
          </Card>
          <Card sx={{ p: 2, mb: 2 }} data-testid="service-form">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.formTitle', 'What the application asks')}</Typography>
            <Box component="ol" sx={{ pl: 2.5, m: 0 }}>{svc.form.fields.map((f) => <li key={f.key}><Typography variant="body2">{ar && f.labelAr ? f.labelAr : f.label}{f.required ? ' *' : ''} <Typography component="span" variant="caption" color="text.secondary">· {f.type}{f.optionsFrom ? ` · ${t('services.fromMaster', 'from master')} ${f.optionsFrom}` : ''}</Typography></Typography></li>)}</Box>
          </Card>
          <Card sx={{ p: 2 }} data-testid="service-documents">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.documentsTitle', 'Documents to attach')}</Typography>
            {svc.documents.length ? <Box component="ul" sx={{ pl: 2.5, m: 0 }}>{svc.documents.map((d) => <li key={d.code}><Typography variant="body2">{ar && d.labelAr ? d.labelAr : d.label} {d.required ? <Chip size="small" label={t('services.required', 'required')} sx={{ height: 18, fontSize: 10 }} /> : null}</Typography></li>)}</Box> : <Typography variant="body2" color="text.secondary">{t('services.noDocuments', 'None')}</Typography>}
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 2 }} data-testid="service-fees">
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('services.feesTitle', 'Fee')}</Typography>
            {svc.fees?.lines.length ? svc.fees.lines.map((l) => <Box key={l.code} sx={{ display: 'flex', justifyContent: 'space-between', py: 0.5 }}><Typography variant="body2">{l.description} <Typography component="span" sx={{ fontFamily: MONO, fontSize: 10.5, color: 'text.secondary' }}>{l.code}</Typography></Typography><Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(l.amount)}</Typography></Box>) : <Typography variant="body2" color="text.secondary">{t('services.noFee', 'No fee')}</Typography>}
            <Divider sx={{ my: 1 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography sx={{ fontWeight: 700 }}>{t('services.total', 'Total')}</Typography><Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(feeTotal)}</Typography></Box>
            <Typography variant="caption" color="text.secondary">{t('services.taxNote', { defaultValue: 'Tax at {{pct}}% where a line is taxable · {{currency}}', pct: svc.fee.taxRatePct, currency: svc.fees?.currency ?? svc.fee.currency })}</Typography>
          </Card>
        </Grid>
      </Grid>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('services.applyFor', { defaultValue: 'Apply: {{name}}', name: ar && svc.nameAr ? svc.nameAr : svc.name })}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {svc.subjectKind !== 'NONE' && <TextField fullWidth size="small" label={`${kindLabel[svc.subjectKind] ?? svc.subjectKind}`} value={subjectName} onChange={(e) => setSubjectName(e.target.value)} helperText={t('services.subjectHelp', 'Name the ship, company, seafarer or facility the application concerns')} inputProps={{ 'data-testid': 'apply-subject' }} />}
            {svc.form.fields.map((f) => <Field key={f.key} f={f} value={form[f.key]} onChange={(v) => setForm((s) => ({ ...s, [f.key]: v }))} ar={ar} />)}
            <FormControlLabel control={<Switch checked={draft} onChange={(e) => setDraft(e.target.checked)} />} label={t('services.saveDraft', 'Save as a draft rather than lodging now')} />
          </Stack>
        </DialogContent>
        <DialogActions><Button onClick={() => setOpen(false)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button><Button variant="contained" onClick={apply} disabled={busy} data-testid="apply-submit">{draft ? t('services.saveDraftShort', 'Save draft') : t('services.lodge', 'Lodge application')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
