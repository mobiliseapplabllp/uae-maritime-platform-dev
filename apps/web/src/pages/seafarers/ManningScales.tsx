import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Chip, Divider, IconButton, MenuItem, Stack, TextField, Typography } from '@mui/material';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import DataTable from '../../components/common/DataTable';
import FormDrawer from '../../components/common/FormDrawer';
import FormFields from '../../components/common/FormFields';
import EntityHover from '../../components/common/EntityHover';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import type { Column, FieldSpec } from '../../types';
import { RANK_LOOKUP } from './shared';
import type { ManningScale, ScalePayload } from './metTypes';

/* Safe manning — every ship's minimum safe manning scale read against who the register has aboard, and the
 * editor the flag desk records a scale with. Capacities are rank codes, grades are competency-grade codes and
 * the trading area is a master too: nothing here is typed free. */
interface ListState { rows: ManningScale[]; total: number; page: number; limit: number; q: string; sort: string; compliant: string; loading: boolean }
type Row = { rank: string; count: number; cocGrade: string; notes: string };

export default function ManningScales() {
  const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const ranks = useLookups(RANK_LOOKUP); const grades = useLookups('cocGrade'); const areas = useLookups('tradingArea');
  const [state, setState] = useState<ListState>({ rows: [], total: 0, page: 1, limit: 20, q: '', sort: 'vesselName', compliant: '', loading: true });
  const [editing, setEditing] = useState<ManningScale | null>(null);
  const [head, setHead] = useState<Record<string, any>>({});
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false); const [refresh, setRefresh] = useState(0);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  useEffect(() => {
    setState((x) => ({ ...x, loading: true }));
    api.get<ManningScale[]>('/seafarers/manning', { params: { page: state.page, limit: state.limit, q: state.q || undefined, sort: state.sort, compliant: state.compliant || undefined } })
      .then((r) => setState((x) => ({ ...x, rows: r.data, total: r.meta?.total ?? r.data.length, loading: false })))
      .catch((e: Error) => { err(e); setState((x) => ({ ...x, loading: false })); });
  }, [state.page, state.limit, state.q, state.sort, state.compliant, err, refresh]);
  const set = (patch: Partial<ListState>) => setState((x) => ({ ...x, ...patch, page: 1 }));
  const canEdit = hasPerm(user, 'seafarers.edit');
  const open = (s: ManningScale) => {
    setEditing(s);
    setHead({ tradingArea: s.tradingArea || areas.options[0]?.value || '', msmdNo: s.msmdNo, issuedOn: toInputD(s.issuedOn), expiresOn: toInputD(s.expiresOn), remarks: s.remarks });
    setRows(s.rows.length ? s.rows.map((r) => ({ rank: r.rankCode, count: r.count, cocGrade: r.cocGrade, notes: r.notes })) : [{ rank: '', count: 1, cocGrade: '', notes: '' }]);
  };
  const headFields: FieldSpec[] = [
    { name: 'tradingArea', label: t('seafarers.mn.tradingArea'), type: 'select', required: true, lookup: 'tradingArea' }, { name: 'msmdNo', label: t('seafarers.mn.msmdNo') },
    { name: 'issuedOn', label: t('seafarers.mn.issuedOn'), type: 'date' }, { name: 'expiresOn', label: t('seafarers.mn.expiresOn'), type: 'date' },
    { name: 'remarks', label: t('seafarers.mn.remarks'), type: 'multiline', cols: 12 },
  ];
  const valid = !!head.tradingArea && rows.length > 0 && rows.every((r) => r.rank && Number(r.count) >= 1);
  const save = () => {
    if (!editing) return;
    setBusy(true);
    const body: ScalePayload = { tradingArea: head.tradingArea, msmdNo: head.msmdNo || '', issuedOn: head.issuedOn || null, expiresOn: head.expiresOn || null, remarks: head.remarks || '', rows: rows.map((r) => ({ rank: r.rank, count: Number(r.count), cocGrade: r.cocGrade || undefined, notes: r.notes || '' })) };
    api.put(`/seafarers/manning/${editing.vesselId}`, body).then(() => { dispatch(notify(t('seafarers.mn.saved'))); setEditing(null); setRefresh((n) => n + 1); }).catch(err).finally(() => setBusy(false));
  };
  const compliance = (s: ManningScale) => (!s.recorded ? <Chip size="small" variant="outlined" label={t('seafarers.mn.notRecorded')} sx={{ height: 20, fontSize: 10.5 }} /> : s.compliance?.ok ? <Chip size="small" color="success" label={t('seafarers.mn.compliant')} sx={{ height: 20, fontSize: 10.5 }} /> : <Chip size="small" color="error" label={t('seafarers.mn.short', { count: s.compliance?.shortfalls ?? 0 })} sx={{ height: 20, fontSize: 10.5 }} />);
  const columns: Column<ManningScale>[] = [
    { key: 'vesselName', label: t('seafarers.mn.vessel'), sortable: true, render: (s) => <EntityHover type="vessel" id={s.vesselId}><b>{s.vesselName}</b></EntityHover> },
    { key: 'imo', label: t('seafarers.mn.imo'), sortable: true, mono: true },
    { key: 'msmdNo', label: t('seafarers.mn.msmd'), render: (s) => (s.msmdNo ? <><span style={{ fontFamily: MONO, fontSize: 12 }}>{s.msmdNo}</span>{s.issuedOn && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtD(s.issuedOn)}</Typography>}</> : <Typography variant="caption" color="text.secondary">{t('seafarers.mn.undocumented')}</Typography>), exportValue: (s) => s.msmdNo },
    { key: 'tradingArea', label: t('seafarers.mn.tradingArea'), sortable: true, render: (s) => areas.label(s.tradingArea) || s.tradingAreaLabel || '—', exportValue: (s) => areas.label(s.tradingArea) || s.tradingArea },
    { key: 'total', label: t('seafarers.mn.total'), align: 'right', render: (s) => <span style={{ fontFamily: MONO }}>{s.total}</span> },
    { key: 'officers', label: t('seafarers.mn.officers'), align: 'right', render: (s) => <span style={{ fontFamily: MONO }}>{s.officers}</span> },
    { key: 'onBoard', label: t('seafarers.mn.onBoard'), align: 'right', render: (s) => <span style={{ fontFamily: MONO }}>{s.compliance?.listed ?? 0}</span>, exportValue: (s) => s.compliance?.listed ?? 0 },
    { key: 'compliance', label: t('seafarers.mn.compliance'), render: compliance, exportValue: (s) => (!s.recorded ? '' : s.compliance?.ok ? 'OK' : `SHORT ${s.compliance?.shortfalls}`) },
  ];
  return (
    <>
      <PageHeader icon={GroupsRoundedIcon} iconColor="#75479C" title={t('seafarers.mn.title')} sub={t('seafarers.mn.sub')} />
      <DataTable<ManningScale> columns={columns} rows={state.rows} total={state.total} page={state.page} limit={state.limit} loading={state.loading}
        onPage={(page) => setState((x) => ({ ...x, page }))} onLimit={(limit) => set({ limit })} search={state.q} onSearch={(q) => set({ q })} searchPlaceholder={t('seafarers.mn.searchPlaceholder')}
        sort={state.sort} onSort={(sort) => set({ sort })} onRowClick={canEdit ? open : undefined} rowKey={(s) => s.vesselId}
        toolbar={<TextField select size="small" label={t('seafarers.mn.compliance')} value={state.compliant} onChange={(e) => set({ compliant: e.target.value })} sx={{ minWidth: 190 }}><MenuItem value="">{t('seafarers.mn.anyCompliance')}</MenuItem><MenuItem value="false">{t('seafarers.mn.onlyShort')}</MenuItem><MenuItem value="true">{t('seafarers.mn.onlyCompliant')}</MenuItem></TextField>} />
      <FormDrawer open={!!editing} title={t('seafarers.mn.edit')} subtitle={editing ? `${editing.vesselName} · IMO ${editing.imo}` : ''} onClose={() => setEditing(null)} busy={busy} disabled={!valid} onSubmit={save} submitLabel={t('common.save')} width="min(860px, 80vw)">
        <FormFields fields={headFields} values={head} onChange={setHead} />
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('seafarers.mn.rows')}</Typography>
        <Stack spacing={1}>
          {rows.map((r, i) => (
            <Stack key={i} direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap data-testid={`scale-row-${i + 1}`}>
              <TextField select size="small" label={t('seafarers.mn.rank')} value={r.rank} onChange={(e) => { const code = e.target.value; setRows(rows.map((x, k) => (k === i ? { ...x, rank: code, cocGrade: x.cocGrade || String(ranks.meta(code).cocGrade ?? '') } : x))); }} sx={{ minWidth: 220 }} required>
                {ranks.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </TextField>
              <TextField size="small" type="number" label={t('seafarers.mn.count')} value={r.count} inputProps={{ min: 1, max: 99 }} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, count: Number(e.target.value) } : x)))} sx={{ width: 110 }} required />
              <TextField select size="small" label={t('seafarers.mn.cocGrade')} value={r.cocGrade} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, cocGrade: e.target.value } : x)))} sx={{ minWidth: 220 }} helperText={i === 0 ? t('seafarers.mn.gradeHelper') : undefined}>
                <MenuItem value="">—</MenuItem>{grades.options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </TextField>
              <TextField size="small" label={t('seafarers.mn.notes')} value={r.notes} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, notes: e.target.value } : x)))} sx={{ flex: 1, minWidth: 160 }} />
              <IconButton size="small" aria-label={`${t('seafarers.mn.remove')} ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, k) => k !== i))}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
            </Stack>
          ))}
          <Box><Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setRows([...rows, { rank: '', count: 1, cocGrade: '', notes: '' }])}>{t('seafarers.mn.addRow')}</Button></Box>
          {rows.length === 0 && <Typography color="error">{t('seafarers.mn.noRows')}</Typography>}
        </Stack>
      </FormDrawer>
    </>
  );
}
