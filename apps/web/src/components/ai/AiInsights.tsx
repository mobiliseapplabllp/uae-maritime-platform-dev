import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import api from '../../api/client';
import { internalPath } from '../../utils/navigation';

/* The module's insights: what its own figures say a person should look at next, computed by the agent service from the
 * dashboard read through the tool gateway as this person. An action runs the same way — as them, logged as theirs —
 * so a button here never does anything the person could not do on the module's own screens.
 *
 * The panel is a band that spans the dashboard: one short card per insight, side by side, so it never sets the
 * height of the tiles around it. Up to six insights are shown (three when compact); the rest are counted. */

export type Severity = 'info' | 'warning' | 'critical';
export interface InsightAction { tool: string; args: Record<string, unknown>; label: string; labelAr: string; tier: 'READ' | 'ACT' }
export interface Insight {
  id: string; module: string; severity: Severity; title: string; titleAr: string; detail: string; detailAr: string;
  metric?: { label: string; value: number | string; target?: number | string; format?: 'count' | 'money' | 'hours' | 'pct' | 'days' };
  link?: string; action?: InsightAction;
}
export interface InsightsPayload { module: string; generatedAt: string; source: string; insights: Insight[]; counts?: { critical: number; warning: number; info: number }; refused?: { code?: string; reason?: string } }
interface RunResult { outcome: 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN'; tool: string; tier: string; code?: string; reason?: string; data?: unknown; callId?: string; latencyMs?: number }

const COLOUR: Record<Severity, string> = { critical: '#9E3A25', warning: '#8A5200', info: '#2F6FB6' }; // each ≥ 5:1 on its chip background
const PREFERRED = ['number', 'vcn', 'licenseNo', 'name', 'vesselName', 'subjectName', 'entityName', 'title', 'definitionName', 'billTo', 'status', 'severity', 'type', 'typeLabel', 'rank', 'roleName', 'department', 'email', 'dueAt', 'expiryDate', 'daysToExpiry', 'daysOverdue', 'total', 'balance', 'amount', 'lastLoginAt', 'category', 'berthCode', 'eta'];
const fmtVal = (v: unknown) => { if (v == null) return '—'; if (typeof v === 'number') return v.toLocaleString('en-AE', { maximumFractionDigits: 1 }); const s = String(v); return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s; };
const fmtMetric = (m: NonNullable<Insight['metric']>) => { const v = m.value; if (typeof v !== 'number') return String(v); if (m.format === 'money') return `AED ${Math.round(v).toLocaleString('en-AE')}`; if (m.format === 'pct') return `${Math.round(v)}%`; if (m.format === 'hours') return `${v.toFixed(1)} h`; if (m.format === 'days') return `${v.toFixed(v % 1 ? 1 : 0)} d`; return v.toLocaleString('en-AE', { maximumFractionDigits: 1 }); };
/** The rows a READ action's answer carries, whatever shape the module returned them in. */
export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.items)) return d.items as Record<string, unknown>[];
    for (const k of ['rows', 'list', 'arrivals', 'overdueList', 'alertList', 'renewals']) if (Array.isArray(d[k])) return d[k] as Record<string, unknown>[];
    return [d];
  }
  return [];
}
export const columnsOf = (rows: Record<string, unknown>[]) => { const first = rows[0] ?? {}; const cols = PREFERRED.filter((k) => k in first && typeof first[k] !== 'object'); return (cols.length ? cols : Object.keys(first).filter((k) => typeof first[k] !== 'object')).slice(0, 6); };

