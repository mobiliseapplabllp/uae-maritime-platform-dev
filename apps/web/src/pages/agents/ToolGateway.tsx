import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, IconButton, MenuItem, Skeleton, Stack, Switch,
  Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import ExpandLessRoundedIcon from '@mui/icons-material/ExpandLessRounded';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { fmtD, fmtDT, fmtNum } from '../../utils/format';
import { ACCENT, CHART_SERIES, chartChrome, MONO } from '../../theme';
import { MODULES } from '../../modules';
import PageHeader from '../../components/common/PageHeader';
import { BucketBars, ChartCard, DashboardSkeleton, PanelCard, RankList, Yardstick, useDashboard } from '../../components/dashboard/kit';
import { CALL_OUTCOMES, GATEWAY_TIERS, INFERENCE_OUTCOMES, TIER_COLOR, callerChanges, callerFormOf, outcomeColor, quotaText, shortFingerprint, type CallerForm } from './constants';
import type { CallerUpdate, GatewayCall, GatewayCaller, GatewayInference, GatewayStats, GatewayTier, GatewayTool } from './types';

/* The tool gateway's governance face.
 *
 * Every call the AI layer makes — an assistant answering a question, an agent reading a register, a decision being
 * carried to a record — passes through one gateway as the person or agent behind it, and the same authorisation and
 * the same audit apply as they would to a human. This page is where an officer sees that boundary holding: what was
 * called, what was refused and by which rule, what left the platform for a hosted model and what was masked before it
 * did, and who may reach what. The switches and the dialog change the policy; the ledger behind them is append-only. */

type CallFilters = { caller: string; outcome: string; tier: string };
type InferFilters = { caller: string; outcome: string };
const NO_CALL_FILTERS: CallFilters = { caller: '', outcome: '', tier: '' };
const NO_INFER_FILTERS: InferFilters = { caller: '', outcome: '' };
const LIMIT = 100;
const P95_TARGET_MS = 1500;
/** Empty filters are left off the query: the service reads an empty string as a value, not as "any". */
const params = (f: Record<string, string | number>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ''));
/** A tool's module is a key in the module registry; the reader is shown the module's name. */
const moduleName = (key: string) => MODULES.find((m) => m.key === key)?.name ?? key;
const TIER_FILL: Record<GatewayTier, string> = { READ: ACCENT.teal, PROPOSE: ACCENT.blue, ACT: ACCENT.amber, INFER: ACCENT.purple };
const cellMono = { fontFamily: MONO, fontSize: 11.5 } as const;

