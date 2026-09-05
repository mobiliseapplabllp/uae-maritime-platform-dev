import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Box, Typography, Skeleton, Stack, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Divider, Chip, TextField } from '@mui/material';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import GridOnRoundedIcon from '@mui/icons-material/GridOnRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import AssessmentRoundedIcon from '@mui/icons-material/AssessmentRounded';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { CHART_SERIES, chartChrome, MONO } from '../../theme';
import { fmtDT } from '../../utils/format';
import { chartRows, chartSpec, columnLabel, fmtCell } from './shared';
import type { ReportRun } from './types';

/* Generic report viewer — runs any saved report with its parameters and renders the rows as a table, a chart where the shape allows one, and Excel / PDF / print export. */
const MONO_KEYS = /(^|_)(vcn|berth|number|code|imo|no|ref|cdc_no)$/;

export default function ReportViewer() {
  const { key = '' } = useParams<{ key: string }>();
  const dispatch = useAppDispatch();
  const lang = useAppSelector((s) => s.ui.lang);
  const mode = useAppSelector((s) => s.ui.mode);
  const { t } = useTranslation();
  const C = CHART_SERIES[mode];
  const { axis, grid, tooltipStyle } = chartChrome(mode);
  const [data, setData] = useState<ReportRun | null>(null);
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback((p: Record<string, string>) => {
    setData(null);
    api.get<ReportRun>(`/reports/run/${key}`, { params: p }).then((r) => { setData(r.data); setParams(r.data.params || {}); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [key, dispatch]);
  useEffect(() => { setParams({}); load({}); }, [load]);

  const def = data?.report;
  const title = def ? (lang === 'ar' && def.name_ar ? def.name_ar : def.name) : key;
  const spec = data ? chartSpec(data.report.columns, data.rows) : null;
  const colors = [C.container, C.dryBulk, C.liquid];
  const doExcel = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const { exportExcel } = await import('../../utils/exportUtils');
      await exportExcel({ name: key, sheets: [{ name: def!.name.slice(0, 26), columns: def!.columns.map((c) => ({ key: c.key, label: columnLabel(c) })), rows: data.rows }] });
      dispatch(notify(t('mis.excelReady')));
    } catch (e) { dispatch(notify({ message: (e as Error).message, severity: 'error' })); } finally { setBusy(false); }
  };
  const doPdf = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const { exportPdf } = await import('../../utils/exportUtils');
      await exportPdf({ name: key, title: def!.name, subtitle: `${def!.description} · ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' · ')}`, sections: [{ columns: def!.columns.map((c) => ({ key: c.key, label: columnLabel(c), align: c.align as 'left' | 'right' | 'center' | undefined, value: (r: Record<string, unknown>) => fmtCell(r[c.key], c.key) })), rows: data.rows }], landscape: true });
      dispatch(notify(t('mis.pdfReady')));
    } catch (e) { dispatch(notify({ message: (e as Error).message, severity: 'error' })); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader icon={AssessmentRoundedIcon} iconColor="#0B5D8A" crumbs={[{ label: t('mis.libraryTitle'), to: '/reports' }, { label: title }]}
        title={data ? title : t('mis.running')} sub={data ? `${def!.description} · ${t('mis.generated', { at: fmtDT(data.generatedAt) })}` : undefined}
        actions={(
          <Stack direction="row" spacing={1} sx={{ displayPrint: 'none' }}>
            <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={() => load(params)}>{t('mis.rerun')}</Button>
            <Button size="small" variant="outlined" startIcon={<GridOnRoundedIcon />} onClick={doExcel} disabled={!data || busy}>{t('mis.excel')}</Button>
            <Button size="small" variant="outlined" startIcon={<PictureAsPdfRoundedIcon />} onClick={doPdf} disabled={!data || busy}>{t('mis.pdf')}</Button>
            <Button size="small" variant="contained" startIcon={<PrintRoundedIcon />} onClick={() => window.print()} disabled={!data}>{t('mis.print')}</Button>
          </Stack>
        )} />
      {def && def.params.length > 0 && (
        <Card sx={{ p: 1.5, mb: 2, display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', displayPrint: 'none' }} component="form" onSubmit={(e) => { e.preventDefault(); load(params); }} aria-label={t('mis.parameters')}>
          {def.params.map((p) => (
            <TextField key={p.name} size="small" type={p.type === 'number' ? 'number' : 'text'} label={p.label} value={params[p.name] ?? String(p.default ?? '')} onChange={(e) => setParams((x) => ({ ...x, [p.name]: e.target.value }))} sx={{ width: 160 }} inputProps={p.type === 'number' ? { min: 1, max: 3650 } : undefined} />
          ))}
          <Button type="submit" variant="contained" startIcon={<PlayArrowRoundedIcon />}>{t('mis.runReport')}</Button>
          {data && <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{t('mis.rowCount', { count: data.rows.length })}</Typography>}
        </Card>
      )}
      {!data ? <Skeleton variant="rounded" height={480} aria-busy="true" /> : (
        <Stack spacing={2.5}>
          {spec && (
            <Card sx={{ p: 2 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 14.5, mb: 1 }}>{t('mis.chartTitle', { series: spec.series.map((s) => columnLabel(def!.columns.find((c) => c.key === s)!)).join(', ') })}</Typography>
              <Box sx={{ height: 260 }}>
                <Box dir="ltr">{/* Charts are laid out left to right in both languages: Recharts does not mirror its axis gutters under RTL, so category labels would be painted behind the bars. */}
                <ResponsiveContainer>
                  <BarChart data={chartRows(data.rows, spec)} barCategoryGap="28%">
                    <CartesianGrid stroke={grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} axisLine={{ stroke: grid }} tickLine={false} interval={0} angle={data.rows.length > 14 ? -35 : 0} textAnchor={data.rows.length > 14 ? 'end' : 'middle'} height={data.rows.length > 14 ? 56 : 30} />
                    <YAxis tick={{ fill: axis, fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip contentStyle={tooltipStyle} cursor={{ fill: grid, opacity: 0.35 }} />
                    {spec.series.length > 1 && <Legend formatter={(v: string) => <span style={{ color: axis, fontSize: 12 }}>{columnLabel(def!.columns.find((c) => c.key === v)!)}</span>} iconSize={10} />}
                    {spec.series.map((s, i) => <Bar key={s} dataKey={s} name={columnLabel(def!.columns.find((c) => c.key === s)!)} fill={colors[i % colors.length]} radius={[3, 3, 0, 0]} />)}
                  </BarChart>
                </ResponsiveContainer>
                </Box>
              </Box>
            </Card>
          )}
          <Card>
            <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: 14.5 }}>{def!.name}</Typography>
              <Chip size="small" variant="outlined" label={t('mis.rowCount', { count: data.rows.length })} sx={{ height: 18, fontSize: 10 }} />
              {data.currency && <Chip size="small" variant="outlined" label={data.currency} sx={{ height: 18, fontSize: 10, fontFamily: MONO }} />}
            </Box>
            <Divider />
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label={def!.name}>
                <TableHead><TableRow>{def!.columns.map((c) => <TableCell key={c.key} align={c.align as 'left' | 'right' | 'center' | undefined}>{columnLabel(c)}</TableCell>)}</TableRow></TableHead>
                <TableBody>
                  {data.rows.map((r, j) => (
                    <TableRow key={j} hover>
                      {def!.columns.map((c) => <TableCell key={c.key} align={c.align as 'left' | 'right' | 'center' | undefined} sx={MONO_KEYS.test(c.key) ? { fontFamily: MONO, fontSize: 12 } : { fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>{fmtCell(r[c.key], c.key)}</TableCell>)}
                    </TableRow>
                  ))}
                  {data.rows.length === 0 && <TableRow><TableCell colSpan={def!.columns.length}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('mis.nothingToReport')}</Typography></TableCell></TableRow>}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>{t('mis.footer')}</Typography>
        </Stack>
      )}
    </>
  );
}
