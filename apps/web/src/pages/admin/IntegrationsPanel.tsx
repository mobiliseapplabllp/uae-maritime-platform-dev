import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Drawer, FormControlLabel, Grid, IconButton, MenuItem, Stack, Switch, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import RefreshRoundedIcon from '@mui/icons-material/RefreshRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { fmtDT, fromNow } from '../../utils/format';
import { MONO } from '../../theme';

/*
 * Settings → Integrations. Every counterpart the platform talks to is an adapter here — the eight the RFP names and
 * any an administrator adds — with where it points, how it authenticates, how patient it is, what it answers in stub
 * mode, and what it has done lately. Credentials are written here and never read back; the screen only ever learns
 * that one is set.
 */
export type AuthType = 'none' | 'apiKey' | 'bearer' | 'basic';
export interface Operation { key: string; summary: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH'; path: string; required: string[]; idempotent: boolean; recorded?: boolean; sample?: { status: number; body: unknown } }
export interface Adapter {
  key: string; name: string; nameAr?: string | null; counterpart: string; kind: 'system' | 'custom'; protocol: 'rest' | 'soap'; description: string; reference: string | null;
  mode: 'stub' | 'live'; enabled: boolean; baseUrl: string | null; defaultBaseUrl: string | null; contractVersion: string; timeoutMs: number; maxAttempts: number;
  auth: { type: AuthType; header?: string }; secrets: Record<string, boolean>; headers: Record<string, string>; healthPath: string; schedule: { pollMinutes?: number | null };
  inbound: { enabled: boolean; secretSet: boolean }; operations: Operation[]; updatedAt: string | null; updatedBy: string | null;
  last24h: { calls: number; failed: number; dead: number; latencyP95: number | null; lastCallAt: string | null; inbound: number; lastInboundAt: string | null }; openDeadLetters: number;
  certification: { passed: number; operations: number; certifiedAt: string } | null;
}
export interface CallRow { id: string; operation: string; status: string; mode: string; httpStatus: number | null; attempts: number; durationMs: number | null; error: string | null; correlationId: string | null; startedAt: string }
export interface AdapterDetail extends Adapter { inboundUrl: string; recentCalls: CallRow[]; certifications: { contractVersion: string; operations: number; passed: number; certifiedAt: string }[]; recentInbound: { id: string; deliveryId: string; eventType: string; payload: unknown; receivedAt: string }[] }
interface DeadLetter { id: string; adapter: string; operation: string; error: string | null; attempts: number; createdAt: string; replayedAt: string | null }
interface TestOutcome { mode: string; ok: boolean; httpStatus: number | null; durationMs: number; detail: string; target: string | null }

export const SECRET_FIELDS: Record<AuthType, { key: string; label: string }[]> = { none: [], apiKey: [{ key: 'apiKey', label: 'API key' }], bearer: [{ key: 'token', label: 'Bearer token' }], basic: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }] };
const AUTH_TYPES: { value: AuthType; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'apiKey', label: 'API key header' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic (username and password)' },
];
const authLabel = (t: AuthType) => AUTH_TYPES.find((a) => a.value === t)?.label ?? t;
const ADAPTER_OPS = ['GET', 'POST', 'PUT', 'PATCH'] as const;
const modeColor = (m: string) => (m === 'live' ? 'success' : 'default');
const callColor = (s: string) => (s === 'ok' ? 'success' : s === 'dead' ? 'error' : s === 'failed' ? 'warning' : 'default');

type HeaderRow = { k: string; v: string };
const toRows = (h: Record<string, string>): HeaderRow[] => Object.entries(h || {}).map(([k, v]) => ({ k, v }));
const fromRows = (rows: HeaderRow[]) => Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));
const parseJson = (text: string): { value?: unknown; error?: string } => { if (!text.trim()) return { value: {} }; try { return { value: JSON.parse(text) }; } catch (e) { return { error: (e as Error).message }; } };

