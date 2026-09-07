import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, MenuItem, Skeleton, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import ModelTrainingRoundedIcon from '@mui/icons-material/ModelTrainingRounded';
import SyncRoundedIcon from '@mui/icons-material/SyncRounded';
import TableViewRoundedIcon from '@mui/icons-material/TableViewRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { fmtDT, fmtDec, fmtNum } from '../../utils/format';
import { MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import StatCard from '../../components/common/StatCard';
import { BucketBars, PanelCard } from '../../components/dashboard/kit';
import type { Artefact, DatasetPreview, FitMetrics, FitRun, RegistryModel, RegistryModelDetail, ServerModel, ServerModelDetail, ServingStats, TrainOutcome } from './models.types';

/* The models, on both their faces.
 *
 * A model has a registry entry on the platform — versions, who validated and approved them, where each is deployed — and
 * fits on the model server: what each version was fitted on, the metrics read off rows it did not see, and what the fit
 * found to matter. This page puts the two side by side, and offers the two things a person may do here: fit a model
 * again on the records that have accrued, which becomes a draft version for someone else to approve, and tell the
 * registry about every fit the server holds. Nothing on this page deploys anything. */

const VERSION_META = { DRAFT: { label: 'Draft', color: 'default' as const }, VALIDATED: { label: 'Validated', color: 'info' as const }, APPROVED: { label: 'Approved', color: 'success' as const }, DEPLOYED: { label: 'Deployed', color: 'success' as const }, RETIRED: { label: 'Retired', color: 'default' as const } };
const RUN_META = { RUNNING: { label: 'Running', color: 'info' as const }, SUCCEEDED: { label: 'Succeeded', color: 'success' as const }, FAILED: { label: 'Failed', color: 'error' as const } };
const cellMono = { fontFamily: MONO, fontSize: 11.5 } as const;
type Form = { featureSet: string; rounds: string; depth: string; learningRate: string; note: string };
const EMPTY_FORM: Form = { featureSet: '', rounds: '', depth: '', learningRate: '', note: '' };

/** Where a deployment is served from, by the scheme of its endpoint. */
const servedBy = (endpoint: string | undefined): 'server' | 'endpoint' | 'pipeline' | 'none' => {
  if (!endpoint) return 'none';
  if (/^ai-models:\/\//i.test(endpoint)) return 'server';
  if (/^https?:\/\//i.test(endpoint)) return 'endpoint';
  return 'pipeline';
};
/** The one figure a reader wants first: how good the fit is, in the terms of its task. */
const headline = (m: FitMetrics | Record<string, unknown> | undefined, unit: string | null | undefined): string => {
  if (!m) return '—';
  const x = m as FitMetrics;
  if (typeof x.auc === 'number') return `AUC ${fmtDec(x.auc, 2)}${typeof x.lift === 'number' ? ` · ${fmtDec(x.lift, 1)}× ${'lift'}` : ''}`;
  if (typeof x.mae === 'number') return `MAE ${fmtDec(x.mae, 1)} ${unit ?? ''}${typeof x.baselineMae === 'number' ? ` (${fmtDec(x.baselineMae, 1)} ${unit ?? ''} by the mean)` : ''}`.trim();
  const r = m as Record<string, unknown>;
  if (typeof r.fieldAccuracy === 'number') return `field accuracy ${fmtDec(r.fieldAccuracy * 100, 0)}%`;
  if (typeof r.wordErrorRate === 'number') return `word error rate ${fmtDec(r.wordErrorRate * 100, 0)}%`;
  return '—';
};

export default function Models() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const dispatch = useAppDispatch();
  const user = useUser();
  const canManage = hasPerm(user, 'models.manage');
  const [registry, setRegistry] = useState<RegistryModel[] | null>(null);
  const [server, setServer] = useState<ServerModel[] | null>(null);
  const [stats, setStats] = useState<ServingStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ registry: RegistryModelDetail; server: ServerModelDetail | null } | null>(null);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [dlg, setDlg] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TrainOutcome | null>(null);

  const fail = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => Promise.all([
    api.get<{ data: RegistryModel[] } | RegistryModel[]>('/ai-platform/models', { params: { limit: 100 } }).then((r) => setRegistry(Array.isArray(r.data) ? r.data : r.data.data)),
    api.get<ServerModel[]>('/ai-models').then((r) => setServer(r.data)),
    api.get<ServingStats>('/ai-platform/serving/stats', { params: { days: 30 } }).then((r) => setStats(r.data)),
  ]).catch((e: Error) => { fail(e); setRegistry((x) => x ?? []); setServer((x) => x ?? []); }), [fail]);
  useEffect(() => { load(); }, [load]);

  const serverByKey = useMemo(() => new Map((server ?? []).map((m) => [m.key, m])), [server]);
  const open = useCallback((key: string) => {
    setSelected(key); setDetail(null); setPreview(null);
    // a fit's outcome stays on the screen while its model is re-read; it goes when another model is opened
    setOutcome((o) => (o && o.artefact.model === key ? o : null));
    const onServer = serverByKey.has(key);
    Promise.all([api.get<RegistryModelDetail>(`/ai-platform/models/${key}`), onServer ? api.get<ServerModelDetail>(`/ai-models/${key}`) : Promise.resolve(null)])
      .then(([r, s]) => setDetail({ registry: r.data, server: s ? s.data : null })).catch((e: Error) => { fail(e); setSelected(null); });
  }, [serverByKey, fail]);

  const loadPreview = () => { if (!selected) return; api.get<DatasetPreview>(`/ai-models/${selected}/dataset`).then((r) => setPreview(r.data)).catch(fail); };
  const train = () => {
    if (!selected) return;
    setBusy(true);
    const body: Record<string, unknown> = { note: form.note };
    if (form.featureSet) body.featureSet = form.featureSet;
    if (form.rounds) body.rounds = Number(form.rounds);
    if (form.depth) body.depth = Number(form.depth);
    if (form.learningRate) body.learningRate = Number(form.learningRate);
    api.post<TrainOutcome>(`/ai-models/${selected}/train`, body)
      .then((r) => { setOutcome(r.data); setDlg(false); dispatch(notify({ message: t('models.trained', { version: r.data.artefact.version, quality: headline(r.data.artefact.metrics, serverByKey.get(selected)?.unit) }), severity: 'success' })); return load().then(() => open(selected)); })
      .catch(fail).finally(() => setBusy(false));
  };
  const reconcile = () => {
    setBusy(true);
    api.post<{ artefacts: number; reported: number }>('/ai-models/reconcile', {})
      .then((r) => { dispatch(notify({ message: t('models.reconciled', { reported: r.data.reported, artefacts: r.data.artefacts }), severity: r.data.reported === r.data.artefacts ? 'success' : 'warning' })); return load().then(() => { if (selected) open(selected); }); })
      .catch(fail).finally(() => setBusy(false));
  };

  const fitted = (server ?? []).filter((m) => m.latest).length;
  const fits = (server ?? []).reduce((s, m) => s + m.runs, 0);
  const sel = detail?.registry ?? null; const srv = detail?.server ?? null;
  const latest: Artefact | null = srv?.artefacts[0] ?? null;
  const importance = latest?.metrics.importance ? Object.entries(latest.metrics.importance).sort((a, b) => b[1] - a[1]) : [];

  return (
    <Box>
      <PageHeader title={t('models.title')} sub={t('models.sub')} icon={ModelTrainingRoundedIcon} iconColor="#75479C"
        actions={canManage ? <Button size="small" variant="outlined" startIcon={<SyncRoundedIcon />} onClick={reconcile} disabled={busy} data-testid="models-reconcile">{t('models.reconcile')}</Button> : undefined} />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><StatCard label={t('models.statRegistered')} value={registry ? fmtNum(registry.length) : '—'} sub={t('models.statRegisteredSub', { n: registry ? registry.filter((m) => Object.keys(m.serving).length > 0).length : 0 })} testId="models-stat-registered" /></Grid>
        <Grid item xs={6} md={3}><StatCard label={t('models.statFitted')} value={server ? fmtNum(fitted) : '—'} sub={t('models.statFittedSub', { n: fits })} testId="models-stat-fitted" /></Grid>
        <Grid item xs={6} md={3}><StatCard label={t('models.statCalls')} value={stats ? fmtNum(stats.calls) : '—'} sub={stats ? t('models.statCallsSub', { pct: fmtDec(stats.withinSlaPct, 1), budget: stats.budgetMs }) : ''} testId="models-stat-calls" /></Grid>
        <Grid item xs={6} md={3}><StatCard label={t('models.statLatency')} value={stats ? `${fmtNum(stats.latencyMs.p95)} ms` : '—'} sub={stats ? t('models.statLatencySub', { p50: fmtNum(stats.latencyMs.p50), server: stats.servers.modelServer }) : ''} testId="models-stat-latency" /></Grid>
      </Grid>

      <Card sx={{ mb: 2 }}>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" data-testid="models-table" aria-label={t('models.title')}>
            <TableHead><TableRow>
              <TableCell>{t('models.colModel')}</TableCell><TableCell>{t('models.colTask')}</TableCell><TableCell>{t('models.colServing')}</TableCell><TableCell>{t('models.colServedBy')}</TableCell>
              <TableCell>{t('models.colLatestFit')}</TableCell><TableCell>{t('models.colQuality')}</TableCell><TableCell align="right">{t('models.colRows')}</TableCell><TableCell>{t('models.colLastFitted')}</TableCell>
            </TableRow></TableHead>
            <TableBody>
              {registry === null && Array.from({ length: 4 }).map((_, i) => <TableRow key={i}><TableCell colSpan={8}><Skeleton /></TableCell></TableRow>)}
              {registry?.map((m) => {
                const s = serverByKey.get(m.key); const fit = s?.latest ?? null;
                const env = (['PROD', 'UAT', 'DEV'] as const).find((e) => m.serving[e] !== undefined);
                const by = s ? 'server' : 'pipeline';
                return (
                  <TableRow key={m.key} hover selected={selected === m.key} onClick={() => open(m.key)} sx={{ cursor: 'pointer' }} data-testid={`model-row-${m.key}`}>
                    <TableCell><Typography variant="body2" fontWeight={600}>{ar && m.nameAr ? m.nameAr : m.name}</Typography><Typography variant="caption" sx={cellMono} color="text.secondary">{m.key}</Typography></TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={m.task} sx={{ height: 22, fontSize: 11 }} /></TableCell>
                    <TableCell>{env ? <Chip size="small" color="success" label={`${env} · v${m.serving[env]}`} sx={{ height: 22, fontSize: 11 }} /> : <Typography variant="caption" color="text.secondary">{t('models.notServing')}</Typography>}</TableCell>
                    <TableCell><Typography variant="caption">{t(by === 'server' ? 'models.byServer' : 'models.byPipeline')}</Typography></TableCell>
                    <TableCell>{fit ? <Typography variant="body2" sx={cellMono}>v{fit.version} · {fit.featureSet ?? ''}</Typography> : <Typography variant="caption" color="text.secondary">{t('models.noFit')}</Typography>}</TableCell>
                    <TableCell><Typography variant="body2">{fit ? headline(fit.metrics, s?.unit) : '—'}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" sx={cellMono}>{fit?.metrics.rows !== undefined ? fmtNum(fit.metrics.rows) : '—'}</Typography></TableCell>
                    <TableCell><Typography variant="caption">{fit ? fmtDT(fit.createdAt) : '—'}</Typography></TableCell>
                  </TableRow>
                );
              })}
              {registry?.length === 0 && <TableRow><TableCell colSpan={8}><Typography variant="body2" color="text.secondary">{t('models.empty')}</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {selected && !detail && <Skeleton variant="rounded" height={240} />}
      {sel && (
        <Box data-testid="model-detail">
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Typography variant="h6">{ar && sel.nameAr ? sel.nameAr : sel.name}</Typography>
            <Chip size="small" variant="outlined" label={sel.task} sx={{ height: 22, fontSize: 11 }} />
            <Chip size="small" variant="outlined" label={`${sel.residency.region}`} sx={{ height: 22, fontSize: 11 }} />
            <Box sx={{ flex: 1 }} />
            {srv && <Button size="small" variant="outlined" startIcon={<TableViewRoundedIcon />} onClick={loadPreview} data-testid="model-preview-dataset">{t('models.previewDataset')}</Button>}
            {srv && canManage && <Button size="small" variant="contained" startIcon={<ModelTrainingRoundedIcon />} onClick={() => { setForm({ ...EMPTY_FORM, featureSet: srv.featureSets[srv.featureSets.length - 1]?.name ?? '' }); setDlg(true); }} data-testid="model-train">{t('models.fitAgain')}</Button>}
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{ar && sel.purposeAr ? sel.purposeAr : sel.purpose}</Typography>
          {outcome && (
            <Alert severity={outcome.registry && !outcome.registry.ok ? 'warning' : 'success'} sx={{ mb: 2 }} data-testid="model-train-outcome">
              {t('models.trainedDetail', { version: outcome.artefact.version, rows: fmtNum(outcome.dataset.rows), quality: headline(outcome.artefact.metrics, srv?.unit), ms: fmtNum(outcome.run.durationMs ?? 0) })}
              {' '}{outcome.registry ? (outcome.registry.ok ? t('models.registryOk', { version: outcome.registry.version, status: outcome.registry.status }) : t('models.registryFailed', { error: outcome.registry.error })) : ''}
            </Alert>
          )}
          {!srv && <Alert severity="info" sx={{ mb: 2 }}>{t('models.pipelineOnly')}</Alert>}
          <Grid container spacing={2}>
            <Grid item xs={12} lg={6}>
              <PanelCard title={t('models.versions')} sub={t('models.versionsSub')} testId="model-versions">
                <TableContainer sx={{ overflowX: 'auto' }}><Table size="small"><TableHead><TableRow>
                  <TableCell>{t('models.colVersion')}</TableCell><TableCell>{t('models.colStatus')}</TableCell><TableCell>{t('models.colQuality')}</TableCell><TableCell>{t('models.colNote')}</TableCell><TableCell>{t('models.colBy')}</TableCell>
                </TableRow></TableHead><TableBody>
                  {sel.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell><Typography variant="body2" sx={cellMono}>v{v.version}</Typography></TableCell>
                      <TableCell><StatusChip value={v.status} map={VERSION_META} /></TableCell>
                      <TableCell><Typography variant="body2">{headline(v.metrics, srv?.unit)}</Typography></TableCell>
                      <TableCell><Typography variant="caption">{v.changeNote}</Typography></TableCell>
                      <TableCell><Typography variant="caption">{v.createdBy ?? '—'}{v.approvedBy ? ` · ${t('models.approvedBy', { name: v.approvedBy })}` : ''}</Typography></TableCell>
                    </TableRow>
                  ))}
                </TableBody></Table></TableContainer>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('models.deployments')}</Typography>
                {sel.deployments.filter((d) => d.status === 'ACTIVE').map((d) => (
                  <Typography key={d.id} variant="body2" sx={{ mb: 0.25 }}>
                    <b>{d.environment}</b> · v{d.version} · {t(servedBy(d.endpoint) === 'server' ? 'models.byServer' : servedBy(d.endpoint) === 'endpoint' ? 'models.byEndpoint' : 'models.byPipeline')} · <span style={cellMono}>{d.endpoint || '—'}</span>
                  </Typography>
                ))}
                {sel.deployments.filter((d) => d.status === 'ACTIVE').length === 0 && <Typography variant="caption" color="text.secondary">{t('models.notServing')}</Typography>}
              </PanelCard>
            </Grid>
            <Grid item xs={12} lg={6}>
              {srv && (
                <PanelCard title={t('models.fit')} sub={srv.label} testId="model-fit">
                  {latest ? (
                    <>
                      <Typography variant="body2" sx={{ mb: 1 }}>{t('models.latestFitLine', { version: latest.version, set: latest.featureSet ?? '', rows: fmtNum(latest.metrics.rows ?? 0), heldOut: fmtNum(latest.metrics.heldOut ?? 0), trees: latest.trees })}</Typography>
                      <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }} data-testid="model-fit-headline">{headline(latest.metrics, srv.unit)}</Typography>
                      {latest.task === 'CLASSIFICATION' && typeof latest.metrics.positiveRate === 'number' && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t('models.targetingLine', { rate: fmtDec(latest.metrics.positiveRate * 100, 0), precision: fmtDec((latest.metrics.precisionAtBaseRate ?? 0) * 100, 0) })}</Typography>}
                      {latest.task === 'REGRESSION' && typeof latest.metrics.r2 === 'number' && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t('models.regressionLine', { r2: fmtDec(latest.metrics.r2, 2), std: fmtDec(latest.metrics.labelStd ?? 0, 1), unit: srv.unit ?? '' })}</Typography>}
                      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('models.importance')}</Typography>
                      <BucketBars rows={importance.map(([name, v]) => ({ label: name, value: v, display: `${fmtDec(v * 100, 0)}%`, sub: srv.features.find((f) => f.name === name)?.description }))} max={importance[0]?.[1] ?? 1} testId="model-importance" />
                    </>
                  ) : <Typography variant="body2" color="text.secondary">{t('models.noFit')}</Typography>}
                  <Divider sx={{ my: 1.5 }} />
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>{t('models.features')}</Typography>
                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
                    {srv.features.map((f) => <Tooltip key={f.name} title={f.description} arrow><Chip size="small" variant="outlined" label={`${f.name} · ${f.kind}`} sx={{ height: 22, fontSize: 11 }} /></Tooltip>)}
                  </Stack>
                  {preview && (
                    <Box sx={{ mt: 1.5 }} data-testid="model-dataset-preview">
                      <Typography variant="subtitle2">{t('models.datasetNow')}</Typography>
                      <Typography variant="body2">{t('models.datasetLine', { rows: fmtNum(preview.rows), set: preview.featureSet, positives: preview.positives === null ? '—' : fmtNum(preview.positives), mean: fmtDec(preview.labelMean, 2), std: fmtDec(preview.labelStd, 2) })}</Typography>
                      <Typography variant="caption" color="text.secondary">{preview.schema.map((f) => `${f.name}: ${f.kind === 'num' ? `${t('models.median')} ${fmtDec(f.median ?? 0, 1)}` : `${(f.categories ?? []).length} ${t('models.categories')}`}`).join(' · ')}</Typography>
                    </Box>
                  )}
                </PanelCard>
              )}
            </Grid>
            {srv && (
              <Grid item xs={12}>
                <PanelCard title={t('models.runs')} sub={t('models.runsSub')} testId="model-runs">
                  <TableContainer sx={{ overflowX: 'auto' }}><Table size="small"><TableHead><TableRow>
                    <TableCell>{t('models.colStarted')}</TableCell><TableCell>{t('models.colBy')}</TableCell><TableCell>{t('models.colStatus')}</TableCell><TableCell>{t('models.colVersion')}</TableCell><TableCell>{t('models.colQuality')}</TableCell><TableCell>{t('models.colParams')}</TableCell><TableCell align="right">{t('models.colDuration')}</TableCell><TableCell>{t('models.colRegistry')}</TableCell>
                  </TableRow></TableHead><TableBody>
                    {srv.runs.map((r: FitRun) => (
                      <TableRow key={r.id}>
                        <TableCell><Typography variant="caption">{fmtDT(r.startedAt)}</Typography></TableCell>
                        <TableCell><Typography variant="caption">{r.initiatedBy}</Typography></TableCell>
                        <TableCell><StatusChip value={r.status} map={RUN_META} /></TableCell>
                        <TableCell><Typography variant="body2" sx={cellMono}>{r.version ? `v${r.version}` : '—'}</Typography></TableCell>
                        <TableCell><Typography variant="body2">{r.status === 'SUCCEEDED' ? headline(r.metrics, srv.unit) : r.error ?? '—'}</Typography></TableCell>
                        <TableCell><Typography variant="caption" sx={cellMono}>{['featureSet', 'rounds', 'depth', 'learningRate'].map((k) => `${k}=${String(r.params[k] ?? '')}`).join(' ')}</Typography></TableCell>
                        <TableCell align="right"><Typography variant="caption" sx={cellMono}>{r.durationMs === null ? '—' : `${fmtNum(r.durationMs)} ms`}</Typography></TableCell>
                        <TableCell><Typography variant="caption">{r.registryVersion ? t('models.registryVersion', { version: r.registryVersion }) : r.status === 'SUCCEEDED' ? t('models.registryPending') : '—'}</Typography></TableCell>
                      </TableRow>
                    ))}
                    {srv.runs.length === 0 && <TableRow><TableCell colSpan={8}><Typography variant="caption" color="text.secondary">{t('models.noRuns')}</Typography></TableCell></TableRow>}
                  </TableBody></Table></TableContainer>
                </PanelCard>
              </Grid>
            )}
          </Grid>
        </Box>
      )}

      <Dialog open={dlg} onClose={() => setDlg(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t('models.fitAgainTitle', { name: sel ? (ar && sel.nameAr ? sel.nameAr : sel.name) : '' })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('models.fitAgainSub', { rows: srv?.datasets[0]?.rows ?? srv?.latest?.metrics.rows ?? 0 })}</Typography>
          <Stack spacing={2}>
            <TextField select size="small" label={t('models.featureSet')} value={form.featureSet} onChange={(e) => setForm({ ...form, featureSet: e.target.value })} inputProps={{ 'data-testid': 'train-feature-set' }}>
              {(srv?.featureSets ?? []).map((f) => <MenuItem key={f.name} value={f.name}>{f.name} — {f.note}</MenuItem>)}
            </TextField>
            <Stack direction="row" spacing={2}>
              <TextField size="small" label={t('models.rounds')} value={form.rounds} placeholder={String(srv?.defaults.rounds ?? '')} onChange={(e) => setForm({ ...form, rounds: e.target.value.replace(/[^0-9]/g, '') })} inputProps={{ 'data-testid': 'train-rounds', inputMode: 'numeric' }} />
              <TextField size="small" label={t('models.depth')} value={form.depth} placeholder={String(srv?.defaults.depth ?? '')} onChange={(e) => setForm({ ...form, depth: e.target.value.replace(/[^0-9]/g, '') })} inputProps={{ inputMode: 'numeric' }} />
              <TextField size="small" label={t('models.learningRate')} value={form.learningRate} placeholder={String(srv?.defaults.learningRate ?? '')} onChange={(e) => setForm({ ...form, learningRate: e.target.value.replace(/[^0-9.]/g, '') })} inputProps={{ inputMode: 'decimal' }} />
            </Stack>
            <TextField size="small" label={t('models.note')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} inputProps={{ 'data-testid': 'train-note', maxLength: 500 }} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDlg(false)}>{t('models.cancel')}</Button>
          <Button variant="contained" onClick={train} disabled={busy} data-testid="train-confirm">{t('models.run')}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
