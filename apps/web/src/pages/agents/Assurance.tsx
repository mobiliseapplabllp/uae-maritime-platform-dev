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
import type { AgentRow, BiasData, CoverageData, DriftData, ServiceLevelData } from './types';

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
  const lang = useAppSelector((s) => s.ui.lang);
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [tab, setTab] = useState(0);
  const [agentId, setAgentId] = useState('');
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [drift, setDrift] = useState<DriftData | null>(null);
  const [bias, setBias] = useState<BiasData | null>(null);
  const [levels, setLevels] = useState<ServiceLevelData | null>(null);
  const [adoption, setAdoption] = useState<CoverageData | null>(null);

  useEffect(() => { api.get<AgentRow[]>('/agents').then((r) => setAgents(r.data)).catch(() => {}); }, []);

  const load = useCallback(() => {
    const params = agentId ? { agentId } : {};
    setDrift(null); setBias(null); setLevels(null);
    const fail = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
    api.get<DriftData>('/agents/monitoring/drift', { params }).then((r) => setDrift(r.data)).catch(fail);
    api.get<BiasData>('/agents/monitoring/bias', { params }).then((r) => setBias(r.data)).catch(fail);
    api.get<ServiceLevelData>('/agents/monitoring/metrics', { params }).then((r) => setLevels(r.data)).catch(fail);
  }, [agentId, dispatch]);
  // adoption is a property of the catalogue rather than of any one agent, so the agent filter does not narrow it
  useEffect(() => {
    api.get<CoverageData>('/agents/coverage')
      .then((r) => setAdoption(r.data))
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [dispatch]);
  useEffect(() => { load(); }, [load]);

  const measured = drift?.perAgent.filter((a) => a.decisions > 0) ?? [];
  const serviceName = (r: { name: string; nameAr?: string }) => (lang === 'ar' && r.nameAr ? r.nameAr : r.name);

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
          <Tab label={t('agents.tabAdoption')} />
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
                  <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
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
                  </Box>
                  <Divider sx={{ my: 1 }} />
                  <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>{t('agents.confidenceDistribution')}</Typography>
                  <Box dir="ltr">
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={a.confidence} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                      <CartesianGrid stroke={grid} vertical={false} />
                      <XAxis dataKey="band" tick={{ fontSize: 9.5, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} interval={0} />
                      <YAxis tick={{ fontSize: 10, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <RTooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                      <Bar dataKey="decisions" fill="#75479C" name={t('agents.seriesDecisions')} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  </Box>
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

      {/* --------------------------------------------------------------- adoption */}
      {tab === 3 && (!adoption ? <Skeleton variant="rounded" height={360} /> : (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            {t('agents.adoptionWindow', { days: adoption.windowDays, from: fmtD(adoption.from), to: fmtD(adoption.to), n: adoption.requests, services: adoption.services })}
          </Typography>

          <Alert severity={adoption.target.meets ? 'success' : 'warning'} sx={{ mb: 2 }}>
            {adoption.target.meets ? t('agents.aheadOfSchedule') : t('agents.behindSchedule')}
            {' — '}
            {t('agents.owedToday', { v: adoption.target.required })}
            {', '}
            {t('agents.monthsIn', { n: adoption.target.monthsElapsed, of: 24 })}
            {'. '}
            {adoption.target.servicesToRequired > 0 && `${t('agents.servicesToRequired', { n: adoption.target.servicesToRequired })}. `}
            {adoption.target.servicesToEndTarget > 0 && `${t('agents.servicesToEnd', { n: adoption.target.servicesToEndTarget, v: adoption.target.endTarget })}.`}
          </Alert>

          <Grid container spacing={2} sx={{ mb: 2 }}>
            {[
              { key: 'serviceRate', label: t('agents.serviceRate'), value: adoption.serviceRate, of: `${adoption.covered} / ${adoption.services}`, target: adoption.target.required, meets: adoption.target.meets },
              { key: 'requestRate', label: t('agents.requestRate'), value: adoption.requestRate, of: `${adoption.requestsTouched} / ${adoption.requests}`, target: null, meets: null },
              { key: 'autonomousRate', label: t('agents.autonomousRate'), value: adoption.autonomousRate, of: `${adoption.autonomousServices} / ${adoption.services}`, target: null, meets: null },
            ].map((m) => (
              <Grid item xs={12} sm={4} key={m.key}>
                <Card sx={{ p: 2, height: '100%', borderLeft: 3, borderLeftColor: m.meets === null ? 'divider' : m.meets ? 'success.main' : 'warning.main' }}>
                  <Stack direction="row" alignItems="baseline" spacing={1}>
                    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 24, fontVariantNumeric: 'tabular-nums' }}>{pctText(m.value, 1)}</Typography>
                    {m.target != null && <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{t('agents.owedToday', { v: m.target })}</Typography>}
                  </Stack>
                  <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{m.label}</Typography>
                  <LinearProgress variant="determinate" value={Math.min(100, m.value ?? 0)} aria-label={m.label}
                    color={m.meets === null ? 'primary' : m.meets ? 'success' : 'warning'} sx={{ mt: 1, height: 6, borderRadius: 3 }} />
                  <Typography sx={{ fontFamily: MONO, fontSize: 11, color: 'text.secondary', mt: 0.75 }}>{m.of}</Typography>
                </Card>
              </Grid>
            ))}
          </Grid>

          <Alert severity="info" icon={false} sx={{ mb: 2, fontSize: 13 }}>
            <div>{t('agents.directiveSchedule', { a: adoption.target.startTarget, b: adoption.target.endTarget })}</div>
            <div style={{ marginTop: 6 }}>{t('agents.coverageDenominator', { n: adoption.services, unused: adoption.withoutRequests })}</div>
            <div style={{ marginTop: 6 }}>{t('agents.coverageBreadthDepth')}</div>
          </Alert>

          {adoption.requests === 0 ? (
            <Card sx={{ p: 6, textAlign: 'center' }}><Typography color="text.secondary">{t('agents.noCoverageData')}</Typography></Card>
          ) : (
            <Grid container spacing={2}>
              <Grid item xs={12} lg={5}>
                <Section title={t('agents.byDomainTitle')} sub={t('agents.byDomainSub')}>
                  {/* The plot area is laid out left to right in both languages. Recharts reserves the axis
                      gutter in its own coordinates and does not mirror them, so under an RTL document the
                      category labels are painted where the bars are drawn and disappear behind them. The
                      labels themselves still shape right to left, which is what has to be readable; a
                      percentage axis running 0 to 100 reads the same way round either way. */}
                  <Box dir="ltr">
                  <ResponsiveContainer width="100%" height={Math.max(200, adoption.byDomain.length * 38)}>
                    <BarChart layout="vertical" data={adoption.byDomain.map((d) => ({ ...d, label: t(`domains.d${d.domain}`, { defaultValue: `${t('agents.colDomain')} ${d.domain}` }) }))}
                      margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke={grid} horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} unit="%" />
                      <YAxis type="category" dataKey="label" width={lang === 'ar' ? 170 : 148} tick={{ fontSize: 10.5, fill: axis }} axisLine={false} tickLine={false} />
                      <RTooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                      <Bar dataKey="rate" fill="#0E7C86" name={t('agents.serviceRate')} radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  </Box>
                </Section>
              </Grid>
              <Grid item xs={12} lg={7}>
                <Section title={t('agents.coverageServicesTitle')} sub={t('agents.coverageServicesSub')}>
                  <TableContainer sx={{ maxHeight: 460 }}>
                    <Table size="small" stickyHeader>
                      <TableHead>
                        <TableRow>
                          <TableCell>{t('agents.colService')}</TableCell>
                          <TableCell align="right">{t('agents.colApplications')}</TableCell>
                          <TableCell align="right">{t('agents.colTouched')}</TableCell>
                          <TableCell align="right">{t('agents.colDecisions')}</TableCell>
                          <TableCell>{t('agents.colLastTouched')}</TableCell>
                          <TableCell>{t('agents.colCovered')}</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {adoption.rows.map((r) => (
                          <TableRow key={r.code} hover>
                            <TableCell>
                              <Typography sx={{ fontSize: 12.5 }}>{serviceName(r)}</Typography>
                              <Tooltip title={r.agents.join(', ')} placement="top-start">
                                <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: 'text.secondary' }}>{r.code}</Typography>
                              </Tooltip>
                            </TableCell>
                            <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12 }}>{r.requests}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12 }}>{r.touched}</TableCell>
                            <TableCell align="right" sx={{ fontFamily: MONO, fontSize: 12 }}>{r.decisions}</TableCell>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 11, color: 'text.secondary' }}>{r.lastAt ? fmtD(r.lastAt) : '—'}</TableCell>
                            <TableCell>
                              <Chip size="small" sx={{ height: 20, fontSize: 10.5 }}
                                color={r.covered ? 'success' : 'default'} variant={r.covered ? 'filled' : 'outlined'}
                                label={r.covered ? t('agents.covered') : r.requests === 0 ? t('agents.noApplications') : t('agents.notCovered')} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Section>
              </Grid>
            </Grid>
          )}
        </>
      ))}
    </>
  );
}
