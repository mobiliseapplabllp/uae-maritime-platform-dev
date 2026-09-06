import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, LinearProgress, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DesignServicesRoundedIcon from '@mui/icons-material/DesignServicesRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import { OpenLink } from '../../components/dashboard/kit';
import { MONO } from '../../theme';
import type { Definition } from './types';

/* The Service Studio — every service definition and its versions through DEV, UAT and PROD: draft → in review →
 * approved → published, promoted environment by environment, each step recorded and the content validated before it
 * moves. A draft's content is edited here as the JSON the runtime executes; the visual builder over the same content is
 * scheduled after it. GET /services/definitions, the version routes behind it. */
type Summary = { version: number; environment: string; status: string; changeNote: string; publishedAt: string | null; updatedAt: string };
type Row = Definition & { versions: Summary[] };
type Version = { id: string; version: number; environment: string; status: string; form: unknown; documents: unknown; fees: unknown; sla: unknown; workflow: unknown; outputs: unknown; changeNote?: string; validation?: { problems: { path: string; message: string; severity: string }[] } };
const ENVS = ['DEV', 'UAT', 'PROD'] as const;
const STATUS_COLOR: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = { DRAFT: 'default', IN_REVIEW: 'warning', APPROVED: 'info', PUBLISHED: 'success', RETIRED: 'error' };
const SECTIONS = ['form', 'documents', 'fees', 'sla', 'workflow', 'outputs'] as const;

