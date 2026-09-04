import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Card, Grid, Typography, Chip, Skeleton, Stack, ToggleButtonGroup, ToggleButton, Table, TableHead, TableRow, TableCell, TableBody, IconButton, Button, TableContainer, Tooltip } from '@mui/material';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import TableRowsRoundedIcon from '@mui/icons-material/TableRowsRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import BuildRoundedIcon from '@mui/icons-material/BuildRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import api from '../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../store';
import { notify } from '../store/uiSlice';
import { hasPerm } from '../utils/perms';
import PageHeader from '../components/common/PageHeader';
import PageStats from '../components/common/PageStats';
import FormFields from '../components/common/FormFields';
import FormDrawer from '../components/common/FormDrawer';
import ConfirmDialog from '../components/common/ConfirmDialog';
import StatusChip from '../components/common/StatusChip';
import { BERTH_STATUS_META, type ChipColor } from '../utils/status';
import { fmtDT, fromNow } from '../utils/format';
import { MONO } from '../theme';
import type { DashboardData } from './Dashboard';
import type { FieldSpec } from '../types';

type BerthRow = DashboardData['berthBoard'][number];
interface Berth { id: string; code: string; name: string; terminal: string; berthType: string; loaMax: number; draftMax: number; status: string; remarks?: string }
const TYPES = ['CONTAINER', 'BULK', 'MULTIPURPOSE', 'LIQUID', 'RORO', 'SPM', 'COAL'].map((t) => ({ value: t, label: t }));
const FORM_FIELDS: FieldSpec[] = [
  { name: 'code', label: 'Berth code', required: true }, { name: 'name', label: 'Name', required: true },
  { name: 'terminal', label: 'Terminal', required: true }, { name: 'berthType', label: 'Type', type: 'select', required: true, options: TYPES },
  { name: 'loaMax', label: 'Max LOA (m)', type: 'number', required: true }, { name: 'draftMax', label: 'Max draft (m)', type: 'number', required: true },
  { name: 'status', label: 'Status', type: 'select', options: Object.entries(BERTH_STATUS_META).map(([value, m]) => ({ value, label: m.label })) },
  { name: 'remarks', label: 'Remarks', type: 'multiline', cols: 12 },
];

