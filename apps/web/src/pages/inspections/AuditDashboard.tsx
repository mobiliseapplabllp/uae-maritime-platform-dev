import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer } from '@mui/material';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import { chartChrome, MONO } from '../../theme';
import PageHeader from '../../components/common/PageHeader';
import type { InspectionDashboardData } from './types';

/* Survey & audit dashboard — outcome mix, deficiency intensity and checklist compliance across PSC/FSI/ISM/ISPS/MLC/HSE/terminal audits. */
const RESULT_COLORS = {
  light: { SATISFACTORY: '#056A73', DEFICIENCIES: '#B98A2F', DETAINED: '#C14F33' },
  dark: { SATISFACTORY: '#2FA6AE', DEFICIENCIES: '#B8892B', DETAINED: '#D0644A' },
} as const;

const Kpi = ({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: string }) => (
  <Card sx={{ px: 2, py: 1.5, borderLeft: 3, borderLeftColor: tone ? `${tone}.main` : 'divider' }}>
    <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    {sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{sub}</Typography>}
  </Card>
);

export default function AuditDashboard() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const mode = useAppSelector((s) => s.ui.mode);
  const RC = RESULT_COLORS[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<InspectionDashboardData | null>(null);

  useEffect(() => { api.get<InspectionDashboardData>('/inspections/dashboard').then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))); }, [dispatch]);

  if (!data) {
    return (
      <Grid container spacing={2} aria-busy="true">
        {Array.from({ length: 8 }).map((_, i) => <Grid item xs={6} md={3} key={i}><Skeleton variant="rounded" height={86} /></Grid>)}
        <Grid item xs={12}><Skeleton variant="rounded" height={300} /></Grid>
      </Grid>
    );
  }
  const k = data.kpis;

  return (
    <>
      <PageHeader icon={FactCheckRoundedIcon} iconColor="#9C6412" title={t('inspections.dashboardTitle')} sub={t('inspections.dashboardSub')}
        actions={<Button variant="contained" endIcon={<ArrowForwardRoundedIcon />} onClick={() => navigate('/inspections')}>{t('inspections.openRegister')}</Button>} />
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiOpen')} value={k.open} sub={t('inspections.kpiOpenSub', { n: k.closedYtd })} tone={k.open ? 'warning' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiSat')} value={`${k.satisfactionPct}%`} sub={t('inspections.kpiSatSub', { n: k.detentionRatePct })} tone={k.satisfactionPct >= 60 ? 'success' : 'warning'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiFindings')} value={k.avgFindings} sub={t('inspections.kpiFindingsSub', { n: k.openFindings })} tone={k.openFindings ? 'warning' : 'success'} /></Grid>
        <Grid item xs={6} md={3}><Kpi label={t('inspections.kpiCompliance')} value={`${k.checklistCompliancePct}%`} sub={t('inspections.kpiComplianceSub')} tone="info" /></Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid item xs={12} lg={7.5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.byMonth')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.byMonthSub')}</Typography>
            <ResponsiveContainer width="100%" height={270}>
              <BarChart data={data.byMonth} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: axis }} axisLine={{ stroke: grid }} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="SATISFACTORY" stackId="r" fill={RC.SATISFACTORY} name="Satisfactory" />
                <Bar dataKey="DEFICIENCIES" stackId="r" fill={RC.DEFICIENCIES} name="With deficiencies" />
                <Bar dataKey="DETAINED" stackId="r" fill={RC.DETAINED} name="Detained" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Grid>
        <Grid item xs={12} lg={4.5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('inspections.byType')}</Typography>
            <Typography variant="caption" color="text.secondary">{t('inspections.byTypeSub')}</Typography>
            <TableContainer sx={{ overflowX: 'auto', mt: 1 }}>
              <Table size="small" aria-label={t('inspections.byType')}>
                <TableHead><TableRow><TableCell>Type</TableCell><TableCell align="right">Total</TableCell><TableCell align="right">Closed</TableCell><TableCell align="right">Detained</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.byType.map((x) => (
                    <TableRow key={x.type} hover>
                      <TableCell><b>{x.type}</b></TableCell>
                      <TableCell align="right">{x.total}</TableCell>
                      <TableCell align="right">{x.closed}</TableCell>
                      <TableCell align="right">{x.detained || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <Box sx={{ mt: 1.5 }}>
              <Button size="small" onClick={() => navigate('/reports/view/deficiency-analysis')}>{t('inspections.deficiencyReport')}</Button>
              <Button size="small" onClick={() => navigate('/reports/view/checklist-compliance')}>{t('inspections.complianceReport')}</Button>
            </Box>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
