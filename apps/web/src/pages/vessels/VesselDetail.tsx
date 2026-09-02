import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, type NavigateFunction } from 'react-router-dom';
import { Card, Grid, Box, Typography, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, Button, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, Skeleton, Stack, Chip, Divider, TableContainer, LinearProgress } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import NearMeRoundedIcon from '@mui/icons-material/NearMeRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import FormFields from '../../components/common/FormFields';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import EntityHover from '../../components/common/EntityHover';
import { CERT_STATUS_META, PORTCALL_STATUS_META, INSPECTION_STATUS_META, RESULT_META, INCIDENT_STATUS_META, SEVERITY_META } from '../../utils/status';
import { fmtD, fmtDT, fmtNum, toInputD, fromNow } from '../../utils/format';
import { MONO } from '../../theme';
import { REG_STATUS_META, REGISTRY_STATE_META } from '../registry/shared';
import type { Registration, Transcript } from '../registry/types';
import { factorTone } from '../risk/shared';
import type { RiskScoreRow } from '../risk/types';
import { BAND_COLOR, CERT_TYPES } from './shared';
import type { MovementsData, VesselCertificate, VesselDetailData, VoyagesData } from './types';

const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box>
    <Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography>
    <Typography component="div" sx={{ fontSize: 13.5, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography>
  </Box>
);
const mono = { fontFamily: MONO, fontSize: 12.5 } as const;
const empty = (cols: number, text: string) => <TableRow><TableCell colSpan={cols}><Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{text}</Typography></TableCell></TableRow>;

/* Where this ship stands on the national register, assembled from the granted applications rather than from anything stored on the ship. */
function RegistryPanel({ t, rows, navigate }: { t: Transcript; rows: Registration[]; navigate: NavigateFunction }) {
  const st = t.registry;
  return (
    <>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <StatusChip value={st.state} map={REGISTRY_STATE_META} />
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>{t.registrar}{t.portOfRegistry ? ` · ${t.portOfRegistry.name}` : ''}</Typography>
      </Stack>
      <Grid container spacing={2.5} sx={{ mb: 2 }}>
        <Grid item xs={6} sm={3}><Typography variant="caption" color="text.secondary">Official number</Typography><Typography sx={{ fontWeight: 700, fontFamily: MONO }}>{st.officialNumber || '—'}</Typography></Grid>
        <Grid item xs={6} sm={3}><Typography variant="caption" color="text.secondary">Certificate of registry</Typography><Typography sx={{ fontWeight: 700, fontFamily: MONO }}>{st.certificateNo || '—'}</Typography></Grid>
        <Grid item xs={6} sm={3}><Typography variant="caption" color="text.secondary">First registered</Typography><Typography sx={{ fontWeight: 700 }}>{fmtD(t.firstRegistered)}</Typography></Grid>
        <Grid item xs={6} sm={3}>
          <Typography variant="caption" color="text.secondary">{st.state === 'PROVISIONAL' ? 'Provisional certificate expires' : st.state === 'CLOSED' ? 'Registry closed' : 'Tonnage'}</Typography>
          <Typography sx={{ fontWeight: 700 }}>{st.state === 'PROVISIONAL' ? fmtD(st.certificateExpiresOn) : st.state === 'CLOSED' ? fmtD(st.closedOn) : t.tonnage ? `${fmtNum(t.tonnage.gross)} GT / ${fmtNum(t.tonnage.net)} NT` : '—'}</Typography>
        </Grid>
      </Grid>
      {t.closure && <Chip size="small" color="error" sx={{ mb: 2 }} label={`Closed — ${String(t.closure.reason || '').replace(/_/g, ' ').toLowerCase()}${t.closure.newFlag ? ` to ${t.closure.newFlag}` : ''} · ${t.closure.certificateNo}`} />}
      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Registered ownership{t.shareLedger ? ` — ${t.shareLedger.held} of ${t.shareLedger.denominator} shares` : ''}</Typography>
      <TableContainer sx={{ mb: 2 }}>
        <Table size="small">
          <TableHead><TableRow><TableCell>Owner</TableCell><TableCell>Kind</TableCell><TableCell>Registration</TableCell><TableCell align="right">Shares</TableCell></TableRow></TableHead>
          <TableBody>
            {(t.owners || []).map((o, i) => (
              <TableRow key={i}><TableCell sx={{ fontWeight: 600 }}>{o.name}</TableCell><TableCell>{String(o.kind || '').replace(/_/g, ' ').toLowerCase()}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{o.cin || o.pan || '—'}</TableCell><TableCell align="right">{o.shares}</TableCell></TableRow>
            ))}
            {!(t.owners || []).length && <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No ownership recorded.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
      {(t.encumbrances || []).length > 0 && (
        <>
          <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Subsisting charges</Typography>
          <TableContainer sx={{ mb: 2 }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Charge</TableCell><TableCell>In favour of</TableCell><TableCell>Registered</TableCell><TableCell>Reference</TableCell></TableRow></TableHead>
              <TableBody>{t.encumbrances.map((e, i) => <TableRow key={i}><TableCell>{String(e.kind || '').toLowerCase()}</TableCell><TableCell sx={{ fontWeight: 600 }}>{e.holder}</TableCell><TableCell>{fmtD(e.registeredOn)}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{e.reference || '—'}</TableCell></TableRow>)}</TableBody>
            </Table>
          </TableContainer>
        </>
      )}
      <Typography sx={{ fontSize: 12.5, fontWeight: 700, mb: 0.5 }}>Registry transactions</Typography>
      <TableContainer>
        <Table size="small">
          <TableHead><TableRow><TableCell>Application</TableCell><TableCell>Transaction</TableCell><TableCell>Status</TableCell><TableCell>Certificate</TableCell><TableCell>Granted</TableCell></TableRow></TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/registry/${r.id}`)}>
                <TableCell sx={{ ...mono, fontWeight: 600 }}>{r.applicationNo}</TableCell><TableCell>{String(r.kind || '').toLowerCase()}</TableCell>
                <TableCell><StatusChip value={r.status} map={REG_STATUS_META} /></TableCell><TableCell sx={mono}>{r.certificateNo || '—'}</TableCell><TableCell>{fmtD(r.grantedOn)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

export default function VesselDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const user = useUser();
  const [v, setV] = useState<VesselDetailData | null>(null);
  const [tab, setTab] = useState(0);
  const [voyages, setVoyages] = useState<VoyagesData | null>(null);
  const [movements, setMovements] = useState<MovementsData | null>(null);
  const [riskRow, setRiskRow] = useState<RiskScoreRow | null | undefined>(undefined);   // undefined = not loaded, null = none
  const [registry, setRegistry] = useState<{ transcript: Transcript | null; rows: Registration[] } | undefined>(undefined);
  const [certDlg, setCertDlg] = useState<VesselCertificate | Record<string, never> | null>(null);
  const [certVals, setCertVals] = useState<Record<string, any>>({});
  const [delCert, setDelCert] = useState<VesselCertificate | null>(null);
  const [busy, setBusy] = useState(false);

  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<VesselDetailData>(`/vessels/${id}`).then((r) => setV(r.data)).catch(err), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setVoyages(null); setMovements(null); setRiskRow(undefined); setRegistry(undefined); setTab(0); }, [id]);

  // lazy tab data
  useEffect(() => {
    if (tab === 2 && !voyages) api.get<VoyagesData>(`/vessels/${id}/voyages`).then((r) => setVoyages(r.data)).catch(err);
    if (tab === 3 && !movements) api.get<MovementsData>(`/vessels/${id}/movements`).then((r) => setMovements(r.data)).catch(err);
    if (tab === 7 && riskRow === undefined) {
      if (!hasPerm(user, 'risk.view')) setRiskRow(null);
      else api.get<RiskScoreRow[]>('/risk/scores').then((r) => setRiskRow(r.data.find((x) => String(x.vesselId) === String(id)) || null)).catch(() => setRiskRow(null));
    }
    if (tab === 8 && registry === undefined) {
      Promise.all([
        api.get<Transcript>(`/vessels/${id}/transcript`).then((r) => r.data).catch(() => null),
        api.get<Registration[]>(`/vessels/${id}/registrations`).then((r) => r.data).catch(() => [] as Registration[]),
      ]).then(([transcript, rows]) => setRegistry({ transcript, rows }));
    }
  }, [tab, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!v) return <Skeleton variant="rounded" height={480} />;
  const canCerts = hasPerm(user, 'certificates.manage');
  const editingCertId = certDlg && 'id' in certDlg ? (certDlg as VesselCertificate).id : undefined;
  const regState = registry?.transcript?.registry?.state || 'UNREGISTERED';

  const saveCert = () => {
    setBusy(true);
    const req = editingCertId ? api.put(`/vessels/${id}/certificates/${editingCertId}`, certVals) : api.post(`/vessels/${id}/certificates`, certVals);
    req.then(() => { dispatch(notify('Certificate saved')); setCertDlg(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  const titleNode = (
    <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
      <span>{v.name}</span>
      <Chip size="small" label={v.status} color={v.status === 'ACTIVE' ? 'success' : 'default'} sx={{ height: 20 }} />
      {v.liner && <Chip size="small" variant="outlined" label="Mainline service" sx={{ height: 20, fontWeight: 700 }} />}
    </Stack>
  );

  return (
    <>
      {/* The header title is a node (name + status chips); PageHeader renders any node but types the prop as string. */}
      <PageHeader crumbs={[{ label: 'Vessel Register', to: '/vessels' }, { label: v.name }]} title={titleNode as unknown as string}
        sub={`IMO ${v.imo} · ${v.type} · ${v.flag} flag · Class ${v.classSociety || '—'} · ${v.portOfRegistry && v.portOfRegistry !== '—' ? `Registry ${v.portOfRegistry}` : 'Foreign registry'}`} />
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2.4}><Item label="GRT / DWT" value={`${fmtNum(v.grt)} / ${fmtNum(v.dwt)}`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="LOA × Beam × Draft" value={`${v.loa || '—'} × ${v.beam || '—'} × ${v.maxDraft || '—'} m`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Built" value={`${v.built || '—'}${v.yard ? ` · ${v.yard}` : ''}`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="MMSI / Call sign" value={`${v.mmsi || '—'} · ${v.callSign || '—'}`} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Service speed" value={v.serviceSpeedKn ? `${v.serviceSpeedKn} kn${v.teuCapacity ? ` · ${fmtNum(v.teuCapacity)} TEU` : ''}` : '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Registered owner" value={v.owner} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Operator" value={v.operator || '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Technical manager" value={v.manager || '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="P&I club" value={v.piClub || '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Local agent" value={v.agent ? <EntityHover type="agent" id={v.agent}><span>{v.agent}</span></EntityHover> : '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Main engine" value={v.engine?.maker ? `${v.engine.maker} ${v.engine.model || ''} · ${fmtNum(v.engine.powerKW)} kW` : '—'} /></Grid>
          <Grid item xs={6} md={2.4}><Item label="Dry dock" value={v.lastDryDock ? `Last ${fmtD(v.lastDryDock)} · next ${fmtD(v.nextDryDock)}` : '—'} /></Grid>
          {v.lastPosition && (
            <Grid item xs={12} md={4.8}>
              <Item label="Last known position" value={<Stack direction="row" spacing={0.75} alignItems="center">
                <NearMeRoundedIcon aria-hidden sx={{ fontSize: 15, color: 'primary.main', transform: `rotate(${(v.lastPosition.course || 0) - 45}deg)` }} />
                <span>{v.lastPosition.lat.toFixed(4)}°N {v.lastPosition.lon.toFixed(4)}°E · {v.lastPosition.navStatus.replace(/_/g, ' ').toLowerCase()} · {v.lastPosition.speed} kn · {fromNow(v.lastPosition.receivedAt)}</span>
              </Stack>} />
            </Grid>
          )}
        </Grid>
      </Card>

      <Card>
        <Tabs value={tab} onChange={(_, t: number) => setTab(t)} variant="scrollable" allowScrollButtonsMobile aria-label="Vessel record sections" sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label={`Certificates (${v.certificates.length})`} />
          <Tab label={`Port calls (${v.recentCalls.length})`} />
          <Tab label="Voyages & routes" />
          <Tab label="Movements" />
          <Tab label={`Inspections (${v.recentInspections.length})`} />
          <Tab label={`Crew on board (${(v.crewOnBoard || []).length})`} />
          <Tab label={`Incidents (${(v.recentIncidents || []).length})`} />
          <Tab label="Risk profile" />
          <Tab label="Registry" />
        </Tabs>

        {tab === 0 && (
          <Box sx={{ p: 2 }}>
            {canCerts && <Button size="small" startIcon={<AddRoundedIcon />} sx={{ mb: 1 }} onClick={() => { setCertVals({}); setCertDlg({}); }}>Add certificate</Button>}
            <TableContainer sx={{ overflowX: 'auto' }}>
              <Table size="small">
                <TableHead><TableRow><TableCell>Certificate</TableCell><TableCell>Number</TableCell><TableCell>Issuer</TableCell><TableCell>Issued</TableCell><TableCell>Expires</TableCell><TableCell>Status</TableCell><TableCell align="right">{canCerts ? 'Actions' : ''}</TableCell></TableRow></TableHead>
                <TableBody>
                  {v.certificates.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell><b>{c.certType}</b></TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{c.number || '—'}</TableCell>
                      <TableCell>{c.issuer || '—'}</TableCell>
                      <TableCell>{fmtD(c.issueDate)}</TableCell><TableCell>{fmtD(c.expiryDate)}</TableCell>
                      <TableCell><StatusChip value={c.status} map={CERT_STATUS_META} /></TableCell>
                      <TableCell align="right">
                        {canCerts && (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton size="small" aria-label={`Edit ${c.certType}`} onClick={() => { setCertVals({ certType: c.certType, number: c.number, issuer: c.issuer, issueDate: toInputD(c.issueDate), expiryDate: toInputD(c.expiryDate), remarks: c.remarks }); setCertDlg(c); }}><EditRoundedIcon fontSize="inherit" /></IconButton>
                            <IconButton size="small" color="error" aria-label={`Delete ${c.certType}`} onClick={() => setDelCert(c)}><DeleteOutlineRoundedIcon fontSize="inherit" /></IconButton>
                          </Stack>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {v.certificates.length === 0 && empty(7, 'No certificates recorded for this vessel.')}
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        {tab === 1 && (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>VCN</TableCell><TableCell>Status</TableCell><TableCell>ETA</TableCell><TableCell>Berth</TableCell><TableCell>Terminal</TableCell><TableCell>Sailed</TableCell></TableRow></TableHead>
              <TableBody>
                {v.recentCalls.map((c) => (
                  <TableRow key={c.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/port-calls/${c.id}`)}>
                    <TableCell sx={mono}>{c.vcn}</TableCell>
                    <TableCell><StatusChip value={c.status} map={PORTCALL_STATUS_META} /></TableCell>
                    <TableCell>{fmtDT(c.eta)}</TableCell>
                    <TableCell sx={mono}>{c.berthCode || '—'}</TableCell>
                    <TableCell>{c.terminal || '—'}</TableCell>
                    <TableCell>{fmtDT(c.atd)}</TableCell>
                  </TableRow>
                ))}
                {v.recentCalls.length === 0 && empty(6, 'No port calls recorded for this vessel.')}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {tab === 2 && (
          <Box sx={{ p: 2 }}>
            {!voyages ? <LinearProgress aria-label="Loading voyages" /> : (
              <>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>FREQUENT TRADE LANES (with this port)</Typography>
                <Stack direction="row" spacing={0.75} sx={{ my: 1.25, flexWrap: 'wrap' }} useFlexGap>
                  {voyages.lanes.map((l) => <Chip key={l.port} size="small" variant="outlined" label={`${l.port} · ${l.calls}`} sx={{ fontWeight: 600 }} />)}
                  {voyages.lanes.length === 0 && <Typography variant="body2" color="text.secondary">No sailed history yet.</Typography>}
                </Stack>
                <Divider sx={{ mb: 1.5 }} />
                <TableContainer sx={{ overflowX: 'auto' }}>
                  <Table size="small">
                    <TableHead><TableRow><TableCell>VCN</TableCell><TableCell>From</TableCell><TableCell>Here</TableCell><TableCell>To</TableCell><TableCell>Berth</TableCell><TableCell>Cargo worked</TableCell><TableCell align="right">Port days</TableCell></TableRow></TableHead>
                    <TableBody>
                      {voyages.voyages.map((vy) => (
                        <TableRow key={vy.callId} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/port-calls/${vy.callId}`)}>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{vy.vcn}</TableCell>
                          <TableCell>{vy.fromPort}</TableCell>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtD(vy.arrived)} → {fmtD(vy.sailed)}</TableCell>
                          <TableCell>{vy.toPort}</TableCell>
                          <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{vy.berth}</TableCell>
                          <TableCell><Typography noWrap sx={{ fontSize: 12.5, maxWidth: 260 }}>{vy.cargo || '—'}</Typography></TableCell>
                          <TableCell align="right">{vy.portDays ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                      {voyages.voyages.length === 0 && empty(7, 'No completed voyages through this port yet.')}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
          </Box>
        )}

        {tab === 3 && (
          <Box sx={{ p: 2 }}>
            {!movements ? <LinearProgress aria-label="Loading movements" /> : (
              <>
                {movements.position ? (
                  <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
                    <Grid container spacing={2}>
                      <Grid item xs={6} md={3}><Item label="Position" value={`${movements.position.lat.toFixed(4)}°N ${movements.position.lon.toFixed(4)}°E`} /></Grid>
                      <Grid item xs={6} md={3}><Item label="Nav status" value={movements.position.navStatus.replace(/_/g, ' ')} /></Grid>
                      <Grid item xs={6} md={3}><Item label="SOG / COG" value={`${movements.position.speed} kn · ${String(movements.position.course).padStart(3, '0')}°`} /></Grid>
                      <Grid item xs={6} md={3}><Item label="Received" value={fromNow(movements.position.receivedAt)} /></Grid>
                    </Grid>
                  </Card>
                ) : <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>No live AIS target for this vessel right now.</Typography>}
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>PORT EVENT TRAIL</Typography>
                <TableContainer sx={{ overflowX: 'auto', mt: 1 }}>
                  <Table size="small">
                    <TableHead><TableRow><TableCell>When</TableCell><TableCell>Call</TableCell><TableCell>Event</TableCell><TableCell>Note</TableCell></TableRow></TableHead>
                    <TableBody>
                      {movements.events.map((e, i) => (
                        <TableRow key={i}><TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDT(e.at)}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{e.vcn}</TableCell><TableCell><StatusChip value={e.event} map={PORTCALL_STATUS_META} /></TableCell><TableCell>{e.note || '—'}</TableCell></TableRow>
                      ))}
                      {movements.events.length === 0 && empty(4, 'No port events recorded yet.')}
                    </TableBody>
                  </Table>
                </TableContainer>
              </>
            )}
          </Box>
        )}

        {tab === 4 && (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Number</TableCell><TableCell>Type</TableCell><TableCell>Status</TableCell><TableCell>Result</TableCell><TableCell>Findings</TableCell><TableCell>Date</TableCell></TableRow></TableHead>
              <TableBody>
                {v.recentInspections.map((i) => (
                  <TableRow key={i.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/inspections/${i.id}`)}>
                    <TableCell sx={mono}>{i.number}</TableCell><TableCell>{i.type}</TableCell>
                    <TableCell><StatusChip value={i.status} map={INSPECTION_STATUS_META} /></TableCell>
                    <TableCell>{i.result ? <StatusChip value={i.result} map={RESULT_META} /> : '—'}</TableCell>
                    <TableCell>{i.findings?.length || 0}</TableCell><TableCell>{fmtD(i.plannedAt)}</TableCell>
                  </TableRow>
                ))}
                {v.recentInspections.length === 0 && empty(6, 'No inspection history at this port.')}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {tab === 5 && (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Rank</TableCell><TableCell>CDC</TableCell><TableCell>Nationality</TableCell><TableCell>Cert alerts</TableCell></TableRow></TableHead>
              <TableBody>
                {(v.crewOnBoard || []).map((s) => (
                  <TableRow key={s.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/seafarers/${s.id}`)}>
                    <TableCell><EntityHover type="seafarer" id={s.id}><b>{s.name}</b></EntityHover></TableCell>
                    <TableCell>{s.rank}</TableCell><TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{s.cdcNo}</TableCell><TableCell>{s.nationality}</TableCell>
                    <TableCell>{s.certAlerts ? <Chip size="small" color="warning" label={s.certAlerts} sx={{ height: 20 }} /> : '—'}</TableCell>
                  </TableRow>
                ))}
                {(v.crewOnBoard || []).length === 0 && empty(5, 'No crew from the register currently assigned to this vessel.')}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {tab === 6 && (
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead><TableRow><TableCell>Case</TableCell><TableCell>Type</TableCell><TableCell>Severity</TableCell><TableCell>Status</TableCell><TableCell>Reported</TableCell></TableRow></TableHead>
              <TableBody>
                {(v.recentIncidents || []).map((i) => (
                  <TableRow key={i.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/incidents/${i.id}`)}>
                    <TableCell sx={mono}>{i.number}</TableCell><TableCell>{i.type.replace(/_/g, ' ')}</TableCell>
                    <TableCell><StatusChip value={i.severity} map={SEVERITY_META} /></TableCell><TableCell><StatusChip value={i.status} map={INCIDENT_STATUS_META} /></TableCell>
                    <TableCell>{fmtDT(i.reportedAt)}</TableCell>
                  </TableRow>
                ))}
                {(v.recentIncidents || []).length === 0 && empty(5, 'No incidents on record for this vessel ✅')}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {tab === 7 && (
          <Box sx={{ p: 2.5, maxWidth: 760 }}>
            {riskRow === undefined && <LinearProgress aria-label="Loading risk profile" />}
            {riskRow === null && <Typography color="text.secondary">No risk score available (inactive vessel, or your role has no risk access).</Typography>}
            {riskRow && (
              <>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
                  <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 40 }}>{riskRow.score}</Typography>
                  <Chip label={`${riskRow.band} RISK`} color={BAND_COLOR[riskRow.band] || 'default'} sx={{ fontWeight: 800 }} />
                  <Button size="small" variant="outlined" onClick={() => navigate('/risk')}>Full risk register</Button>
                </Stack>
                {(riskRow.factors || []).map((f) => (
                  <Box key={f.key || f.label} sx={{ mb: 1.5 }}>
                    <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.4 }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 700 }}>{f.label}</Typography>
                      <Typography sx={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{f.points} / {f.max}</Typography>
                    </Stack>
                    <LinearProgress variant="determinate" aria-label={`${f.label} ${f.points} of ${f.max}`} value={f.max ? Math.min(100, (f.points / f.max) * 100) : 0} sx={{ height: 7, borderRadius: 4 }} color={factorTone(f.points, f.max)} />
                    <Typography variant="caption" color="text.secondary">{f.evidence}</Typography>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )}

        {tab === 8 && (
          <Box sx={{ p: 2.5 }}>
            {registry === undefined && <LinearProgress aria-label="Loading registry entry" />}
            {registry && regState === 'UNREGISTERED' && (
              <Typography color="text.secondary" sx={{ fontSize: 13.5, maxWidth: 640 }}>
                {v.name} has never been entered on this administration&apos;s register. A foreign-flagged ship calling here is on its own flag&apos;s register — its certificate of registry, and the statutory certificates that hang off it, are issued by that administration and not by this one.
              </Typography>
            )}
            {registry && registry.transcript && regState !== 'UNREGISTERED' && <RegistryPanel t={registry.transcript} rows={registry.rows} navigate={navigate} />}
          </Box>
        )}
      </Card>

      <Dialog open={!!certDlg} onClose={() => !busy && setCertDlg(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{editingCertId ? 'Edit certificate' : 'Add certificate'}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <FormFields fields={[
            { name: 'certType', label: 'Certificate type', type: 'autocomplete', required: true, cols: 12, options: CERT_TYPES.map((c) => ({ value: c, label: c })) },
            { name: 'number', label: 'Number' }, { name: 'issuer', label: 'Issuer' },
            { name: 'issueDate', label: 'Issue date', type: 'date' }, { name: 'expiryDate', label: 'Expiry date', type: 'date', required: true },
            { name: 'remarks', label: 'Remarks', cols: 12 },
          ]} values={certVals} onChange={setCertVals} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setCertDlg(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={saveCert} disabled={busy || !certVals.certType || !certVals.expiryDate}>Save</Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog open={!!delCert} busy={busy} title="Delete certificate?" message={`Remove ${delCert?.certType} from ${v.name}? The deletion is recorded in the audit log.`} onClose={() => setDelCert(null)}
        onConfirm={() => { if (!delCert) return; setBusy(true); api.delete(`/vessels/${id}/certificates/${delCert.id}`).then(() => { dispatch(notify('Certificate deleted')); setDelCert(null); load(); }).catch(err).finally(() => setBusy(false)); }} />
    </>
  );
}