export default function IntegrationsPanel() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const canManage = hasPerm(user, 'settings.manage');
  const [rows, setRows] = useState<Adapter[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<Adapter[]>('/integrations').then((r) => setRows(r.data)).catch(err), [err]);
  useEffect(() => { load(); }, [load]);
  const totals = useMemo(() => ({ live: (rows ?? []).filter((r) => r.mode === 'live').length, dead: (rows ?? []).reduce((n, r) => n + r.openDeadLetters, 0), calls: (rows ?? []).reduce((n, r) => n + r.last24h.calls, 0), custom: (rows ?? []).filter((r) => r.kind === 'custom').length }), [rows]);

  return (
    <Box data-testid="integrations-panel">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <HubRoundedIcon color="primary" />
        <Typography variant="h6" sx={{ fontSize: 15 }}>Integrations</Typography>
        <Chip size="small" label={`${rows?.length ?? 0} adapters · ${totals.live} live · ${totals.custom} added`} />
        <Chip size="small" label={`${totals.calls} calls in 24 h`} variant="outlined" />
        {totals.dead > 0 && <Chip size="small" color="error" label={`${totals.dead} dead letter${totals.dead === 1 ? '' : 's'} open`} />}
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={load}>Refresh</Button>
        {canManage && <Button size="small" variant="contained" startIcon={<AddRoundedIcon />} onClick={() => setAdding(true)} data-testid="add-integration">Add integration</Button>}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Each counterpart the platform speaks to is an adapter. Point it at the real system when the connection date arrives, give it its credentials, test it, and switch it live — until then it answers from its recorded contract. A counterpart the RFP never named can be added with its own operations.
      </Typography>
      <Grid container spacing={2}>
        {(rows ?? []).map((a) => (
          <Grid item xs={12} md={6} lg={4} key={a.key}>
            <Card sx={{ p: 2, height: '100%', cursor: 'pointer', outline: 'none', '&:focus-visible': { boxShadow: (t) => `0 0 0 3px ${t.palette.primary.main}` } }} role="button" tabIndex={0} data-testid={`adapter-card-${a.key}`}
              onClick={() => setSelected(a.key)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(a.key); } }} aria-label={`${a.name}: ${a.mode} mode, ${a.enabled ? 'enabled' : 'disabled'}`}>
              <Stack direction="row" spacing={1} alignItems="flex-start">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 700 }} noWrap>{a.name}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{a.counterpart}</Typography>
                </Box>
                <Chip size="small" label={a.mode === 'live' ? 'Live' : 'Stub'} color={modeColor(a.mode)} sx={{ height: 20, fontSize: 11 }} />
              </Stack>
              <Stack direction="row" spacing={0.5} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                <Chip size="small" variant="outlined" label={a.kind === 'custom' ? 'Added' : 'Declared'} sx={{ height: 20, fontSize: 11 }} />
                <Chip size="small" variant="outlined" label={a.protocol.toUpperCase()} sx={{ height: 20, fontSize: 11 }} />
                {!a.enabled && <Chip size="small" color="warning" label="Disabled" sx={{ height: 20, fontSize: 11 }} />}
                {a.auth.type !== 'none' && <Chip size="small" variant="outlined" label={authLabel(a.auth.type)} sx={{ height: 20, fontSize: 11 }} />}
                {a.inbound.enabled && <Chip size="small" variant="outlined" color="info" label="Inbound" sx={{ height: 20, fontSize: 11 }} />}
                {a.openDeadLetters > 0 && <Chip size="small" color="error" label={`${a.openDeadLetters} dead`} sx={{ height: 20, fontSize: 11 }} />}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, fontFamily: MONO }}>
                {a.operations.length} ops · 24 h: {a.last24h.calls} calls{a.last24h.failed ? `, ${a.last24h.failed} failed` : ''}{a.last24h.latencyP95 != null ? ` · p95 ${a.last24h.latencyP95} ms` : ''}{a.last24h.lastCallAt ? ` · last ${fromNow(a.last24h.lastCallAt)}` : ''}
              </Typography>
              {a.certification && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Certified {a.certification.passed}/{a.certification.operations} · {fmtDT(a.certification.certifiedAt)}</Typography>}
            </Card>
          </Grid>
        ))}
      </Grid>
      {selected && <AdapterDrawer keyName={selected} canManage={canManage} onClose={() => setSelected(null)} onChanged={load} />}
      {adding && <AddIntegrationDialog onClose={() => setAdding(false)} onCreated={(key) => { setAdding(false); load(); setSelected(key); }} />}
    </Box>
  );
}