export default function BerthBoard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [view, setView] = useState<'cards' | 'table'>(() => { try { return (localStorage.getItem('berth-view') as 'cards' | 'table') || 'cards'; } catch { return 'cards'; } });
  const [editing, setEditing] = useState<Berth | Record<string, never> | null>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [deleting, setDeleting] = useState<BerthRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [statsKey, setStatsKey] = useState(0);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const mode = useAppSelector((s) => s.ui.mode);
  const canManage = hasPerm(user, 'masters.manage');
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<DashboardData>('/dashboard').then((r) => setData(r.data)).catch(err), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const setViewPersist = (v: 'cards' | 'table' | null) => { if (!v) return; setView(v); try { localStorage.setItem('berth-view', v); } catch { /* ignore */ } };

  if (!data) return <Skeleton variant="rounded" height={420} />;
  const terminals = [...new Set(data.berthBoard.map((b) => b.terminal))];
  const done = () => { load(); setStatsKey((k) => k + 1); };
  const openNew = () => { setValues({ status: 'OPERATIONAL', berthType: 'MULTIPURPOSE' }); setEditing({}); };
  const openEdit = (b: BerthRow) => api.get<Berth>(`/berths/${b.id}`).then((r) => { const d = r.data; setValues({ code: d.code, name: d.name, terminal: d.terminal, berthType: d.berthType, loaMax: d.loaMax, draftMax: d.draftMax, status: d.status, remarks: d.remarks || '' }); setEditing(d); }).catch(err);
  const editingId = editing && 'id' in editing ? (editing as Berth).id : undefined;
  const save = () => {
    setBusy(true);
    const req = editingId ? api.put(`/berths/${editingId}`, values) : api.post('/berths', values);
    req.then(() => { dispatch(notify(editingId ? 'Berth updated' : 'Berth created')); setEditing(null); done(); }).catch(err).finally(() => setBusy(false));
  };
  const toggleMaintenance = (b: BerthRow) => api.get<Berth>(`/berths/${b.id}`).then((r) => api.put(`/berths/${b.id}`, { status: r.data.status === 'OPERATIONAL' ? 'MAINTENANCE' : 'OPERATIONAL' })).then(() => { dispatch(notify('Berth status updated')); done(); }).catch(err);
  const occupancy = (b: BerthRow): [string, ChipColor] => (b.status === 'MAINTENANCE' ? ['Maintenance', 'warning'] : b.occupiedBy ? ['Occupied', 'primary'] : ['Free', 'default']);
  const OccChip = ({ b }: { b: BerthRow }) => { const [l, c] = occupancy(b); return <Chip size="small" label={l} color={c === 'default' ? undefined : c} variant={c === 'default' ? 'outlined' : 'filled'} sx={{ height: 20, fontSize: 10.5 }} />; };

  return (
    <>
      <PageHeader icon={AnchorRoundedIcon} iconColor="#056A73" title="Berth board" sub="Live occupancy across every terminal — with the berth master maintained in place"
        actions={<>
          <ToggleButtonGroup exclusive size="small" value={view} onChange={(_, v) => setViewPersist(v)} aria-label="View">
            <ToggleButton value="cards" aria-label="Cards"><GridViewRoundedIcon sx={{ fontSize: 18, mr: 0.5 }} />Cards</ToggleButton>
            <ToggleButton value="table" aria-label="Table"><TableRowsRoundedIcon sx={{ fontSize: 18, mr: 0.5 }} />Table</ToggleButton>
          </ToggleButtonGroup>
          {canManage && <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={openNew}>Add berth</Button>}
        </>} />
      <PageStats scope="berths" refreshKey={statsKey} />
      {view === 'cards' ? (
        <Stack spacing={2.5}>
          {terminals.map((t) => (
            <Box key={t}>
              <Typography sx={{ fontFamily: MONO, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}>{t}</Typography>
              <Grid container spacing={1.5}>
                {data.berthBoard.filter((b) => b.terminal === t).map((b) => (
                  <Grid item xs={12} sm={6} md={3} key={b.code}>
                    <Card sx={{ p: 1.75, height: '100%', position: 'relative', borderColor: b.occupiedBy ? 'primary.main' : 'divider', bgcolor: b.status === 'MAINTENANCE' ? (mode === 'dark' ? 'rgba(224,166,78,0.10)' : 'rgba(156,100,18,0.06)') : b.occupiedBy ? (mode === 'dark' ? 'rgba(87,176,227,0.09)' : 'rgba(11,116,176,0.05)') : 'background.paper' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><Typography sx={{ fontFamily: MONO, fontWeight: 600, fontSize: 13 }}>{b.code}</Typography><OccChip b={b} /></Box>
                      {b.occupiedBy ? (
                        <Box sx={{ cursor: 'pointer' }} onClick={() => navigate(`/port-calls/${b.occupiedBy!.callId}`)}>
                          <Typography noWrap sx={{ fontWeight: 700, mt: 1 }}>{b.occupiedBy.vessel}</Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{b.occupiedBy.vcn} · berthed {fmtDT(b.occupiedBy.atb)}</Typography>
                          <Typography variant="caption" sx={{ color: 'primary.dark', fontWeight: 600 }}>ETD {fromNow(b.occupiedBy.etd)}</Typography>
                        </Box>
                      ) : <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{b.status === 'MAINTENANCE' ? b.name : `${b.name} — available`}</Typography>}
                      {canManage && (
                        <Stack direction="row" spacing={0.25} sx={{ position: 'absolute', bottom: 6, right: 6, opacity: 0.75 }}>
                          <Tooltip title={b.status === 'MAINTENANCE' ? 'Return to service' : 'Set maintenance'}><IconButton size="small" onClick={() => toggleMaintenance(b)} aria-label="Toggle maintenance"><BuildRoundedIcon sx={{ fontSize: 15 }} /></IconButton></Tooltip>
                          <IconButton size="small" onClick={() => openEdit(b)} aria-label="Edit berth"><EditRoundedIcon sx={{ fontSize: 15 }} /></IconButton>
                        </Stack>
                      )}
                    </Card>
                  </Grid>
                ))}
              </Grid>
            </Box>
          ))}
        </Stack>
      ) : (
        <Card>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>Code</TableCell><TableCell>Terminal</TableCell><TableCell>Type</TableCell><TableCell align="right">Max LOA</TableCell><TableCell align="right">Max draft</TableCell>
                <TableCell>Occupancy</TableCell><TableCell>Vessel</TableCell><TableCell>ETD</TableCell><TableCell>Status</TableCell>{canManage && <TableCell align="right">Actions</TableCell>}
              </TableRow></TableHead>
              <TableBody>
                {data.berthBoard.map((b) => (
                  <TableRow key={b.code} hover>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 600 }}>{b.code}</TableCell><TableCell>{b.terminal}</TableCell><TableCell>{b.berthType}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{b.loaMax ?? '—'} m</TableCell><TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{b.draftMax ?? '—'} m</TableCell>
                    <TableCell><OccChip b={b} /></TableCell>
                    <TableCell>{b.occupiedBy ? <Typography sx={{ fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'primary.dark' }} onClick={() => navigate(`/port-calls/${b.occupiedBy!.callId}`)}>{b.occupiedBy.vessel}</Typography> : '—'}</TableCell>
                    <TableCell>{b.occupiedBy ? fmtDT(b.occupiedBy.etd) : '—'}</TableCell>
                    <TableCell><StatusChip value={b.status} map={BERTH_STATUS_META} /></TableCell>
                    {canManage && (
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title={b.status === 'MAINTENANCE' ? 'Return to service' : 'Set maintenance'}><IconButton size="small" onClick={() => toggleMaintenance(b)} aria-label="Toggle maintenance"><BuildRoundedIcon fontSize="inherit" /></IconButton></Tooltip>
                          <IconButton size="small" onClick={() => openEdit(b)} aria-label="Edit berth"><EditRoundedIcon fontSize="inherit" /></IconButton>
                          <IconButton size="small" color="error" onClick={() => setDeleting(b)} aria-label="Delete berth"><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
                        </Stack>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
      <FormDrawer open={!!editing} busy={busy} title={editingId ? `Edit berth ${(editing as Berth).code}` : 'Add berth'} subtitle="Allocation checks run against these limits" onClose={() => setEditing(null)} onSubmit={save} submitLabel={editingId ? 'Save changes' : 'Create berth'}
        disabled={!values.code || !values.name || !values.terminal || !values.loaMax || !values.draftMax}>
        <FormFields fields={FORM_FIELDS} values={values} onChange={setValues} />
      </FormDrawer>
      <ConfirmDialog open={!!deleting} busy={busy} title={`Delete berth ${deleting?.code}?`} message="Berths with active or planned port calls are protected by the server." onClose={() => setDeleting(null)}
        onConfirm={() => { if (!deleting) return; setBusy(true); api.delete(`/berths/${deleting.id}`).then(() => { dispatch(notify('Berth deleted')); setDeleting(null); done(); }).catch(err).finally(() => setBusy(false)); }} />
    </>
  );
}
