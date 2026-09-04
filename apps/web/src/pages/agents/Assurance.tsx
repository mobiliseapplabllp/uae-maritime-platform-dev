import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Card, Chip, Divider, Grid, LinearProgress, MenuItem, Skeleton, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { chartChrome, MONO } from '../../theme';
import { fmtD } from '../../utils/format';
import { LEVEL_META, confText, dimensionLabel, pctText } from './constants';
import type { AgentRow, BiasData, DriftData, ServiceLevelData } from './types';

/* Assurance — drift, bias and the service levels.
 *
 * An agent that was right last quarter and is wrong this one looks identical from the outside unless somebody is
 * measuring. Nothing on this page is the agent's opinion of itself: accuracy means agreement with the humans who
 * reviewed it, and a cohort too small to speak is reported but never called biased. */

const Section = ({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) => (
  <Card sx={{ p: 2, height: '100%' }}>
    <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{title}</Typography>
    {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    <Box sx={{ mt: 1.5 }}>{children}</Box>
  </Card>
);

export default function Assurance() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.mode);
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [tab, setTab] = useState(0);
  const [agentId, setAgentId] = useState('');
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [drift, setDrift] = useState<DriftData | null>(null);
  const [bias, setBias] = useState<BiasData | null>(null);
  const [levels, setLevels] = useState<ServiceLevelData | null>(null);

  useEffect(() => { api.get<AgentRow[]>('/agents').then((r) => setAgents(r.data)).catch(() => {}); }, []);

  const load = useCallback(() => {
    const params = agentId ? { agentId } : {};
    setDrift(null); setBias(null); setLevels(null);
    const fail = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
    api.get<DriftData>('/agents/monitoring/drift', { params }).then((r) => setDrift(r.data)).catch(fail);
    api.get<BiasData>('/agents/monitoring/bias', { params }).then((r) => setBias(r.data)).catch(fail);
    api.get<ServiceLevelData>('/agents/monitoring/metrics', { params }).then((r) => setLevels(r.data)).catch(fail);
  }, [agentId, dispatch]);
  useEffect(() => { load(); }, [load]);

  const measured = drift?.perAgent.filter((a) => a.decisions > 0) ?? [];

  return (
    <>
      <PageHeader icon={VerifiedUserRoundedIcon} iconColor="#0E7C86" title={t('agents.assuranceTitle')} sub={t('agents.assuranceSub')}
        actions={(
          <TextField select size="small" label={t('agents.colAgent')} value={agentId} sx={{ width: 220 }} onChange={(e) => setAgentId(e.target.value)}>
            <MenuItem value="">{t('agents.allAgents')}</MenuItem>
            {agents.map((a) => <MenuItem key={a.agentId} value={a.agentId}>{a.name}</MenuItem>)}
          </TextField>
        )} />

      <Card sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, v: number) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label={t('agents.assuranceTitle')} sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={t('agents.tabDrift')} />
          <Tab label={t('agents.tabBias', { n: bias?.flagged ?? 0 })} />
          <Tab label={t('agents.tabServiceLevels')} />
        </Tabs>
      </Card>

      {/* ------------------------------------------------------------------ drift */}
      {tab === 0 && (!drift ? <Skeleton variant="rounded" height={360} /> : (
        <>
          {drift.drifting.length > 0 ? (
            <Alert severity="warning" sx={{ mb: 2 }}>{t('agents.driftingAlert', { n: drift.drifting.length, names: drift.perAgent.filter((a) => a.drifting).map((a) => a.name).join(', ') })}</Alert>
          ) : <Alert severity="success" sx={{ mb: 2 }}>{t('agents.noDrift', { days: drift.windowDays })}</Alert>}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            {t('agents.driftWindow', { days: drift.windowDays, bucket: drift.bucketDays, from: fmtD(drift.from), to: fmtD(drift.to), n: drift.decisions })}
          </Typography>
          {measured.length === 0 && <Card sx={{ p: 6, textAlign: 'center' }}><Typography color="text.secondary">{t('agents.noDriftData')}</Typography></Card>}
          <Grid container spacing={2}>
            {measured.map((a) => (
              <Grid item xs={12} lg={6} key={a.agentId}>
                <Section title={a.name} sub={t('agents.driftAgentSub', { level: LEVEL_META[a.autonomyLevel]?.label ?? a.autonomyLevel, decisions: a.decisions, reviewed: a.reviewed })}>
                  <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                    <Chip size="small" variant="outlined" label={t('agents.chipAgreement', { v: pctText(a.agreementRate, 0) })} sx={{ height: 22, fontSize: 11 }} />
                    <Chip size="small" variant="outlined" label={t('agents.chipConfidence', { v: confText(a.avgConfidence) })} sx={{ height: 22, fontSize: 11 }} />
                    <Chip size="small" color={a.drifting ? 'error' : 'default'} variant={a.drifting ? 'filled' : 'outlined'}
                      label={a.agreementDelta == null ? t('agents.chipNoBaseline') : t('agents.chipDelta', { v: `${a.agreementDelta > 0 ? '+' : ''}${a.agreementDelta}` })} sx={{ height: 22, fontSize: 11 }} />
                  </Stack>
                  <ResponsiveContainer width="100%" height={190}>
                    <LineChart data={a.buckets.map((b) => ({ ...b, label: fmtD(b.from) }))} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                      <CartesianGrid stroke={grid} vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: axis }} axisLine={false} tickLine={false} domain={[0, 100]} />
                      <RTooltip contentStyle={tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="agreementRate" stroke="#056A73" strokeWidth={2} dot={{ r: 2 }} connectNulls name={t('agents.seriesAgreement')} />
                      <Line type="monotone" dataKey="escalationRate" stroke="#B98A2F" strokeWidth={2} dot={{ r: 2 }} connectNulls name={t('agents.seriesEscalation')} />
                    </LineChart>
                  </ResponsiveContainer>
                  <Divider sx={{ my: 1 }} />
                  <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>{t('agents.confidenceDistribution')}</Typography>
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={a.confidence} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                      <CartesianGrid stroke={grid} vertical={false} />
                      <XAxis dataKey="band" tick={{ fontSize: 9.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} interval={0} />
                      <YAxis tick={{ fontSize: 10, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <RTooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                      <Bar dataKey="decisions" fill="#75479C" name={t('agents.seriesDecisions')} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </Section>
              </Grid>
            ))}
          </Grid>
        </>
      ))}

      {/* ------------------------------------------------------------------- bias */}
      {tab === 1 && (!bias ? <Skeleton variant="rounded" height={360} /> : (
        <>
          <Alert severity={bias.flagged ? 'warning' : 'success'} sx={{ mb: 2 }}>
            {bias.flagged ? t('agents.biasFlagged', { n: bias.flagged, delta: bias.flagDeltaPct }) : t('agents.biasClear', { delta: bias.flagDeltaPct })}
          </Alert>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{t('agents.biasNote', { min: bias.minCohort, n: bias.decisions })}</Typography>
          {bias.dimensions.filter((d) => d.cohorts.length > 0).map((d) => (
            <Card key={d.dimension} sx={{ mb: 2 }}>
              <Box sx={{ p: 1.75, pb: 1.25 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{dimensionLabel(d.dimension)}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('agents.biasPopulation', { n: d.decisions, esc: pctText(d.populationEscalationRate, 0), ovr: pctText(d.populationOverrideRate, 0) })}
                </Typography>
              </Box>
              <Divider />
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label={dimensionLabel(d.dimension)}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('agents.colCohort')}</TableCell>
                      <TableCell align="right">{t('agents.colDecisions')}</TableCell>
                      <TableCell align="right">{t('agents.colEscalation')}</TableCell>
                      <TableCell align="right">{t('agents.colVsPopulation')}</TableCell>
                      <TableCell align="right">{t('agents.colOverride')}</TableCell>
                      <TableCell align="right">{t('agents.colAutoApplied')}</TableCell>
                      <TableCell align="right">{t('agents.colConfidence')}</TableCell>
                      <TableCell>{t('agents.colAudit')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {d.cohorts.map((c) => (
                      <TableRow key={c.value} hover>
                        <TableCell><b>{c.value}</b></TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{c.decisions}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{pctText(c.escalationRate, 0)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5, color: c.flagged ? 'error.main' : 'text.secondary' }}>
                          {c.escalationDelta == null ? '—' : `${c.escalationDelta > 0 ? '+' : ''}${c.escalationDelta}`}
                        </TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{pctText(c.overrideRate, 0)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{pctText(c.autoAppliedRate, 0)}</TableCell>
                        <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12.5 }}>{confText(c.avgConfidence)}</TableCell>
                        <TableCell>
                          {c.flagged
                            ? <Chip size="small" color="warning" label={t('agents.auditNeeded')} sx={{ height: 20, fontSize: 10.5 }} />
                            : !c.sufficient
                              ? <Tooltip describeChild title={t('agents.tooSmallHelp', { min: bias.minCohort })}><Chip size="small" variant="outlined" label={t('agents.tooSmall')} sx={{ height: 20, fontSize: 10.5 }} /></Tooltip>
                              : <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{t('agents.inLine')}</Typography>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          ))}
          {bias.dimensions.every((d) => d.cohorts.length === 0) && (
            <Card sx={{ p: 6, textAlign: 'center' }}><Typography color="text.secondary">{t('agents.noBiasData')}</Typography></Card>
          )}
        </>
      ))}

      {/* ---------------------------------------------------------- service levels */}
      {tab === 2 && (!levels ? <Skeleton variant="rounded" height={360} /> : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            {t('agents.slaWindow', { days: levels.windowDays, from: fmtD(levels.from), to: fmtD(levels.to), n: levels.decisions, reviewed: levels.reviewed })}
          </Typography>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            {levels.metrics.map((m) => {
              const isRatio = m.unit === 'ratio';
              const shown = m.value == null ? '—' : isRatio ? confText(m.value) : pctText(m.value, 0);
              const target = m.target == null ? null : isRatio ? confText(m.target) : `${m.target}%`;
              const bar = m.value == null ? 0 : Math.min(100, isRatio ? m.value * 100 : m.value);
              return (
                <Grid item xs={12} sm={6} lg={4} key={m.key}>
                  <Card sx={{ p: 2, height: '100%', borderLeft: 3, borderLeftColor: m.meets === null ? 'divider' : m.meets ? 'success.main' : 'error.main' }}>
                    <Stack direction="row" alignItems="baseline" spacing={1}>
                      <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>{shown}</Typography>
                      {target && <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{m.key === 'falsePositiveHighRisk' ? t('agents.ceiling', { v: target }) : t('agents.target', { v: target })}</Typography>}
                    </Stack>
                    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{m.label}</Typography>
                    <LinearProgress variant="determinate" value={bar} aria-label={m.label} color={m.meets === null ? 'primary' : m.meets ? 'success' : 'error'} sx={{ mt: 1, height: 6, borderRadius: 3 }} />
                    {m.meets !== null && (
                      <Chip size="small" sx={{ mt: 1, height: 20, fontSize: 10.5 }} color={m.meets ? 'success' : 'error'} label={m.meets ? t('agents.meetsTarget') : t('agents.missesTarget')} />
                    )}
                  </Card>
                </Grid>
              );
            })}
          </Grid>
          <Section title={t('agents.highRiskTitle')} sub={t('agents.highRiskSub')}>
            <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap>
              <Box><Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{levels.highRiskCalls}</Typography><Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{t('agents.highRiskCalls')}</Typography></Box>
              <Box><Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{levels.highRiskReviewed}</Typography><Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{t('agents.highRiskReviewed')}</Typography></Box>
              <Box><Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{levels.falsePositives}</Typography><Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{t('agents.falsePositives')}</Typography></Box>
              <Box><Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20 }}>{levels.escalated}</Typography><Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{t('agents.escalatedCount')}</Typography></Box>
            </Stack>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1.5 }}>{t('agents.falsePositiveNote')}</Typography>
          </Section>
        </>
      ))}
    </>
  );
}