export default function AiInsights({ module, compact = false }: { module: string; compact?: boolean }) {
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const navigate = useNavigate();
  const [data, setData] = useState<InsightsPayload | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ insight: Insight; run: RunResult } | null>(null);
  const [confirm, setConfirm] = useState<Insight | null>(null);
  const load = useCallback(() => {
    setLoading(true); setError(null);
    api.get<InsightsPayload>(`/agents/insights/${module}`, { headers: { 'X-Quiet': '1' } }).then((r) => setData(r.data)).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [module]);
  useEffect(() => { load(); }, [load]);

  const act = (insight: Insight) => {
    if (!insight.action) return;
    setRunning(insight.id); setConfirm(null);
    api.post<RunResult>('/agents/insights/act', { module, insightId: insight.id, tool: insight.action.tool, args: insight.action.args })
      .then((r) => { setResult({ insight, run: r.data }); if (insight.action?.tier === 'ACT' && r.data.outcome === 'OK') load(); })
      .catch((e: Error) => setResult({ insight, run: { outcome: 'FAILED', tool: insight.action!.tool, tier: insight.action!.tier, reason: e.message } }))
      .finally(() => setRunning(null));
  };

  const insights = data?.insights ?? [];
  const limit = compact ? 3 : 6;
  const shown = insights.slice(0, limit);
  const columns = { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', lg: `repeat(${Math.min(3, Math.max(1, shown.length))}, minmax(0, 1fr))` };
  return (
    <Card variant="outlined" data-testid={`ai-insights-${module}`}>
      <CardContent sx={{ p: 2, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.25 }} flexWrap="wrap" useFlexGap>
          <AutoAwesomeRoundedIcon sx={{ fontSize: 18, color: '#75479C' }} />
          <Typography sx={{ fontWeight: 700, fontSize: 13.5 }}>{t('ai.insights.title', 'Insights and next actions')}</Typography>
          {data?.counts && !loading && (
            <Stack direction="row" spacing={0.5}>
              {data.counts.critical > 0 && <Chip size="small" label={`${data.counts.critical} ${t('ai.insights.critical', 'critical')}`} sx={{ height: 20, fontSize: 10.5, bgcolor: '#FBE9E5', color: COLOUR.critical, fontWeight: 700 }} />}
              {data.counts.warning > 0 && <Chip size="small" label={`${data.counts.warning} ${t('ai.insights.warning', 'to watch')}`} sx={{ height: 20, fontSize: 10.5, bgcolor: '#FFF3E0', color: COLOUR.warning, fontWeight: 700 }} />}
            </Stack>
          )}
          <Box sx={{ flex: 1 }} />
          {!loading && data && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{t('ai.insights.footer', 'Read through the tool gateway as you, from the module\'s own figures.')}</Typography>}
          <Tooltip title={t('ai.insights.refresh', 'Read the figures again')}><span><IconButton size="small" onClick={load} disabled={loading} aria-label={t('ai.insights.refresh', 'Read the figures again')}><RefreshRoundedIcon sx={{ fontSize: 16 }} /></IconButton></span></Tooltip>
        </Stack>
        {loading && <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={88} />)}</Box>}
        {!loading && error && <Alert severity="warning" sx={{ fontSize: 12.5 }}>{t('ai.insights.unavailable', 'Insights could not be read just now.')} {error}</Alert>}
        {!loading && !error && data?.refused && <Alert severity="info" sx={{ fontSize: 12.5 }} data-testid="ai-insights-refused">{t('ai.insights.refused', 'The insights for this module are outside your permissions.')} {data.refused.reason}</Alert>}
        {!loading && !error && !data?.refused && insights.length === 0 && <Alert severity="success" sx={{ fontSize: 12.5 }} data-testid="ai-insights-clear">{t('ai.insights.clear', 'Nothing needs attention: every figure is within its target.')}</Alert>}
        {!loading && !error && shown.length > 0 && (
          <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0, display: 'grid', gap: 1.25, gridTemplateColumns: columns, alignItems: 'stretch' }}>
            {shown.map((i) => (
              <Box component="li" key={i.id} data-testid={`insight-${i.id}`} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, p: 1.25, borderRadius: 1.5, bgcolor: 'action.hover', minWidth: 0 }}>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', mt: 0.7, flexShrink: 0, bgcolor: COLOUR[i.severity] }} />
                  <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>{ar ? i.titleAr || i.title : i.title}</Typography>
                </Stack>
                <Typography sx={{ fontSize: 12.25, color: 'text.secondary', lineHeight: 1.45, pl: 2 }}>{ar ? i.detailAr || i.detail : i.detail}</Typography>
                <Stack direction="row" spacing={0.75} sx={{ mt: 'auto', pt: 0.5, pl: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
                  {i.metric && <Chip size="small" label={`${i.metric.label}: ${fmtMetric(i.metric)}${i.metric.target !== undefined ? ` · ${t('ai.insights.target', 'target')} ${typeof i.metric.target === 'number' ? fmtMetric({ ...i.metric, value: i.metric.target }) : i.metric.target}` : ''}`} sx={{ height: 20, fontSize: 10.5, maxWidth: '100%' }} />}
                  {i.link && <Button size="small" variant="text" startIcon={<OpenInNewRoundedIcon sx={{ fontSize: 13 }} />} onClick={() => navigate(internalPath(i.link!))} sx={{ fontSize: 11.5, minHeight: 0, py: 0.1 }}>{t('ai.insights.open', 'Open')}</Button>}
                  {i.action && (
                    <Button size="small" variant={i.action.tier === 'ACT' ? 'contained' : 'outlined'} color={i.action.tier === 'ACT' ? 'primary' : 'inherit'} disabled={running === i.id}
                      startIcon={running === i.id ? <CircularProgress size={12} /> : <PlayArrowRoundedIcon sx={{ fontSize: 13 }} />}
                      onClick={() => (i.action!.tier === 'ACT' ? setConfirm(i) : act(i))} data-testid={`insight-action-${i.id}`} sx={{ fontSize: 11.5, minHeight: 0, py: 0.2 }}>
                      {ar ? i.action.labelAr || i.action.label : i.action.label}
                    </Button>
                  )}
                </Stack>
              </Box>
            ))}
          </Box>
        )}
        {!loading && !error && insights.length > limit && <Typography sx={{ mt: 1, fontSize: 11, color: 'text.secondary' }} data-testid="ai-insights-more">{t('ai.insights.more', { defaultValue: '{{n}} more not shown', n: insights.length - limit })}</Typography>}
      </CardContent>

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 15 }}>{confirm ? (ar ? confirm.action?.labelAr || confirm.action?.label : confirm.action?.label) : ''}</DialogTitle>
        <DialogContent><Typography sx={{ fontSize: 13 }}>{t('ai.insights.confirm', 'This changes a record in your name and is logged at the tool gateway. Continue?')}</Typography></DialogContent>
        <DialogActions><Button onClick={() => setConfirm(null)}>{t('common.cancel', 'Cancel')}</Button><Button variant="contained" onClick={() => confirm && act(confirm)} data-testid="insight-confirm">{t('ai.insights.proceed', 'Yes, do it')}</Button></DialogActions>
      </Dialog>

      <Dialog open={!!result} onClose={() => setResult(null)} maxWidth="md" fullWidth data-testid="insight-result">
        <DialogTitle sx={{ fontSize: 15 }}>{result ? (ar ? result.insight.titleAr || result.insight.title : result.insight.title) : ''}</DialogTitle>
        <DialogContent>
          {result?.run.outcome === 'OK' && result.insight.action?.tier === 'ACT' && <Alert severity="success" sx={{ mb: 1 }}>{t('ai.insights.done', 'Done, in your name, and logged at the tool gateway.')}{result.run.callId ? ` (${result.run.callId.slice(0, 8)})` : ''}</Alert>}
          {result && result.run.outcome !== 'OK' && <Alert severity={result.run.outcome === 'REFUSED' ? 'warning' : 'error'} sx={{ mb: 1 }} data-testid="insight-result-refused">{result.run.outcome === 'REFUSED' ? t('ai.insights.refusedAction', 'The tool gateway refused this action.') : t('ai.insights.failedAction', 'The action could not be carried out.')} {result.run.reason}</Alert>}
          {result?.run.outcome === 'OK' && result.insight.action?.tier === 'READ' && (() => { const rows = rowsOf(result.run.data); const cols = columnsOf(rows); return rows.length ? (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small"><TableHead><TableRow>{cols.map((c) => <TableCell key={c} sx={{ fontSize: 11.5, fontWeight: 700 }}>{c}</TableCell>)}</TableRow></TableHead>
                <TableBody>{rows.slice(0, 12).map((r, i) => <TableRow key={i}>{cols.map((c) => <TableCell key={c} sx={{ fontSize: 12 }}>{fmtVal(r[c])}</TableCell>)}</TableRow>)}</TableBody></Table>
              {rows.length > 12 && <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>{t('ai.insights.more', { defaultValue: '{{n}} more not shown', n: rows.length - 12 })}</Typography>}
            </Box>) : <Typography sx={{ fontSize: 13 }}>{t('ai.insights.noRows', 'Nothing matched.')}</Typography>; })()}
        </DialogContent>
        <DialogActions><Button onClick={() => setResult(null)}>{t('common.close', 'Close')}</Button></DialogActions>
      </Dialog>
    </Card>
  );
}