/* ------------------------------------------------------------------------------------- drawer --- */
function AdapterDrawer({ keyName, canManage, onClose, onChanged }: { keyName: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const dispatch = useAppDispatch();
  const [d, setD] = useState<AdapterDetail | null>(null);
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [ops, setOps] = useState<Operation[]>([]);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const [invokeOp, setInvokeOp] = useState('');
  const [invokePayload, setInvokePayload] = useState('{}');
  const [invokeResult, setInvokeResult] = useState<unknown>(null);
  const [issued, setIssued] = useState<{ secret: string; url: string; headers: Record<string, string>; signing: string } | null>(null);
  const [dead, setDead] = useState<DeadLetter[]>([]);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => Promise.all([api.get<AdapterDetail>(`/integrations/${keyName}`), api.get<DeadLetter[]>('/integrations/dead-letters', { params: { open: 'true' }, headers: { 'X-Quiet': '1' } }).catch(() => ({ data: [] as DeadLetter[] }))])
    .then(([r, dl]) => {
      const a = r.data; setD(a); setDead(dl.data.filter((x) => x.adapter === keyName));
      setForm({ name: a.name, nameAr: a.nameAr ?? '', counterpart: a.counterpart, description: a.description, mode: a.mode, baseUrl: a.baseUrl ?? '', enabled: a.enabled, timeoutMs: a.timeoutMs, maxAttempts: a.maxAttempts, healthPath: a.healthPath, authType: a.auth.type, authHeader: a.auth.header ?? '', pollMinutes: a.schedule?.pollMinutes ?? '' });
      setEntered({}); setHeaders(toRows(a.headers)); setOps(a.operations.map((o) => ({ ...o }))); if (!invokeOp && a.operations[0]) setInvokeOp(a.operations[0].key);
    }).catch(err), [keyName, err]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const body = () => {
    const out: Record<string, unknown> = {
      description: form.description, mode: form.mode, enabled: !!form.enabled, timeoutMs: Number(form.timeoutMs), maxAttempts: Number(form.maxAttempts), healthPath: form.healthPath,
      auth: { type: form.authType as AuthType, ...(form.authType === 'apiKey' && form.authHeader ? { header: form.authHeader } : {}) }, headers: fromRows(headers),
      schedule: { pollMinutes: form.pollMinutes === '' ? null : Number(form.pollMinutes) },
    };
    if (Object.keys(entered).length) out.secrets = entered;
    // the address travels only when it was edited: a stub address is the adapter's own and is not re-validated on every save
    if ((form.baseUrl ?? '') !== (d?.baseUrl ?? '')) out.baseUrl = form.baseUrl ? form.baseUrl : null;
    if (d?.kind === 'custom') { out.name = form.name; out.nameAr = form.nameAr || null; out.counterpart = form.counterpart; out.operations = ops.map(({ recorded: _r, ...o }) => o); }
    return out;
  };
  const save = () => {
    if (d && form.mode === 'live' && d.mode !== 'live' && !confirmLive) { setConfirmLive(true); return; }
    setConfirmLive(false); setBusy(true);
    api.put<Adapter>(`/integrations/${keyName}`, body()).then(() => { dispatch(notify(`${d?.name ?? keyName} saved`)); load(); onChanged(); }).catch(err).finally(() => setBusy(false));
  };
  const runTest = () => { setBusy(true); setTest(null); api.post<TestOutcome>(`/integrations/${keyName}/test`, {}).then((r) => { setTest(r.data); load(); }).catch(err).finally(() => setBusy(false)); };
  const certify = () => { setBusy(true); api.post<{ passed: number; operations: number }>(`/integrations/${keyName}/certify`, {}).then((r) => { dispatch(notify(`Certified ${r.data.passed} of ${r.data.operations} operations against the recorded contract`)); load(); onChanged(); }).catch(err).finally(() => setBusy(false)); };
  const invoke = () => {
    const parsed = parseJson(invokePayload); if (parsed.error) { err(new Error(`Payload is not valid JSON: ${parsed.error}`)); return; }
    setBusy(true); setInvokeResult(null);
    api.post(`/integrations/${keyName}/invoke`, { operation: invokeOp, payload: parsed.value }).then((r) => { setInvokeResult(r.data); load(); }).catch(err).finally(() => setBusy(false));
  };
  const rotate = () => { setBusy(true); api.post<{ secret: string; url: string; headers: Record<string, string>; signing: string }>(`/integrations/${keyName}/inbound/rotate`, {}).then((r) => { setIssued(r.data); load(); onChanged(); }).catch(err).finally(() => setBusy(false)); };
  const replay = (id: string) => { setBusy(true); api.post(`/integrations/dead-letters/${id}/replay`, {}).then(() => { dispatch(notify('Replayed')); load(); onChanged(); }).catch(err).finally(() => setBusy(false)); };
  const remove = () => { setBusy(true); api.delete(`/integrations/${keyName}`).then(() => { dispatch(notify(`${d?.name ?? keyName} removed`)); setConfirmDelete(false); onChanged(); onClose(); }).catch(err).finally(() => setBusy(false)); };
  const copy = (text: string) => { navigator.clipboard?.writeText(text).then(() => dispatch(notify('Copied'))).catch(() => undefined); };
  const setOp = (i: number, patch: Partial<Operation>) => setOps((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const ro = !canManage;

  return (
    <Drawer anchor="right" open onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 780 } } }} data-testid="adapter-drawer">
      {!d ? <Box sx={{ p: 3 }}><Typography>Loading…</Typography></Box> : (
        <Box sx={{ p: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5, height: '100%' }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6" sx={{ fontSize: 17 }}>{d.name}</Typography>
            <Chip size="small" label={d.mode === 'live' ? 'Live' : 'Stub'} color={modeColor(d.mode)} data-testid="adapter-mode" />
            <Chip size="small" variant="outlined" label={d.kind === 'custom' ? 'Added by an administrator' : `Declared · ${d.reference ?? ''}`} />
            {!d.enabled && <Chip size="small" color="warning" label="Disabled" />}
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={onClose}>Close</Button>
          </Stack>
          <Typography variant="body2" color="text.secondary">{d.counterpart}{d.updatedBy ? ` · configured by ${d.updatedBy} ${fromNow(d.updatedAt ?? '')}` : ''}</Typography>
          <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label="Adapter sections" sx={{ borderBottom: 1, borderColor: 'divider' }}>
            <Tab label="Configuration" /><Tab label={`Operations (${d.operations.length})`} /><Tab label="Inbound" /><Tab label={`Activity${dead.length ? ` · ${dead.length} dead` : ''}`} />
          </Tabs>
          <Box sx={{ flex: 1, overflowY: 'auto', pr: 0.5 }}>
            {tab === 0 && (
              <Grid container spacing={1.5} sx={{ pt: 1 }}>
                {d.kind === 'custom' && <>
                  <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Name" value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} disabled={ro} /></Grid>
                  <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Name (Arabic)" value={form.nameAr ?? ''} onChange={(e) => set('nameAr', e.target.value)} disabled={ro} /></Grid>
                  <Grid item xs={12}><TextField fullWidth size="small" label="Counterpart" value={form.counterpart ?? ''} onChange={(e) => set('counterpart', e.target.value)} disabled={ro} /></Grid>
                </>}
                <Grid item xs={12}><TextField fullWidth size="small" label="Description" value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} disabled={ro} /></Grid>
                <Grid item xs={12} sm={4}>
                  <TextField select fullWidth size="small" label="Mode" value={form.mode ?? 'stub'} onChange={(e) => set('mode', e.target.value)} disabled={ro} inputProps={{ 'data-testid': 'adapter-mode-select' }} helperText={form.mode === 'live' ? 'Speaks to the real counterpart' : 'Answers from the recorded contract'}>
                    <MenuItem value="stub">Stub</MenuItem><MenuItem value="live">Live</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={8}><TextField fullWidth size="small" label="Counterpart address (base URL)" value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} disabled={ro} placeholder={d.defaultBaseUrl ?? 'https://…'} helperText="A named public host over https; the platform's own addresses and private ranges are refused" inputProps={{ 'data-testid': 'adapter-base-url' }} /></Grid>
                <Grid item xs={12} sm={4}><FormControlLabel control={<Switch checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} disabled={ro} />} label="Enabled" /></Grid>
                <Grid item xs={6} sm={4}><TextField fullWidth size="small" type="number" label="Timeout (ms)" value={form.timeoutMs ?? 8000} onChange={(e) => set('timeoutMs', e.target.value)} disabled={ro} inputProps={{ min: 1000, max: 60000, step: 500 }} /></Grid>
                <Grid item xs={6} sm={4}><TextField fullWidth size="small" type="number" label="Attempts" value={form.maxAttempts ?? 3} onChange={(e) => set('maxAttempts', e.target.value)} disabled={ro} inputProps={{ min: 1, max: 10 }} /></Grid>
                <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Health path" value={form.healthPath ?? ''} onChange={(e) => set('healthPath', e.target.value)} disabled={ro} placeholder="/health" helperText="What 'Test connection' asks of a live counterpart" /></Grid>
                <Grid item xs={12} sm={6}><TextField fullWidth size="small" type="number" label="Poll every (minutes)" value={form.pollMinutes ?? ''} onChange={(e) => set('pollMinutes', e.target.value)} disabled={ro} inputProps={{ min: 1, max: 1440 }} helperText="For a feed the scheduler reads; blank when the counterpart is only called on demand" /></Grid>
                <Grid item xs={12}><Divider><Typography variant="caption">Authentication</Typography></Divider></Grid>
                <Grid item xs={12} sm={5}>
                  <TextField select fullWidth size="small" label="Type" value={form.authType ?? 'none'} onChange={(e) => { set('authType', e.target.value); setEntered({}); }} disabled={ro} inputProps={{ 'data-testid': 'adapter-auth-type' }}>
                    {AUTH_TYPES.map((a) => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}
                  </TextField>
                </Grid>
                {form.authType === 'apiKey' && <Grid item xs={12} sm={7}><TextField fullWidth size="small" label="Header name" value={form.authHeader ?? ''} onChange={(e) => set('authHeader', e.target.value)} disabled={ro} placeholder="x-api-key" /></Grid>}
                {SECRET_FIELDS[(form.authType ?? 'none') as AuthType].map((f) => (
                  <Grid item xs={12} sm={6} key={f.key}>
                    <TextField fullWidth size="small" type="password" label={f.label} value={entered[f.key] ?? ''} onChange={(e) => setEntered((s) => ({ ...s, [f.key]: e.target.value }))} disabled={ro} autoComplete="new-password"
                      placeholder={d.secrets[f.key] ? 'Set — leave blank to keep' : 'Not set'} inputProps={{ 'data-testid': `adapter-secret-${f.key}` }}
                      helperText={d.secrets[f.key] ? <span>Set. <Button size="small" sx={{ p: 0, minWidth: 0, textTransform: 'none' }} onClick={() => setEntered((s) => ({ ...s, [f.key]: '' }))} disabled={ro}>Remove</Button>{entered[f.key] === '' ? ' — will be removed on save' : ''}</span> : 'Written here, never shown again'} />
                  </Grid>
                ))}
                <Grid item xs={12}><Divider><Typography variant="caption">Extra headers</Typography></Divider></Grid>
                {headers.map((h, i) => (
                  <Grid item xs={12} key={i}>
                    <Stack direction="row" spacing={1}>
                      <TextField size="small" label="Header" value={h.k} onChange={(e) => setHeaders((r) => r.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} disabled={ro} sx={{ width: 220 }} />
                      <TextField size="small" label="Value" value={h.v} onChange={(e) => setHeaders((r) => r.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} disabled={ro} sx={{ flex: 1 }} />
                      {!ro && <IconButton aria-label="Remove header" onClick={() => setHeaders((r) => r.filter((_, j) => j !== i))}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton>}
                    </Stack>
                  </Grid>
                ))}
                {!ro && <Grid item xs={12}><Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setHeaders((r) => [...r, { k: '', v: '' }])}>Add header</Button></Grid>}
              </Grid>
            )}
            {tab === 1 && (
              <Box sx={{ pt: 1 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{d.kind === 'custom' ? 'The operations this counterpart offers. A recorded answer is what stub mode returns; without one, a stub call is dead-lettered.' : 'Declared in code with the recorded contract beside it; the fixtures are what certification checks.'}</Typography>
                <Box sx={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Operations table">
                  <Table size="small" aria-label="Operations">
                    <TableHead><TableRow><TableCell>Key</TableCell><TableCell>Summary</TableCell><TableCell>Method</TableCell><TableCell>Path</TableCell><TableCell>Required</TableCell><TableCell>Idempotent</TableCell><TableCell>Recorded</TableCell>{d.kind === 'custom' && !ro && <TableCell />}</TableRow></TableHead>
                    <TableBody>
                      {ops.map((o, i) => d.kind === 'custom' && !ro ? (
                        <TableRow key={i}>
                          <TableCell><TextField size="small" value={o.key} onChange={(e) => setOp(i, { key: e.target.value })} sx={{ width: 130 }} inputProps={{ 'aria-label': 'Operation key' }} /></TableCell>
                          <TableCell><TextField size="small" value={o.summary} onChange={(e) => setOp(i, { summary: e.target.value })} sx={{ width: 180 }} inputProps={{ 'aria-label': 'Summary' }} /></TableCell>
                          <TableCell><TextField select size="small" value={o.method} onChange={(e) => setOp(i, { method: e.target.value as Operation['method'] })} inputProps={{ 'aria-label': 'Method' }}>{ADAPTER_OPS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}</TextField></TableCell>
                          <TableCell><TextField size="small" value={o.path} onChange={(e) => setOp(i, { path: e.target.value })} sx={{ width: 200, '& input': { fontFamily: MONO } }} inputProps={{ 'aria-label': 'Path' }} /></TableCell>
                          <TableCell><TextField size="small" value={o.required.join(', ')} onChange={(e) => setOp(i, { required: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} sx={{ width: 150 }} inputProps={{ 'aria-label': 'Required fields' }} /></TableCell>
                          <TableCell><Switch size="small" checked={o.idempotent} onChange={(e) => setOp(i, { idempotent: e.target.checked })} inputProps={{ 'aria-label': 'Idempotent' }} /></TableCell>
                          <TableCell><SampleEditor value={o.sample} onChange={(sample) => setOp(i, { sample })} /></TableCell>
                          <TableCell><IconButton aria-label="Remove operation" onClick={() => setOps((x) => x.filter((_, j) => j !== i))}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton></TableCell>
                        </TableRow>
                      ) : (
                        <TableRow key={o.key}>
                          <TableCell sx={{ fontFamily: MONO }}>{o.key}</TableCell><TableCell>{o.summary}</TableCell><TableCell>{o.method}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{o.path}</TableCell>
                          <TableCell>{o.required.join(', ') || '—'}</TableCell><TableCell>{o.idempotent ? 'Yes' : 'No'}</TableCell><TableCell>{o.recorded === undefined ? 'Fixture' : o.recorded ? 'Yes' : 'No'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Box>
                {d.kind === 'custom' && !ro && <Button size="small" startIcon={<AddRoundedIcon />} sx={{ mt: 1 }} onClick={() => setOps((x) => [...x, { key: `op${x.length + 1}`, summary: '', method: 'GET', path: '/', required: [], idempotent: false }])}>Add operation</Button>}
              </Box>
            )}
            {tab === 2 && (
              <Stack spacing={1.5} sx={{ pt: 1 }}>
                <Typography variant="body2" color="text.secondary">What the counterpart pushes to the platform arrives here, signed with a key only it holds. Each delivery carries a timestamp, a delivery id and an HMAC-SHA256 signature over the timestamp and the exact body; a stale, unsigned or repeated delivery is refused or acknowledged once.</Typography>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" label={d.inbound.enabled ? 'Inbound enabled' : 'Inbound off'} color={d.inbound.enabled ? 'success' : 'default'} />
                  <Chip size="small" variant="outlined" label={d.inbound.secretSet ? 'Signing key set' : 'No signing key'} />
                  {canManage && <Button size="small" variant="outlined" onClick={rotate} disabled={busy} data-testid="inbound-rotate">{d.inbound.secretSet ? 'Issue a new signing key' : 'Enable and issue a signing key'}</Button>}
                  {canManage && d.inbound.enabled && <Button size="small" color="warning" onClick={() => { setBusy(true); api.put(`/integrations/${keyName}`, { inboundEnabled: false }).then(() => { load(); onChanged(); }).catch(err).finally(() => setBusy(false)); }} disabled={busy}>Switch inbound off</Button>}
                </Stack>
                <TextField size="small" label="Delivery address" value={d.inboundUrl} InputProps={{ readOnly: true, endAdornment: <IconButton aria-label="Copy address" onClick={() => copy(d.inboundUrl)}><ContentCopyRoundedIcon fontSize="small" /></IconButton> }} sx={{ '& input': { fontFamily: MONO, fontSize: 12 } }} />
                {issued && (
                  <Alert severity="success" data-testid="inbound-secret" action={<IconButton aria-label="Copy signing key" onClick={() => copy(issued.secret)}><ContentCopyRoundedIcon fontSize="small" /></IconButton>}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>Signing key — shown once. Hand it to the counterpart now.</Typography>
                    <Typography sx={{ fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' }}>{issued.secret}</Typography>
                    <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>Headers: {Object.values(issued.headers).join(', ')} · {issued.signing}</Typography>
                  </Alert>
                )}
                <Typography variant="subtitle2">Recent deliveries</Typography>
                {d.recentInbound.length === 0 ? <Typography variant="body2" color="text.secondary">Nothing has been delivered yet.</Typography> : (
                  <Box sx={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Recent deliveries table">
                    <Table size="small" aria-label="Recent deliveries"><TableHead><TableRow><TableCell>Received</TableCell><TableCell>Delivery</TableCell><TableCell>Event</TableCell><TableCell>Payload</TableCell></TableRow></TableHead>
                      <TableBody>{d.recentInbound.map((r) => <TableRow key={r.id}><TableCell>{fmtDT(r.receivedAt)}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{r.deliveryId}</TableCell><TableCell>{r.eventType || '—'}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 11, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(r.payload)}</TableCell></TableRow>)}</TableBody>
                    </Table>
                  </Box>
                )}
              </Stack>
            )}
            {tab === 3 && (
              <Stack spacing={1.5} sx={{ pt: 1 }}>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {canManage && <Button size="small" variant="outlined" onClick={runTest} disabled={busy} data-testid="adapter-test">Test connection</Button>}
                  {canManage && <Button size="small" variant="outlined" onClick={certify} disabled={busy} data-testid="adapter-certify">Certify against the contract</Button>}
                </Stack>
                {test && <Alert severity={test.ok ? 'success' : 'error'} data-testid="adapter-test-result">{test.mode === 'live' ? 'Live' : 'Stub'} · {test.detail} · {test.durationMs} ms</Alert>}
                {canManage && (
                  <Card variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Run an operation from the console</Typography>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="flex-start">
                      <TextField select size="small" label="Operation" value={invokeOp} onChange={(e) => setInvokeOp(e.target.value)} sx={{ minWidth: 200 }} inputProps={{ 'data-testid': 'adapter-invoke-op' }}>{d.operations.map((o) => <MenuItem key={o.key} value={o.key}>{o.key} — {o.method} {o.path}</MenuItem>)}</TextField>
                      <TextField size="small" label="Payload (JSON)" value={invokePayload} onChange={(e) => setInvokePayload(e.target.value)} multiline minRows={2} sx={{ flex: 1, '& textarea': { fontFamily: MONO, fontSize: 12 } }} inputProps={{ 'data-testid': 'adapter-invoke-payload' }} />
                      <Button variant="contained" size="small" onClick={invoke} disabled={busy || !invokeOp} data-testid="adapter-invoke">Run</Button>
                    </Stack>
                    {invokeResult != null && <Box component="pre" data-testid="adapter-invoke-result" tabIndex={0} role="region" aria-label="Call outcome" sx={{ mt: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontFamily: MONO, fontSize: 11, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(invokeResult, null, 2)}</Box>}
                  </Card>
                )}
                {dead.length > 0 && (
                  <Box>
                    <Typography variant="subtitle2">Dead letters</Typography>
                    <Table size="small" aria-label="Dead letters"><TableHead><TableRow><TableCell>When</TableCell><TableCell>Operation</TableCell><TableCell>Error</TableCell><TableCell>Attempts</TableCell><TableCell /></TableRow></TableHead>
                      <TableBody>{dead.map((x) => <TableRow key={x.id}><TableCell>{fmtDT(x.createdAt)}</TableCell><TableCell sx={{ fontFamily: MONO }}>{x.operation}</TableCell><TableCell>{x.error}</TableCell><TableCell>{x.attempts}</TableCell><TableCell align="right">{canManage && <Button size="small" onClick={() => replay(x.id)} disabled={busy}>Replay</Button>}</TableCell></TableRow>)}</TableBody>
                    </Table>
                  </Box>
                )}
                <Typography variant="subtitle2">Recent calls</Typography>
                {d.recentCalls.length === 0 ? <Typography variant="body2" color="text.secondary">No call has been made yet.</Typography> : (
                  <Box sx={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Recent calls table">
                    <Table size="small" aria-label="Recent calls" data-testid="adapter-calls"><TableHead><TableRow><TableCell>Started</TableCell><TableCell>Operation</TableCell><TableCell>Status</TableCell><TableCell>Mode</TableCell><TableCell>HTTP</TableCell><TableCell>Attempts</TableCell><TableCell>ms</TableCell><TableCell>Correlation</TableCell></TableRow></TableHead>
                      <TableBody>{d.recentCalls.map((c) => <TableRow key={c.id}><TableCell>{fmtDT(c.startedAt)}</TableCell><TableCell sx={{ fontFamily: MONO }}>{c.operation}</TableCell><TableCell><Chip size="small" label={c.status} color={callColor(c.status)} sx={{ height: 20, fontSize: 11 }} /></TableCell><TableCell>{c.mode}</TableCell><TableCell>{c.httpStatus ?? '—'}</TableCell><TableCell>{c.attempts}</TableCell><TableCell>{c.durationMs ?? '—'}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 11 }}>{c.correlationId ?? ''}</TableCell></TableRow>)}</TableBody>
                    </Table>
                  </Box>
                )}
                {d.certifications.length > 0 && <Typography variant="caption" color="text.secondary">Certifications: {d.certifications.map((c) => `${c.passed}/${c.operations} on ${fmtDT(c.certifiedAt)}`).join(' · ')}</Typography>}
              </Stack>
            )}
          </Box>
          {canManage && (tab === 0 || tab === 1) && (
            <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ pt: 1, pr: 9 /* clear of the assistant's floating button, which sits above every drawer */, borderTop: 1, borderColor: 'divider' }}>
              {d.kind === 'custom' && <Button color="error" startIcon={<DeleteOutlineRoundedIcon />} onClick={() => setConfirmDelete(true)} disabled={busy} data-testid="adapter-delete">Remove</Button>}
              <Box sx={{ flex: 1 }} />
              <Button variant="contained" onClick={save} disabled={busy} data-testid="adapter-save">Save</Button>
            </Stack>
          )}
        </Box>
      )}
      <ConfirmDialog open={confirmLive} busy={busy} danger={false} confirmLabel="Switch live" title="Switch to the live counterpart?" message="Every call will go to the real system at the address above, with these credentials. The switch is audited and every administrator who manages settings is told." onClose={() => setConfirmLive(false)} onConfirm={save} />
      <ConfirmDialog open={confirmDelete} busy={busy} title={`Remove ${d?.name ?? keyName}?`} message="Its call history and dead letters go with it. A declared adapter cannot be removed, only disabled." onClose={() => setConfirmDelete(false)} onConfirm={remove} />
    </Drawer>
  );
}

function SampleEditor({ value, onChange }: { value?: { status: number; body: unknown }; onChange: (v: { status: number; body: unknown } | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(String(value?.status ?? 200));
  const [text, setText] = useState(value ? JSON.stringify(value.body, null, 2) : '{}');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>{value ? `Recorded (${value.status})` : 'Record an answer'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Recorded answer</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">What stub mode returns for this operation. Placeholders like {'{vcn}'} are filled from the request.</Typography>
            <TextField size="small" type="number" label="HTTP status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ width: 160 }} />
            <TextField size="small" label="Body (JSON)" value={text} onChange={(e) => setText(e.target.value)} multiline minRows={5} sx={{ '& textarea': { fontFamily: MONO, fontSize: 12 } }} error={!!problem} helperText={problem ?? ' '} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { onChange(undefined); setOpen(false); }} color="error">Clear</Button>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => { const p = parseJson(text); if (p.error) { setProblem(p.error); return; } onChange({ status: Number(status) || 200, body: p.value }); setOpen(false); }}>Keep</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/* --------------------------------------------------------------------------------- add dialog --- */
function AddIntegrationDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const dispatch = useAppDispatch();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Record<string, any>>({ key: '', name: '', nameAr: '', counterpart: '', protocol: 'rest', baseUrl: '', authType: 'none', authHeader: '', description: '' });
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [ops, setOps] = useState<Operation[]>([{ key: 'status', summary: 'Status of a record', method: 'GET', path: '/v1/records/{id}', required: ['id'], idempotent: false }]);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const setOp = (i: number, patch: Partial<Operation>) => setOps((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const create = () => {
    setBusy(true);
    const body = { key: f.key, name: f.name, nameAr: f.nameAr || null, counterpart: f.counterpart, protocol: f.protocol, baseUrl: f.baseUrl || null, description: f.description, auth: { type: f.authType, ...(f.authType === 'apiKey' && f.authHeader ? { header: f.authHeader } : {}) }, secrets: Object.fromEntries(Object.entries(entered).filter(([, v]) => v)), operations: ops };
    api.post<Adapter>('/integrations', body).then((r) => { dispatch(notify(`${r.data.name} added — it answers from its recorded samples until switched live`)); onCreated(r.data.key); }).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
  };
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth aria-labelledby="add-integration-title">
      <DialogTitle id="add-integration-title">Add an integration</DialogTitle>
      <DialogContent>
        <Grid container spacing={1.5} sx={{ pt: 1 }}>
          <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="Key" value={f.key} onChange={(e) => set('key', e.target.value.toLowerCase())} helperText="lower-case letters, digits, dashes" inputProps={{ 'data-testid': 'new-adapter-key' }} /></Grid>
          <Grid item xs={12} sm={8}><TextField fullWidth size="small" label="Name" value={f.name} onChange={(e) => set('name', e.target.value)} inputProps={{ 'data-testid': 'new-adapter-name' }} /></Grid>
          <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Name (Arabic)" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} /></Grid>
          <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Counterpart organisation" value={f.counterpart} onChange={(e) => set('counterpart', e.target.value)} inputProps={{ 'data-testid': 'new-adapter-counterpart' }} /></Grid>
          <Grid item xs={12}><TextField fullWidth size="small" label="Description" value={f.description} onChange={(e) => set('description', e.target.value)} /></Grid>
          <Grid item xs={12} sm={3}><TextField select fullWidth size="small" label="Protocol" value={f.protocol} onChange={(e) => set('protocol', e.target.value)}><MenuItem value="rest">REST (JSON)</MenuItem><MenuItem value="soap">SOAP</MenuItem></TextField></Grid>
          <Grid item xs={12} sm={9}><TextField fullWidth size="small" label="Counterpart address (base URL)" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://api.counterpart.example" helperText="Optional until the connection date; a named public host over https" inputProps={{ 'data-testid': 'new-adapter-base-url' }} /></Grid>
          <Grid item xs={12} sm={4}><TextField select fullWidth size="small" label="Authentication" value={f.authType} onChange={(e) => { set('authType', e.target.value); setEntered({}); }}>{AUTH_TYPES.map((a) => <MenuItem key={a.value} value={a.value}>{a.label}</MenuItem>)}</TextField></Grid>
          {f.authType === 'apiKey' && <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="Header name" value={f.authHeader} onChange={(e) => set('authHeader', e.target.value)} placeholder="x-api-key" /></Grid>}
          {SECRET_FIELDS[f.authType as AuthType].map((s) => <Grid item xs={12} sm={4} key={s.key}><TextField fullWidth size="small" type="password" label={s.label} value={entered[s.key] ?? ''} onChange={(e) => setEntered((x) => ({ ...x, [s.key]: e.target.value }))} autoComplete="new-password" /></Grid>)}
          <Grid item xs={12}><Divider><Typography variant="caption">Operations</Typography></Divider></Grid>
          {ops.map((o, i) => (
            <Grid item xs={12} key={i}>
              <Grid container spacing={1} alignItems="center" sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
                <Grid item xs={6} sm={3}><TextField fullWidth size="small" label="Key" value={o.key} onChange={(e) => setOp(i, { key: e.target.value })} inputProps={{ 'data-testid': `new-op-key-${i}` }} /></Grid>
                <Grid item xs={6} sm={2}><TextField select fullWidth size="small" label="Method" value={o.method} onChange={(e) => setOp(i, { method: e.target.value as Operation['method'] })}>{ADAPTER_OPS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}</TextField></Grid>
                <Grid item xs={12} sm={7}><TextField fullWidth size="small" label="Path" value={o.path} onChange={(e) => setOp(i, { path: e.target.value })} sx={{ '& input': { fontFamily: MONO } }} inputProps={{ 'data-testid': `new-op-path-${i}` }} /></Grid>
                <Grid item xs={12} sm={5}><TextField fullWidth size="small" label="Summary" value={o.summary} onChange={(e) => setOp(i, { summary: e.target.value })} /></Grid>
                <Grid item xs={12} sm={3}><TextField fullWidth size="small" label="Required fields" value={o.required.join(', ')} onChange={(e) => setOp(i, { required: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="a, b" inputProps={{ 'data-testid': `new-op-required-${i}` }} /></Grid>
                <Grid item xs={6} sm={2}><FormControlLabel control={<Switch size="small" checked={o.idempotent} onChange={(e) => setOp(i, { idempotent: e.target.checked })} />} label="Idempotent" /></Grid>
                <Grid item xs={6} sm={2}><Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center"><SampleEditor value={o.sample} onChange={(sample) => setOp(i, { sample })} /><IconButton aria-label="Remove operation" onClick={() => setOps((x) => x.filter((_, j) => j !== i))} disabled={ops.length === 1}><DeleteOutlineRoundedIcon fontSize="small" /></IconButton></Stack></Grid>
              </Grid>
            </Grid>
          ))}
          <Grid item xs={12}><Button size="small" startIcon={<AddRoundedIcon />} onClick={() => setOps((x) => [...x, { key: `op${x.length + 1}`, summary: '', method: 'GET', path: '/', required: [], idempotent: false }])}>Add operation</Button></Grid>
        </Grid>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Tooltip title={!f.key || !f.name || !f.counterpart ? 'Key, name and counterpart are needed' : ''}><span><Button variant="contained" onClick={create} disabled={busy || !f.key || !f.name || !f.counterpart} data-testid="add-integration-save">Add</Button></span></Tooltip>
      </DialogActions>
    </Dialog>
  );
}
