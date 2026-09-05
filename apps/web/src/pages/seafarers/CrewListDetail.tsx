import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, Skeleton, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import StatusChip from '../../components/common/StatusChip';
import EntityHover from '../../components/common/EntityHover';
import { useLookups } from '../../hooks/useLookups';
import { fmtD, fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import { RANK_LOOKUP, listStatusMeta, matchMeta } from './shared';
import type { CrewList } from './metTypes';

/* One FAL-5 crew list: what it declared, who each line turned out to be, and what the checks found — the safe
 * manning scale capacity by capacity, the documents of the register's people, the identity papers, the flag's
 * endorsements of foreign officers, the citizens on no register, and the general declaration's crew count. */
const Item = ({ label, value }: { label: string; value?: React.ReactNode }) => (
  <Box><Typography sx={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary' }}>{label}</Typography><Typography component="div" sx={{ fontSize: 14, fontWeight: 600, mt: 0.25 }}>{value ?? '—'}</Typography></Box>
);
const mono = { fontFamily: MONO, fontSize: 12 } as const;
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Box sx={{ mb: 2 }}><Typography variant="subtitle2" sx={{ mb: 0.5 }}>{title}</Typography>{children}</Box>
);

export default function CrewListDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate(); const dispatch = useAppDispatch(); const user = useUser(); const { t } = useTranslation();
  const ranks = useLookups(RANK_LOOKUP); const sources = useLookups('crewListSource');
  const [doc, setDoc] = useState<CrewList | null>(null);
  const [decision, setDecision] = useState<{ kind: 'clear' | 'query'; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const err = useCallback((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })), [dispatch]);
  const load = useCallback(() => api.get<CrewList>(`/seafarers/crew-lists/${id}`).then((r) => setDoc(r.data)).catch(err), [id, err]);
  useEffect(() => { load(); }, [load]);
  if (!doc) return <Skeleton variant="rounded" height={420} />;
  const canEdit = hasPerm(user, 'seafarers.edit');
  const meta = listStatusMeta(t); const matches = matchMeta(t);
  const c = doc.checks;
  const recheck = () => { setBusy(true); api.post<CrewList>(`/seafarers/crew-lists/${doc.id}/check`, {}).then((r) => { setDoc(r.data); dispatch(notify(t('seafarers.cl.rechecked'))); }).catch(err).finally(() => setBusy(false)); };
  const decide = () => {
    if (!decision) return;
    setBusy(true);
    api.post<CrewList>(`/seafarers/crew-lists/${doc.id}/${decision.kind}`, { note: decision.note }).then((r) => { setDoc(r.data); dispatch(notify(decision.kind === 'clear' ? t('seafarers.cl.cleared') : t('seafarers.cl.queried'))); setDecision(null); }).catch(err).finally(() => setBusy(false));
  };
  const decided = doc.status === 'CLEARED' || doc.status === 'QUERIED';
  return (
    <>
      <PageHeader crumbs={[{ label: t('seafarers.cl.crumb'), to: '/seafarers/crew-lists' }, { label: doc.number }]}
        title={<Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap><span style={{ fontFamily: MONO }}>{doc.number}</span><StatusChip value={doc.status} map={meta} />{c && (c.ok ? <Chip size="small" color="success" label={t('seafarers.cl.passed')} /> : <Chip size="small" color="warning" label={t('seafarers.cl.failed', { count: c.summary.length })} />)}</Stack>}
        sub={`${doc.vesselName} · ${doc.vcn || '—'} · ${t(`seafarers.cl.movementLabel.${doc.movement}`)} · ${fmtDT(doc.date)} · ${sources.label(doc.source) || doc.sourceLabel}`}
        actions={canEdit && (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" color="inherit" startIcon={<ReplayRoundedIcon />} disabled={busy} onClick={recheck}>{t('seafarers.cl.recheck')}</Button>
            {doc.status !== 'QUERIED' && !decided && <Button variant="outlined" color="warning" startIcon={<HelpOutlineRoundedIcon />} disabled={busy} onClick={() => setDecision({ kind: 'query', note: '' })}>{t('seafarers.cl.query')}</Button>}
            {doc.status !== 'CLEARED' && <Button variant="contained" startIcon={<CheckCircleOutlineRoundedIcon />} disabled={busy} onClick={() => setDecision({ kind: 'clear', note: '' })}>{t('seafarers.cl.clear')}</Button>}
          </Stack>
        )} />
      <Card sx={{ p: 2.5, mb: 2 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.vessel')} value={<EntityHover type="vessel" id={doc.vesselId}><span>{doc.vesselName}</span></EntityHover>} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.agent')} value={doc.agentCode ? <EntityHover type="company" id={doc.agentCode}><span>{doc.agentName || doc.agentCode}</span></EntityHover> : '—'} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.lines')} value={<span style={mono}>{doc.rowCount}</span>} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.matched')} value={<span style={mono}>{doc.matched}</span>} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.foreign')} value={<span style={mono}>{doc.foreignCount}</span>} /></Grid>
          <Grid item xs={6} md={2}><Item label={t('seafarers.cl.declared')} value={doc.declaredCrew ?? '—'} /></Grid>
          {doc.checkedAt && <Grid item xs={6} md={3}><Item label={t('seafarers.cl.checkedBy')} value={`${doc.checkedBy} · ${fmtDT(doc.checkedAt)}`} /></Grid>}
          {doc.decidedAt && <Grid item xs={6} md={3}><Item label={t('seafarers.cl.decidedBy')} value={`${doc.decidedBy} · ${fmtDT(doc.decidedAt)}`} /></Grid>}
          {doc.decisionNote && <Grid item xs={12} md={6}><Item label={t('seafarers.remarks')} value={doc.decisionNote} /></Grid>}
        </Grid>
      </Card>
      <Grid container spacing={2}>
        <Grid item xs={12} lg={5}>
          <Card sx={{ p: 2, height: '100%' }}>
            <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 1 }}>{t('seafarers.cl.checks')}</Typography>
            {!c ? <Typography color="text.secondary">{t('seafarers.cl.notChecked')}</Typography> : (
              <>
                <Alert severity={c.ok ? 'success' : 'warning'} sx={{ mb: 2 }} aria-label={t('seafarers.cl.summary')}>
                  <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>{c.nationalFlag ? t('seafarers.cl.nationalFlag') : t('seafarers.cl.foreignFlag')} · {c.checkedAt ? fmtDT(c.checkedAt) : ''}</Typography>
                  <Stack component="ul" sx={{ m: 0, pl: 2 }}>{c.summary.map((s, i) => <li key={i}>{s}</li>)}</Stack>
                </Alert>
                <Section title={c.msmdNo ? `${t('seafarers.cl.manning')} — ${t('seafarers.cl.manningDoc', { no: c.msmdNo })}` : t('seafarers.cl.manning')}>
                  {!c.scaleRecorded ? <Typography color="text.secondary" variant="body2">{t('seafarers.cl.scaleMissing')}</Typography> : (
                    <TableContainer><Table size="small" aria-label={t('seafarers.cl.manning')}>
                      <TableHead><TableRow><TableCell>{t('seafarers.cl.capacity')}</TableCell><TableCell align="right">{t('seafarers.cl.required')}</TableCell><TableCell align="right">{t('seafarers.cl.listed')}</TableCell><TableCell align="right">{t('seafarers.cl.shortfall')}</TableCell></TableRow></TableHead>
                      <TableBody>{c.manning?.rows.map((r) => (
                        <TableRow key={r.rankCode} sx={{ bgcolor: r.shortfall ? 'rgba(211,47,47,0.06)' : undefined }}>
                          <TableCell>{ranks.label(r.rankCode) || r.rank}</TableCell><TableCell align="right" sx={mono}>{r.required}</TableCell><TableCell align="right" sx={mono}>{r.listed}</TableCell>
                          <TableCell align="right">{r.shortfall ? <Chip size="small" color="error" label={r.shortfall} sx={{ height: 20 }} /> : '—'}</TableCell>
                        </TableRow>
                      ))}</TableBody>
                    </Table></TableContainer>
                  )}
                </Section>
                <Section title={t('seafarers.cl.declaration')}>
                  <Typography variant="body2" color={c.declaration.matches === false ? 'error.main' : 'text.secondary'}>{c.declaration.declared == null ? t('seafarers.cl.declarationNone') : t('seafarers.cl.declarationLine', { declared: c.declaration.declared, listed: c.declaration.listed })}</Typography>
                </Section>
                {c.documents.length > 0 && <Section title={t('seafarers.cl.documents')}>{c.documents.map((d) => <Typography key={d.seq} variant="body2"><b>{d.seq}. {d.name}</b> ({ranks.label(d.rank) || d.rank}) — {d.failures.join('; ')}</Typography>)}</Section>}
                {c.endorsements.length > 0 && <Section title={t('seafarers.cl.endorsements')}>{c.endorsements.map((d) => <Typography key={d.seq} variant="body2"><b>{d.seq}. {d.name}</b> — {d.issue}</Typography>)}</Section>}
                {c.identity.length > 0 && <Section title={t('seafarers.cl.identity')}>{c.identity.map((d) => <Typography key={d.seq} variant="body2"><b>{d.seq}. {d.name}</b> — {d.issue}</Typography>)}</Section>}
                {c.unregisteredNationals.length > 0 && <Section title={t('seafarers.cl.nationals')}>{c.unregisteredNationals.map((d) => <Typography key={d.seq} variant="body2"><b>{d.seq}. {d.name}</b> ({d.rank})</Typography>)}</Section>}
                {c.unknownRanks.length > 0 && <Section title={t('seafarers.cl.unknownRanks')}>{c.unknownRanks.map((d) => <Typography key={d.seq} variant="body2"><b>{d.seq}. {d.name}</b> — "{d.rank}"</Typography>)}</Section>}
              </>
            )}
          </Card>
        </Grid>
        <Grid item xs={12} lg={7}>
          <Card>
            <Box sx={{ px: 2, py: 1.25 }}><Typography variant="h6" component="h2" sx={{ fontSize: 15 }}>{t('seafarers.cl.lines')}</Typography></Box>
            <Divider />
            <TableContainer sx={{ overflowX: 'auto' }}><Table size="small" aria-label={t('seafarers.cl.lines')}>
              <TableHead><TableRow><TableCell>#</TableCell><TableCell>{t('seafarers.cl.person')}</TableCell><TableCell>{t('seafarers.cl.rank')}</TableCell><TableCell>{t('seafarers.cl.nationality')}</TableCell><TableCell>{t('seafarers.cl.idType')}</TableCell><TableCell>{t('seafarers.cl.result')}</TableCell><TableCell>{t('seafarers.cl.issues')}</TableCell></TableRow></TableHead>
              <TableBody>
                {(doc.rows ?? []).map((l) => (
                  <TableRow key={l.id} hover>
                    <TableCell sx={mono}>{l.seq}</TableCell>
                    <TableCell>
                      {l.seafarerId ? <EntityHover type="seafarer" id={l.seafarerId}><b style={{ cursor: 'pointer' }} onClick={() => navigate(`/seafarers/${l.seafarerId}`)}>{l.name}</b></EntityHover> : <b>{l.name}</b>}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{l.dob ? `${fmtD(l.dob)} · ` : ''}{l.pob || ''}{l.cdcNo ? ` · CDC ${l.cdcNo}` : ''}</Typography>
                    </TableCell>
                    <TableCell>{ranks.label(l.rankCode) || l.rank}</TableCell>
                    <TableCell>{l.nationality}</TableCell>
                    <TableCell><span style={mono}>{l.idType} {l.idNumber}</span>{l.idExpiry && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{fmtD(l.idExpiry)}</Typography>}</TableCell>
                    <TableCell><StatusChip value={l.match} map={matches} />{l.foreignId && <Button size="small" sx={{ ml: 0.5, minWidth: 0 }} onClick={() => navigate(`/seafarers/foreign?open=${l.foreignId}`)}>{t('seafarers.cl.ledgerEntry')}</Button>}</TableCell>
                    <TableCell>{l.issues.length ? <Stack spacing={0.25}>{l.issues.map((i, k) => <Typography key={k} variant="caption" color="error.main">{i}</Typography>)}</Stack> : <Typography variant="caption" color="text.secondary">{t('seafarers.cl.noIssues')}</Typography>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table></TableContainer>
          </Card>
        </Grid>
      </Grid>
      <Dialog open={!!decision} onClose={() => !busy && setDecision(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{decision?.kind === 'clear' ? t('seafarers.cl.clearTitle') : t('seafarers.cl.queryTitle')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          {decision?.kind === 'clear' && c && !c.ok && <Alert severity="warning" sx={{ mb: 1.5 }}>{c.summary.join(' · ')}</Alert>}
          <TextField fullWidth multiline minRows={2} size="small" label={decision?.kind === 'clear' ? t('seafarers.cl.clearNote') : t('seafarers.cl.queryReason')} value={decision?.note ?? ''} onChange={(e) => decision && setDecision({ ...decision, note: e.target.value })} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button onClick={() => setDecision(null)} disabled={busy}>{t('common.cancel')}</Button><Button variant="contained" onClick={decide} disabled={busy || (decision?.kind === 'query' && !decision.note.trim())}>{t('common.confirm')}</Button></DialogActions>
      </Dialog>
    </>
  );
}