export default function ServiceStudio() {
  const { t } = useTranslation(); const dispatch = useAppDispatch(); const user = useUser();
  const manage = hasPerm(user, 'services.manage');
  const [rows, setRows] = useState<Row[] | null>(null); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ def: Row; ver: Version } | null>(null); const [section, setSection] = useState<(typeof SECTIONS)[number]>('form'); const [json, setJson] = useState(''); const [jsonError, setJsonError] = useState<string | null>(null);
  const [promote, setPromote] = useState<{ def: Row; version: number; to: 'UAT' | 'PROD' } | null>(null);
  const load = useCallback(() => api.get<Row[]>('/services/definitions', { params: { limit: 200, sort: 'name', q: q || undefined } }).then((r) => setRows(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [q, dispatch]);
  useEffect(() => { load(); }, [load]);
  const fail = (e: unknown) => dispatch(notify({ message: (e as Error).message, severity: 'error' }));
  const run = async (fn: () => Promise<unknown>, done: string) => { setBusy(true); try { await fn(); dispatch(notify({ message: done, severity: 'success' })); await load(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const inspect = async (def: Row, s: Summary) => {
    try { const r = await api.get<Version>(`/services/definitions/${def.id}/versions/${s.version}`, { params: { environment: s.environment } }); setOpen({ def, ver: r.data }); setSection('form'); setJson(JSON.stringify(r.data.form, null, 2)); setJsonError(null); } catch (e) { fail(e); }
  };
  const showSection = (s: (typeof SECTIONS)[number]) => { if (!open) return; setSection(s); setJson(JSON.stringify(open.ver[s] ?? null, null, 2)); setJsonError(null); };
  const save = () => { if (!open) return; let parsed: unknown; try { parsed = JSON.parse(json); } catch (e) { setJsonError((e as Error).message); return; }
    run(async () => { const r = await api.put<Version>(`/services/definitions/${open.def.id}/versions/${open.ver.version}`, { [section]: parsed, environment: open.ver.environment }); setOpen({ def: open.def, ver: r.data }); }, t('studio.saved', 'Draft saved')); };
  const step = (def: Row, v: Summary, what: 'submit-review' | 'approve' | 'publish' | 'reopen' | 'retire') => run(() => api.post(`/services/definitions/${def.id}/versions/${v.version}/${what}`, { environment: v.environment }), t('studio.stepDone', { defaultValue: 'Version {{v}} {{env}}: {{what}}', v: v.version, env: v.environment, what: what.replace('-', ' ') }));
  const newDraft = (def: Row) => run(() => api.post(`/services/definitions/${def.id}/versions`, {}), t('studio.draftOpened', 'New draft opened in DEV'));
  const doPromote = () => promote && run(() => api.post(`/services/definitions/${promote.def.id}/versions/${promote.version}/promote`, { to: promote.to }), t('studio.promoted', { defaultValue: 'Version {{v}} promoted to {{to}}', v: promote.version, to: promote.to })).then(() => setPromote(null));
  const cell = (def: Row, env: string) => {
    const list = def.versions.filter((v) => v.environment === env).sort((a, b) => b.version - a.version);
    if (!list.length) return <Typography variant="caption" color="text.disabled">—</Typography>;
    return <Stack spacing={0.5}>{list.slice(0, 2).map((v) => (
      <Stack key={`${v.version}-${v.environment}`} direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Chip size="small" clickable onClick={() => inspect(def, v)} label={`v${v.version} · ${v.status.replace('_', ' ').toLowerCase()}`} color={STATUS_COLOR[v.status] ?? 'default'} variant={v.status === 'PUBLISHED' ? 'filled' : 'outlined'} sx={{ height: 20, fontSize: 10.5 }} data-testid={`ver-${def.key}-${v.environment}-${v.version}`} />
        {manage && v.status === 'DRAFT' && env === 'DEV' && <Button size="small" sx={{ minWidth: 0, px: 0.5, fontSize: 10.5 }} disabled={busy} onClick={() => step(def, v, 'submit-review')}>{t('studio.submit', 'Submit')}</Button>}
        {manage && v.status === 'IN_REVIEW' && <Button size="small" sx={{ minWidth: 0, px: 0.5, fontSize: 10.5 }} disabled={busy} onClick={() => step(def, v, 'approve')}>{t('studio.approve', 'Approve')}</Button>}
        {manage && v.status === 'APPROVED' && <Button size="small" sx={{ minWidth: 0, px: 0.5, fontSize: 10.5 }} disabled={busy} onClick={() => step(def, v, 'publish')}>{t('studio.publish', 'Publish')}</Button>}
        {manage && v.status === 'PUBLISHED' && env !== 'PROD' && <Button size="small" sx={{ minWidth: 0, px: 0.5, fontSize: 10.5 }} disabled={busy} onClick={() => setPromote({ def, version: v.version, to: env === 'DEV' ? 'UAT' : 'PROD' })}>{t('studio.promoteTo', { defaultValue: 'Promote → {{to}}', to: env === 'DEV' ? 'UAT' : 'PROD' })}</Button>}
      </Stack>))}</Stack>;
  };
  const shown = rows ?? [];
  const problems = open?.ver.validation?.problems ?? [];
  return (
    <>
      <PageHeader icon={DesignServicesRoundedIcon} iconColor="#0E7C86" title={t('studio.title', 'Service Studio')} sub={t('studio.sub', 'Definitions and their versions through DEV, UAT and PROD — drafted, reviewed, approved, published and promoted, every step recorded')}
        actions={<Stack direction="row" spacing={1}><OpenLink label={t('services.catalogueTitle', 'Service catalogue')} to="/services" /><OpenLink label={t('services.openRequests', 'Applications')} to="/services/requests" /></Stack>} />
      <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}><TextField size="small" placeholder={t('studio.search', 'Search definitions')} value={q} onChange={(e) => setQ(e.target.value)} inputProps={{ 'aria-label': t('studio.search', 'Search definitions'), 'data-testid': 'studio-search' }} sx={{ minWidth: 260 }} />{rows && <Chip label={t('studio.count', { defaultValue: '{{n}} definitions', n: rows.length })} />}</Stack>
      {busy && <LinearProgress sx={{ mb: 1 }} />}
      <Card>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label={t('studio.title', 'Service Studio')} data-testid="studio-table">
            <TableHead><TableRow><TableCell>{t('studio.service', 'Service')}</TableCell><TableCell>{t('studio.category', 'Category')}</TableCell>{ENVS.map((e) => <TableCell key={e}>{e}</TableCell>)}<TableCell align="right" /></TableRow></TableHead>
            <TableBody>
              {shown.map((d) => (
                <TableRow key={d.id} hover data-testid={`def-${d.key}`}>
                  <TableCell><Typography sx={{ fontWeight: 600, fontSize: 13 }}>{d.name}</Typography><Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: 'text.secondary' }}>{d.code} · {d.key}{d.autoApprovable ? ` · ${t('services.auto', 'Auto')}` : ''}</Typography></TableCell>
                  <TableCell><Typography variant="body2">{d.category}</Typography><Typography variant="caption" color="text.secondary">{d.subjectKind.replace(/_/g, ' ').toLowerCase()}{d.issuesInstrument ? ` · ${d.issuesInstrument.replace(/_/g, ' ').toLowerCase()}` : ''}</Typography></TableCell>
                  {ENVS.map((e) => <TableCell key={e}>{cell(d, e)}</TableCell>)}
                  <TableCell align="right">{manage && <Button size="small" disabled={busy} onClick={() => newDraft(d)} data-testid={`draft-${d.key}`}>{t('studio.newDraft', 'New draft')}</Button>}</TableCell>
                </TableRow>
              ))}
              {rows && !rows.length && <TableRow><TableCell colSpan={6}><Typography color="text.secondary">{t('studio.none', 'No definitions match')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      <Drawer anchor="right" open={!!open} onClose={() => setOpen(null)} PaperProps={{ sx: { width: { xs: '100%', md: 640 }, p: 2 } }}>
        {open && <>
          <Typography variant="h6" sx={{ fontSize: 15 }}>{open.def.name} · v{open.ver.version} {open.ver.environment}</Typography>
          <Typography variant="caption" color="text.secondary">{open.ver.status.replace('_', ' ').toLowerCase()}{open.ver.changeNote ? ` · ${open.ver.changeNote}` : ''}</Typography>
          <Stack direction="row" spacing={0.5} sx={{ my: 1.5, flexWrap: 'wrap' }} useFlexGap>{SECTIONS.map((s) => <Chip key={s} label={s} clickable color={section === s ? 'primary' : 'default'} onClick={() => showSection(s)} size="small" />)}</Stack>
          {problems.length > 0 && <Alert severity={problems.some((p) => p.severity === 'ERROR') ? 'error' : 'warning'} sx={{ mb: 1 }}>{problems.map((p) => `${p.path}: ${p.message}`).join(' · ')}</Alert>}
          <TextField fullWidth multiline minRows={18} value={json} onChange={(e) => setJson(e.target.value)} InputProps={{ sx: { fontFamily: MONO, fontSize: 12 } }} inputProps={{ 'data-testid': 'studio-json', readOnly: !(manage && open.ver.status === 'DRAFT') }} error={!!jsonError} helperText={jsonError ?? (manage && open.ver.status === 'DRAFT' ? t('studio.editable', 'A draft in DEV is editable; the runtime validates it on save') : t('studio.readOnly', 'Read only: only a draft in DEV can be edited'))} />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} justifyContent="flex-end">
            {manage && open.ver.status === 'DRAFT' && <Button variant="contained" size="small" disabled={busy} onClick={save} data-testid="studio-save">{t('studio.save', 'Save section')}</Button>}
            {manage && (open.ver.status === 'IN_REVIEW' || open.ver.status === 'APPROVED') && <Button size="small" disabled={busy} onClick={() => step(open.def, { version: open.ver.version, environment: open.ver.environment, status: open.ver.status, changeNote: '', publishedAt: null, updatedAt: '' }, 'reopen').then(() => setOpen(null))}>{t('studio.reopen', 'Reopen as draft')}</Button>}
            <Button size="small" onClick={() => setOpen(null)}>{t('common.close', 'Close')}</Button>
          </Stack>
        </>}
      </Drawer>
      <Dialog open={!!promote} onClose={() => setPromote(null)}>
        <DialogTitle>{t('studio.promoteTitle', 'Promote a published version')}</DialogTitle>
        <DialogContent><Typography variant="body2">{promote && t('studio.promoteBody', { defaultValue: 'Version {{v}} of {{name}} will be copied into {{to}} as a published version. The content is validated before it moves.', v: promote.version, name: promote.def.name, to: promote.to })}</Typography>
          <TextField select size="small" sx={{ mt: 2 }} label={t('studio.to', 'To')} value={promote?.to ?? 'UAT'} onChange={(e) => promote && setPromote({ ...promote, to: e.target.value as 'UAT' | 'PROD' })}><MenuItem value="UAT">UAT</MenuItem><MenuItem value="PROD">PROD</MenuItem></TextField></DialogContent>
        <DialogActions><Button onClick={() => setPromote(null)}>{t('common.cancel', 'Cancel')}</Button><Button variant="contained" onClick={doPromote} disabled={busy} data-testid="promote-confirm">{t('studio.promote', 'Promote')}</Button></DialogActions>
      </Dialog>
      <Box sx={{ mt: 1 }}><Typography variant="caption" color="text.secondary">{t('studio.footnote', 'Applicants see PROD; UAT is for acceptance; DEV is where a change is drafted.')}</Typography></Box>
    </>
  );
}