export default function ToolGateway() {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const dispatch = useAppDispatch();
  const user = useUser();
  const canConfigure = hasPerm(user, 'agents.configure');
  const mode = useAppSelector((s) => s.ui.mode);
  const C = CHART_SERIES[mode]; const { axis, grid, tooltipStyle, cursorFill } = chartChrome(mode);
  const { data: stats } = useDashboard<GatewayStats>('/ai-gateway/stats');
  const [tab, setTab] = useState(0);
  const [callers, setCallers] = useState<GatewayCaller[] | null>(null);
  const [tools, setTools] = useState<GatewayTool[] | null>(null);
  const [calls, setCalls] = useState<GatewayCall[] | null>(null);
  const [inferences, setInferences] = useState<GatewayInference[] | null>(null);
  const [callFilters, setCallFilters] = useState<CallFilters>(NO_CALL_FILTERS);
  const [inferFilters, setInferFilters] = useState<InferFilters>(NO_INFER_FILTERS);
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<GatewayCaller | null>(null);

  const fail = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const loadCallers = useCallback(() => api.get<GatewayCaller[]>('/ai-gateway/callers').then((r) => setCallers(r.data)).catch((e: Error) => { fail(e); setCallers([]); }), [fail]);
  const loadTools = useCallback(() => api.get<GatewayTool[]>('/ai-gateway/tools').then((r) => setTools(r.data)).catch((e: Error) => { fail(e); setTools([]); }), [fail]);
  const loadCalls = useCallback(() => {
    setCalls(null); setOpened(null);
    return api.get<GatewayCall[]>('/ai-gateway/calls', { params: params({ ...callFilters, limit: LIMIT }) }).then((r) => setCalls(r.data)).catch((e: Error) => { fail(e); setCalls([]); });
  }, [callFilters, fail]);
  const loadInferences = useCallback(() => {
    setInferences(null);
    return api.get<GatewayInference[]>('/ai-gateway/inferences', { params: params({ ...inferFilters, limit: LIMIT }) }).then((r) => setInferences(r.data)).catch((e: Error) => { fail(e); setInferences([]); });
  }, [inferFilters, fail]);
  // The callers are needed on the first tab and by the log filters; the rest is fetched when its tab is opened.
  useEffect(() => { loadCallers(); }, [loadCallers]);
  useEffect(() => { if (tab === 1 && !tools) loadTools(); }, [tab, tools, loadTools]);
  useEffect(() => { if (tab === 2) loadCalls(); }, [tab, loadCalls]);
  useEffect(() => { if (tab === 3) loadInferences(); }, [tab, loadInferences]);

  const tierLabel = (x: string) => t(`agents.gateway.tiers.${x}`, x);
  const outcomeLabel = (x: string) => t(`agents.gateway.outcomes.${x}`, x);
  const kindLabel = (x: string) => t(`agents.gateway.kinds.${x}`, x);
  const refusalLabel = (x: string) => t(`agents.gateway.refusal.${x}`, x);
  const residencyLabel = (x: string) => t(`agents.gateway.residency.${x}`, x);
  const callerLabel = (id: string) => callers?.find((c) => c.callerId === id)?.label ?? id;

  /** Only what moved is sent; the service records the change against the caller and answers with the caller as it now stands. */
  const saveCaller = useCallback((c: GatewayCaller, body: CallerUpdate) => api.put<GatewayCaller>(`/ai-gateway/callers/${c.callerId}`, body).then((r) => {
    setCallers((list) => (list ?? []).map((x) => (x.callerId === c.callerId ? { ...x, ...r.data, usage: r.data.usage ?? x.usage } : x)));
    dispatch(notify(t('agents.gateway.callerSaved', { defaultValue: '{{name}} configured — the change is on the record', name: c.label })));
  }), [dispatch, t]);
  const setTool = (tool: GatewayTool, enabled: boolean) => api.put<{ name: string; enabled: boolean }>(`/ai-gateway/tools/${tool.name}`, { enabled }).then((r) => {
    setTools((list) => (list ?? []).map((x) => (x.name === tool.name ? { ...x, enabled: r.data.enabled } : x)));
    dispatch(notify(enabled ? t('agents.gateway.toolEnabled', { defaultValue: '{{name}} enabled', name: tool.name }) : t('agents.gateway.toolDisabled', { defaultValue: '{{name}} disabled', name: tool.name })));
  }).catch(fail);

  const toolGroups = useMemo(() => {
    const groups = new Map<string, GatewayTool[]>();
    for (const x of tools ?? []) groups.set(x.module, [...(groups.get(x.module) ?? []), x]);
    return Array.from(groups.entries());
  }, [tools]);

  const TierChip = ({ tier }: { tier: string }) => (
    <Tooltip describeChild title={t(`agents.gateway.tierBlurb.${tier}`, { defaultValue: tier })}>
      <Chip size="small" variant="outlined" color={TIER_COLOR[tier as GatewayTier] ?? 'default'} label={tierLabel(tier)} sx={{ height: 20, fontSize: 10.5, fontWeight: 600 }} />
    </Tooltip>
  );
  const OutcomeChip = ({ outcome }: { outcome: string }) => (
    <Chip size="small" color={outcomeColor(outcome)} variant={outcome === 'OK' ? 'outlined' : 'filled'} label={outcomeLabel(outcome)} sx={{ height: 20, fontSize: 10.5 }} />
  );
  const selectField = (label: string, value: string, onChange: (v: string) => void, options: { value: string; label: string }[], width = 170) => (
    <TextField select size="small" label={label} value={value} sx={{ width }} onChange={(e) => onChange(e.target.value)}>
      <MenuItem value="">{t('agents.gateway.filterAny', 'Any')}</MenuItem>
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
  const callerOptions = (callers ?? []).map((c) => ({ value: c.callerId, label: c.label }));

  const inferTotal = stats?.inferences.reduce((a, r) => a + r.count, 0) ?? 0;
  const inferRedactions = stats?.inferences.reduce((a, r) => a + r.redactions, 0) ?? 0;
  const inferFlagged = stats?.inferences.reduce((a, r) => a + r.flagged, 0) ?? 0;
  const callersEnabled = stats?.callers.filter((c) => c.enabled).length ?? 0;

  return (
    <Box data-testid="gateway-page">
      <PageHeader icon={HubRoundedIcon} iconColor="#75479C" title={t('agents.gateway.title', 'Tool Gateway')}
        sub={t('agents.gateway.sub', 'Every call the AI layer makes passes through here as the person or agent behind it — what was called, what was refused, and what left the platform for a hosted model')} />

      {!stats ? <DashboardSkeleton tiles={6} /> : (
        <Grid container spacing={2}>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-calls" label={t('agents.gateway.yardCalls', 'Calls, 24 h')} value={stats.calls.last24h} display={fmtNum(stats.calls.last24h)} target={0}
              targetLabel={t('agents.gateway.in7d', { defaultValue: '{{n}} in 7 d', n: fmtNum(stats.calls.last7d) })} sub={t('agents.gateway.in30d', { defaultValue: '{{n}} in 30 d', n: fmtNum(stats.calls.last30d) })} />
          </Grid>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-refused" label={t('agents.gateway.yardRefused', 'Refused, 24 h')} value={stats.calls.refused24h} display={fmtNum(stats.calls.refused24h)} target={0} higherIsBetter={false}
              targetLabel={t('agents.gateway.targetZero', 'target 0')} sub={t('agents.gateway.refused7d', { defaultValue: '{{n}} refused in 7 d', n: fmtNum(stats.byOutcome.REFUSED ?? 0) })} />
          </Grid>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-failed" label={t('agents.gateway.yardFailed', 'Failed, 24 h')} value={stats.calls.failed24h} display={fmtNum(stats.calls.failed24h)} target={0} higherIsBetter={false}
              targetLabel={t('agents.gateway.targetZero', 'target 0')} sub={t('agents.gateway.failed7d', { defaultValue: '{{n}} failed in 7 d', n: fmtNum(stats.byOutcome.FAILED ?? 0) })} />
          </Grid>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-p95" label={t('agents.gateway.yardP95', 'p95 latency, 7 d')} value={stats.calls.p95Ms} display={stats.calls.p95Ms == null ? '—' : `${fmtNum(stats.calls.p95Ms)} ms`} target={P95_TARGET_MS} higherIsBetter={false}
              targetLabel={t('agents.gateway.targetP95', { defaultValue: 'target ≤ {{n}} ms', n: P95_TARGET_MS })} sub={stats.calls.p50Ms == null ? t('agents.gateway.noLatency', 'no call answered yet') : t('agents.gateway.p50', { defaultValue: 'p50 {{n}} ms', n: fmtNum(stats.calls.p50Ms) })} />
          </Grid>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-inferences" label={t('agents.gateway.yardInferences', 'Inferences, 7 d')} value={inferFlagged} display={fmtNum(inferTotal)} target={0} higherIsBetter={false}
              targetLabel={t('agents.gateway.flagged', { defaultValue: '{{n}} flagged', n: fmtNum(inferFlagged) })} sub={t('agents.gateway.redactions', { defaultValue: '{{n}} redactions', n: fmtNum(inferRedactions) })} />
          </Grid>
          <Grid item xs={6} md={4} lg={2}>
            <Yardstick testId="yard-callers" label={t('agents.gateway.yardCallers', 'Callers enabled')} value={callersEnabled} display={`${callersEnabled} / ${stats.callers.length}`} target={0}
              targetLabel={t('agents.gateway.toolsRegistered', { defaultValue: '{{n}} tools registered', n: stats.tools.registered })}
              sub={t('agents.gateway.toolsByReach', { defaultValue: '{{act}} act · {{infer}} infer', act: stats.tools.byTier.ACT ?? 0, infer: stats.tools.byTier.INFER ?? 0 })} />
          </Grid>

          <Grid item xs={12} lg={7}>
            <ChartCard testId="chart-gateway-days" title={t('agents.gateway.chartDays', 'Calls, day by day')} sub={t('agents.gateway.chartDaysSub', 'answered, refused and failed calls, with inferences on the right axis — last 14 days')}>
              <ResponsiveContainer>
                <ComposedChart data={stats.byDay.map((d) => ({ ...d, label: fmtD(d.day).slice(0, 6) }))} barCategoryGap="28%">
                  <CartesianGrid stroke={grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} />
                  <YAxis yAxisId="calls" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                  <YAxis yAxisId="inferences" orientation="right" tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={36} allowDecimals={false} />
                  <RTooltip contentStyle={tooltipStyle} cursor={{ fill: cursorFill }} />
                  <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{v}</span>} iconSize={10} />
                  <Bar yAxisId="calls" dataKey="ok" stackId="calls" name={t('agents.gateway.seriesOk', 'Answered')} fill={C.container} />
                  <Bar yAxisId="calls" dataKey="refused" stackId="calls" name={t('agents.gateway.seriesRefused', 'Refused')} fill={C.dryBulk} />
                  <Bar yAxisId="calls" dataKey="failed" stackId="calls" name={t('agents.gateway.seriesFailed', 'Failed')} fill={C.other} radius={[4, 4, 0, 0]} />
                  <Line yAxisId="inferences" type="monotone" dataKey="inferences" name={t('agents.gateway.seriesInferences', 'Inferences')} stroke={C.liquid} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </Grid>
          <Grid item xs={12} lg={5}>
            <PanelCard testId="panel-refusals" title={t('agents.gateway.refusalsTitle', 'Refusals by rule')} sub={t('agents.gateway.refusalsSub', 'why the gateway said no, last 7 days')}>
              {stats.refusals.length
                ? <BucketBars rows={stats.refusals.map((r) => ({ label: refusalLabel(r.code), value: r.count, display: fmtNum(r.count) }))} tone={() => ACCENT.rust} />
                : <Typography variant="body2" color="text.secondary">{t('agents.gateway.noRefusals', 'Nothing refused in the last 7 days')}</Typography>}
            </PanelCard>
          </Grid>

          <Grid item xs={12} md={4}>
            <PanelCard testId="panel-tiers" title={t('agents.gateway.byTierTitle', 'Calls by tier')} sub={t('agents.gateway.byTierSub', 'answered calls by the reach of the tool, last 7 days')}>
              <BucketBars rows={GATEWAY_TIERS.map((tier) => ({ label: tierLabel(tier), value: stats.byTier[tier] ?? 0, display: fmtNum(stats.byTier[tier] ?? 0), sub: t(`agents.gateway.tierBlurb.${tier}`, { defaultValue: tier }) }))} tone={(i) => TIER_FILL[GATEWAY_TIERS[i]]} />
            </PanelCard>
          </Grid>
          <Grid item xs={12} md={4}>
            <PanelCard testId="panel-modules" title={t('agents.gateway.byModuleTitle', 'Calls by module')} sub={t('agents.gateway.byModuleSub', 'answered calls by the module that owns the record, last 7 days')}>
              {stats.byModule.length
                ? <BucketBars rows={stats.byModule.slice(0, 8).map((m) => ({ label: moduleName(m.module), value: m.calls, display: fmtNum(m.calls) }))} />
                : <Typography variant="body2" color="text.secondary">{t('agents.gateway.noCalls', 'No call answered in the last 7 days')}</Typography>}
            </PanelCard>
          </Grid>
          <Grid item xs={12} md={4}>
            <PanelCard testId="panel-tools" title={t('agents.gateway.topToolsTitle', 'Most-called tools')} sub={t('agents.gateway.topToolsSub', 'answered calls and the median latency, last 7 days')}>
              <RankList empty={t('agents.gateway.noCalls', 'No call answered in the last 7 days')}
                rows={stats.byTool.map((x) => ({ key: x.tool, primary: x.tool, secondary: x.p50Ms == null ? undefined : t('agents.gateway.p50', { defaultValue: 'p50 {{n}} ms', n: fmtNum(x.p50Ms) }), value: fmtNum(x.calls) }))} />
            </PanelCard>
          </Grid>
          <Grid item xs={12}>
            <PanelCard testId="panel-inferences" title={t('agents.gateway.inferTitle', 'Inferences by provider')} sub={t('agents.gateway.inferSub', 'by provider and outcome, last 7 days — tokens in and out, redactions and prompts flagged for injection')}>
              {stats.inferences.length
                ? <BucketBars rows={stats.inferences.map((r) => ({
                  label: `${r.provider} · ${outcomeLabel(r.outcome)}`, value: r.count, display: fmtNum(r.count),
                  sub: t('agents.gateway.inferLine', { defaultValue: '{{in}} in / {{out}} out · {{redactions}} redacted · {{flagged}} flagged · p50 {{p50}} ms', in: fmtNum(r.tokensIn), out: fmtNum(r.tokensOut), redactions: r.redactions, flagged: r.flagged, p50: fmtNum(r.p50Ms) }),
                }))} tone={(i) => (stats.inferences[i].outcome === 'OK' ? ACCENT.purple : ACCENT.slate)} />
                : <Typography variant="body2" color="text.secondary">{t('agents.gateway.noInferences', 'No inference in the last 7 days')}</Typography>}
            </PanelCard>
          </Grid>
        </Grid>
      )}

      <Card sx={{ mt: 2, p: 0 }}>
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label={t('agents.gateway.title', 'Tool Gateway')} sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={t('agents.gateway.tabCallers', 'Callers')} data-testid="tab-callers" />
          <Tab label={t('agents.gateway.tabTools', 'Tools')} data-testid="tab-tools" />
          <Tab label={t('agents.gateway.tabCalls', 'Call log')} data-testid="tab-calls" />
          <Tab label={t('agents.gateway.tabInferences', 'Inferences')} data-testid="tab-inferences" />
        </Tabs>
        {!canConfigure && tab < 2 && <Alert severity="info" sx={{ m: 1.75, mb: 0 }}>{t('agents.gateway.needsConfigurePerm', 'Changing what a caller or a tool may do needs the agents.configure permission.')}</Alert>}

        {/* ---------------------------------------------------------------- callers */}
        {tab === 0 && (!callers ? <Box sx={{ p: 1.75 }} aria-busy="true"><Skeleton variant="rounded" height={240} /></Box> : (
          <TableContainer>
            <Table size="small" data-testid="callers-table" aria-label={t('agents.gateway.tabCallers', 'Callers')}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('agents.gateway.colCaller', 'Caller')}</TableCell>
                  <TableCell>{t('agents.gateway.colKind', 'Kind')}</TableCell>
                  <TableCell>{t('agents.gateway.colCeiling', 'Ceiling')}</TableCell>
                  <TableCell>{t('agents.gateway.colAllowed', 'Allowed tools')}</TableCell>
                  <TableCell align="right">{t('agents.gateway.colHour', 'This hour')}</TableCell>
                  <TableCell align="right">{t('agents.gateway.colDay', 'Today')}</TableCell>
                  <TableCell>{t('agents.gateway.colEnabled', 'Enabled')}</TableCell>
                  {canConfigure && <TableCell>{t('agents.gateway.colConfigure', 'Configure')}</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {callers.map((c) => (
                  <TableRow key={c.callerId} hover>
                    <TableCell>
                      <Typography sx={{ fontWeight: 600, fontSize: 13 }}>{c.label}</Typography>
                      <Typography sx={{ ...cellMono, fontSize: 10.5, color: 'text.secondary' }}>{c.callerId}</Typography>
                      {c.note && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{c.note}</Typography>}
                    </TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={kindLabel(c.kind)} sx={{ height: 20, fontSize: 10.5 }} /></TableCell>
                    <TableCell><TierChip tier={c.maxTier} /></TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{c.allowedTools.includes('*') ? t('agents.gateway.everyTool', 'every tool') : t('agents.gateway.nTools', { count: c.allowedTools.length })}</TableCell>
                    {/* A quota nearly used up is shown in warning colour before it refuses anything. */}
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: c.usage.hour >= c.hourlyQuota * 0.8 ? 'warning.main' : undefined }}>{quotaText(c.usage.hour, c.hourlyQuota)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: c.usage.day >= c.dailyQuota * 0.8 ? 'warning.main' : undefined }}>{quotaText(c.usage.day, c.dailyQuota)}</TableCell>
                    <TableCell>
                      <Switch size="small" checked={c.enabled} disabled={!canConfigure} inputProps={{ 'aria-label': t('agents.gateway.enableCaller', { defaultValue: 'Enable {{name}}', name: c.label }) }}
                        onChange={(e) => saveCaller(c, { enabled: e.target.checked }).catch(fail)} />
                    </TableCell>
                    {canConfigure && (
                      <TableCell>
                        <Button size="small" startIcon={<EditRoundedIcon />} onClick={() => setEditing(c)} aria-label={t('agents.gateway.editCaller', { defaultValue: 'Configure {{name}}', name: c.label })}>
                          {t('agents.gateway.edit', 'Configure')}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ))}

        {/* ------------------------------------------------------------------ tools */}
        {tab === 1 && (!tools ? <Box sx={{ p: 1.75 }} aria-busy="true"><Skeleton variant="rounded" height={320} /></Box> : (
          <TableContainer>
            <Table size="small" data-testid="tools-table" aria-label={t('agents.gateway.tabTools', 'Tools')}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('agents.gateway.colTool', 'Tool')}</TableCell>
                  <TableCell>{t('agents.gateway.colLabel', 'Label')}</TableCell>
                  <TableCell>{t('agents.gateway.colTier', 'Tier')}</TableCell>
                  <TableCell>{t('agents.gateway.colPermission', 'Permission')}</TableCell>
                  <TableCell>{t('agents.gateway.colUpstream', 'Upstream')}</TableCell>
                  <TableCell>{t('agents.gateway.colEnabled', 'Enabled')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {toolGroups.map(([module, list]) => (
                  <Fragment key={module}>
                    <TableRow sx={{ bgcolor: 'action.hover' }}>
                      <TableCell component="th" scope="rowgroup" colSpan={6} sx={{ fontWeight: 700, fontSize: 12 }}>{moduleName(module)} · {t('agents.gateway.nTools', { count: list.length })}</TableCell>
                    </TableRow>
                    {list.map((x) => (
                      <TableRow key={x.name} hover>
                        <TableCell sx={cellMono}>{x.name}</TableCell>
                        <TableCell>
                          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{ar && x.labelAr ? x.labelAr : x.label}</Typography>
                          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{x.description}</Typography>
                        </TableCell>
                        <TableCell><TierChip tier={x.tier} /></TableCell>
                        <TableCell sx={cellMono}>{x.permission}</TableCell>
                        <TableCell sx={cellMono}>{x.upstream}</TableCell>
                        <TableCell>
                          <Switch size="small" checked={x.enabled} disabled={!canConfigure} inputProps={{ 'aria-label': t('agents.gateway.enableTool', { defaultValue: 'Enable {{name}}', name: x.name }) }}
                            onChange={(e) => setTool(x, e.target.checked)} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ))}

        {/* --------------------------------------------------------------- call log */}
        {tab === 2 && (
          <>
            <Box sx={{ px: 1.75, py: 1.5, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              {selectField(t('agents.gateway.filterCaller', 'Caller'), callFilters.caller, (v) => setCallFilters((f) => ({ ...f, caller: v })), callerOptions, 220)}
              {selectField(t('agents.gateway.filterOutcome', 'Outcome'), callFilters.outcome, (v) => setCallFilters((f) => ({ ...f, outcome: v })), CALL_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })))}
              {selectField(t('agents.gateway.filterTier', 'Tier'), callFilters.tier, (v) => setCallFilters((f) => ({ ...f, tier: v })), GATEWAY_TIERS.map((x) => ({ value: x, label: tierLabel(x) })))}
              <Box sx={{ flex: 1 }} />
              <Typography variant="caption" color="text.secondary">{t('agents.gateway.nRows', { count: calls?.length ?? 0 })}</Typography>
            </Box>
            <Divider />
            {!calls ? <Box sx={{ p: 1.75 }} aria-busy="true"><Skeleton variant="rounded" height={320} /></Box> : calls.length === 0 ? (
              <Typography sx={{ py: 6, textAlign: 'center' }} color="text.secondary">{t('agents.gateway.noCallRows', 'No call matches these filters')}</Typography>
            ) : (
              <TableContainer>
                <Table size="small" data-testid="calls-table" aria-label={t('agents.gateway.tabCalls', 'Call log')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('agents.gateway.colDetails', 'Details')}</TableCell>
                      <TableCell>{t('agents.gateway.colWhen', 'When')}</TableCell>
                      <TableCell>{t('agents.gateway.colCaller', 'Caller')}</TableCell>
                      <TableCell>{t('agents.gateway.colPrincipal', 'As')}</TableCell>
                      <TableCell>{t('agents.gateway.colTool', 'Tool')}</TableCell>
                      <TableCell>{t('agents.gateway.colTier', 'Tier')}</TableCell>
                      <TableCell>{t('agents.gateway.colOutcome', 'Outcome')}</TableCell>
                      <TableCell align="right">{t('agents.gateway.colStatus', 'Status')}</TableCell>
                      <TableCell align="right">{t('agents.gateway.colLatency', 'Latency')}</TableCell>
                      <TableCell>{t('agents.gateway.colReason', 'Reason')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {calls.map((r) => {
                      const expanded = opened === r.id;
                      return (
                        <Fragment key={r.id}>
                          <TableRow hover>
                            <TableCell padding="checkbox">
                              <IconButton size="small" aria-expanded={expanded} aria-label={expanded ? t('agents.gateway.hideDetails', 'Hide details') : t('agents.gateway.showDetails', 'Show details')} onClick={() => setOpened(expanded ? null : r.id)}>
                                {expanded ? <ExpandLessRoundedIcon fontSize="small" /> : <ExpandMoreRoundedIcon fontSize="small" />}
                              </IconButton>
                            </TableCell>
                            <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDT(r.at)}</TableCell>
                            <TableCell sx={{ fontSize: 12.5 }}>{callerLabel(r.callerId)}</TableCell>
                            <TableCell sx={{ fontSize: 12.5 }}>{r.principalName || '—'}</TableCell>
                            <TableCell sx={cellMono}>{r.tool}</TableCell>
                            <TableCell><TierChip tier={r.tier} /></TableCell>
                            <TableCell><OutcomeChip outcome={r.outcome} /></TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.httpStatus ?? '—'}</TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtNum(r.latencyMs)} ms</TableCell>
                            <TableCell sx={{ fontSize: 12 }}>
                              {r.refusalCode ? <><b>{refusalLabel(r.refusalCode)}</b>{r.reason ? ` — ${r.reason}` : ''}</> : (r.reason || '—')}
                            </TableCell>
                          </TableRow>
                          {expanded && (
                            <TableRow>
                              <TableCell colSpan={10} sx={{ bgcolor: 'action.hover' }}>
                                <Typography sx={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>{t('agents.gateway.argsTitle', 'Arguments, as redacted')}</Typography>
                                <Box component="pre" sx={{ m: 0, fontSize: 11, fontFamily: MONO, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(r.args ?? {}, null, 2)}</Box>
                                <Typography sx={{ mt: 1, fontSize: 11, color: 'text.secondary', fontFamily: MONO }}>
                                  {t('agents.gateway.upstream', 'Upstream')}: {r.upstream || '—'} · {t('agents.gateway.argsHash', 'arguments hash')} {shortFingerprint(r.argsHash)} · {t('agents.gateway.redactions', { defaultValue: '{{n}} redactions', n: r.redactions })}
                                  {r.decisionId ? ` · ${t('agents.gateway.decisionRef', { defaultValue: 'decision {{id}}', id: r.decisionId })}` : ''}{r.cause ? ` · ${r.cause}` : ''}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          )}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}

        {/* ------------------------------------------------------------- inferences */}
        {tab === 3 && (
          <>
            <Box sx={{ px: 1.75, py: 1.5, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
              {selectField(t('agents.gateway.filterCaller', 'Caller'), inferFilters.caller, (v) => setInferFilters((f) => ({ ...f, caller: v })), callerOptions, 220)}
              {selectField(t('agents.gateway.filterOutcome', 'Outcome'), inferFilters.outcome, (v) => setInferFilters((f) => ({ ...f, outcome: v })), INFERENCE_OUTCOMES.map((o) => ({ value: o, label: outcomeLabel(o) })))}
              <Box sx={{ flex: 1 }} />
              <Typography variant="caption" color="text.secondary">{t('agents.gateway.nRows', { count: inferences?.length ?? 0 })}</Typography>
            </Box>
            <Divider />
            {!inferences ? <Box sx={{ p: 1.75 }} aria-busy="true"><Skeleton variant="rounded" height={320} /></Box> : inferences.length === 0 ? (
              <Typography sx={{ py: 6, textAlign: 'center' }} color="text.secondary">{t('agents.gateway.noInferenceRows', 'No inference matches these filters')}</Typography>
            ) : (
              <TableContainer>
                <Table size="small" data-testid="inferences-table" aria-label={t('agents.gateway.tabInferences', 'Inferences')}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('agents.gateway.colWhen', 'When')}</TableCell>
                      <TableCell>{t('agents.gateway.colCaller', 'Caller')}</TableCell>
                      <TableCell>{t('agents.gateway.colPrincipal', 'As')}</TableCell>
                      <TableCell>{t('agents.gateway.colPurpose', 'Purpose')}</TableCell>
                      <TableCell>{t('agents.gateway.colProvider', 'Provider')}</TableCell>
                      <TableCell>{t('agents.gateway.colProfile', 'Profile')}</TableCell>
                      <TableCell>{t('agents.gateway.colResidency', 'Residency')}</TableCell>
                      <TableCell>{t('agents.gateway.colOutcome', 'Outcome')}</TableCell>
                      <TableCell align="right">{t('agents.gateway.colRedactions', 'Redactions')}</TableCell>
                      <TableCell>{t('agents.gateway.colInjection', 'Injection')}</TableCell>
                      <TableCell align="right">{t('agents.gateway.colTokens', 'Tokens in / out')}</TableCell>
                      <TableCell align="right">{t('agents.gateway.colLatency', 'Latency')}</TableCell>
                      <TableCell>{t('agents.gateway.colFingerprint', 'Fingerprint')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {inferences.map((r) => (
                      <TableRow key={r.id} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDT(r.at)}</TableCell>
                        <TableCell sx={{ fontSize: 12.5 }}>{callerLabel(r.callerId)}</TableCell>
                        <TableCell sx={{ fontSize: 12.5 }}>{r.principalName || '—'}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{r.purpose}</TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{r.provider}</TableCell>
                        <TableCell sx={cellMono}>{r.profile || '—'}</TableCell>
                        <TableCell><Chip size="small" variant="outlined" color={r.residency === 'AE' ? 'success' : 'warning'} label={residencyLabel(r.residency)} sx={{ height: 20, fontSize: 10.5, fontWeight: 600 }} /></TableCell>
                        <TableCell><OutcomeChip outcome={r.outcome} /></TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.redactions}</TableCell>
                        <TableCell sx={{ fontSize: 12, color: r.injectionScore > 0 ? 'warning.main' : undefined, whiteSpace: 'nowrap' }}>
                          {t('agents.gateway.score', { defaultValue: 'score {{v}}', v: Number(r.injectionScore).toFixed(2) })}{r.injectionFlags?.length ? ` · ${r.injectionFlags.join(', ')}` : ''}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtNum(r.tokensIn)} / {fmtNum(r.tokensOut)}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtNum(r.latencyMs)} ms</TableCell>
                        <TableCell sx={cellMono}><span title={r.promptFingerprint}>{shortFingerprint(r.promptFingerprint)}</span></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </Card>

      <CallerDialog caller={editing} onClose={() => setEditing(null)} onSave={saveCaller} />
    </Box>
  );
}

/** The dialog that changes a caller's policy: its ceiling, its quotas, its note and its allow-list. */
function CallerDialog({ caller, onClose, onSave }: { caller: GatewayCaller | null; onClose: () => void; onSave: (c: GatewayCaller, body: CallerUpdate) => Promise<void> }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CallerForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setForm(caller ? callerFormOf(caller) : null); setErr(''); }, [caller]);

  const save = () => {
    if (!caller || !form) return;
    const body = callerChanges(caller, form);
    if (!Object.keys(body).length) { setErr(t('agents.gateway.nothingChanged', 'Nothing changed')); return; }
    setBusy(true); setErr('');
    onSave(caller, body).then(onClose).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };

  return (
    <Dialog open={!!caller} onClose={() => !busy && onClose()} fullWidth maxWidth="sm" aria-labelledby="caller-edit-title">
      {caller && form && (
        <>
          <DialogTitle id="caller-edit-title">{t('agents.gateway.editCaller', { defaultValue: 'Configure {{name}}', name: caller.label })}</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('agents.gateway.editSub', 'The ceiling, the quotas and the allow-list. Only what moves is sent, and the change is recorded against the caller.')}</Typography>
            {err && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setErr('')}>{err}</Alert>}
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              <TextField select size="small" label={t('agents.gateway.maxTier', 'Ceiling')} value={form.maxTier} onChange={(e) => setForm({ ...form, maxTier: e.target.value })}
                helperText={t(`agents.gateway.tierBlurb.${form.maxTier}`, { defaultValue: form.maxTier })}>
                {GATEWAY_TIERS.map((x) => <MenuItem key={x} value={x}>{t(`agents.gateway.tiers.${x}`, x)}</MenuItem>)}
              </TextField>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField size="small" type="number" fullWidth label={t('agents.gateway.hourlyQuota', 'Hourly quota')} value={form.hourlyQuota} inputProps={{ min: 0 }} onChange={(e) => setForm({ ...form, hourlyQuota: e.target.value })} />
                <TextField size="small" type="number" fullWidth label={t('agents.gateway.dailyQuota', 'Daily quota')} value={form.dailyQuota} inputProps={{ min: 0 }} onChange={(e) => setForm({ ...form, dailyQuota: e.target.value })} />
              </Stack>
              <TextField size="small" label={t('agents.gateway.note', 'Note')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              <TextField size="small" multiline minRows={3} label={t('agents.gateway.allowedTools', 'Allowed tools')} value={form.allowedTools} onChange={(e) => setForm({ ...form, allowedTools: e.target.value })}
                helperText={t('agents.gateway.allowedToolsHelp', 'Tool names separated by commas or new lines — * allows every tool')} inputProps={{ sx: { fontFamily: MONO, fontSize: 12 } }} />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="contained" onClick={save} disabled={busy}>{t('common.save')}</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}
