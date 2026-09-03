import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert, Box, Button, Card, Chip, Divider, Drawer, FormControlLabel, IconButton, MenuItem, Slider, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import DecisionCard from './DecisionCard';
import { LEVELS, LEVEL_META, fieldLabel, isRunnable, pctText, raisesAutonomy, runSummary, triggerLabel } from './constants';
import type { Agent, ConfigurePayload, RunResult } from './types';

/* The agent's own page, as a slide-over off the roster.
 *
 * Four things the authority must be able to do without calling a vendor, and all four are here: see the latitude
 * the agent holds, change it with the reason recorded, suspend one that is misbehaving, and run one over live
 * records to see what it would say before reinstating it. The service refuses a widening change without a written
 * reason and says so; that refusal is shown as the sentence it is. */

interface Form { autonomyLevel: string; confidenceThreshold: number; requiresConfirmation: boolean; maxActionsPerHour: number; escalateTo: string; enabled: boolean; reason: string }
const formOf = (a: Agent): Form => ({
  autonomyLevel: a.autonomyLevel, confidenceThreshold: a.confidenceThreshold, requiresConfirmation: a.requiresConfirmation,
  maxActionsPerHour: a.maxActionsPerHour, escalateTo: a.escalateTo || '', enabled: a.enabled, reason: '',
});

export default function AgentDetailDrawer({ agentId, onClose, onChanged }: { agentId: string | null; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const canConfigure = hasPerm(user, 'agents.configure');
  const canReview = hasPerm(user, 'agents.review');
  const [agent, setAgent] = useState<Agent | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!agentId) { setAgent(null); setForm(null); return; }
    setErr(''); setNote(''); setAgent(null);
    api.get<Agent>(`/agents/${agentId}`).then((r) => { setAgent(r.data); setForm(formOf(r.data)); }).catch((e: Error) => setErr(e.message));
  }, [agentId]);

  const reload = (message?: string) => api.get<Agent>(`/agents/${agentId}`).then((r) => {
    setAgent(r.data); setForm(formOf(r.data)); if (message) setNote(message);
    onChanged();
  });

  // Only what actually moved is sent, so the service's "nothing to change" refusal means what it says.
  const changed = (a: Agent, f: Form): ConfigurePayload => {
    const body: ConfigurePayload = {};
    if (f.autonomyLevel !== a.autonomyLevel) body.autonomyLevel = f.autonomyLevel as Agent['autonomyLevel'];
    if (Number(f.confidenceThreshold) !== Number(a.confidenceThreshold)) body.confidenceThreshold = Number(f.confidenceThreshold);
    if (f.requiresConfirmation !== a.requiresConfirmation) body.requiresConfirmation = f.requiresConfirmation;
    if (Number(f.maxActionsPerHour) !== Number(a.maxActionsPerHour)) body.maxActionsPerHour = Number(f.maxActionsPerHour);
    if (f.escalateTo !== (a.escalateTo || '')) body.escalateTo = f.escalateTo;
    if (f.enabled !== a.enabled) body.enabled = f.enabled;
    if (f.reason.trim()) body.reason = f.reason.trim();
    return body;
  };

  const save = () => {
    if (!agent || !form) return;
    setBusy(true); setErr(''); setNote('');
    api.put(`/agents/${agent.agentId}`, changed(agent, form))
      .then(() => reload(t('agents.configSaved')))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const runNow = () => {
    if (!agent) return;
    setBusy(true); setErr(''); setNote('');
    api.post<RunResult>(`/agents/${agent.agentId}/run`, {})
      .then((r) => reload(runSummary(r.data)))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const suspend = () => {
    if (!agent || !form) return;
    if (!agent.suspended && !form.reason.trim()) { setErr(t('agents.suspendReason')); return; }
    setBusy(true); setErr(''); setNote('');
    api.post(`/agents/${agent.agentId}/suspend`, { suspended: !agent.suspended, reason: form.reason.trim() })
      .then(() => { dispatch(notify(agent.suspended ? t('agents.reinstated', { name: agent.name }) : t('agents.suspended', { name: agent.name }))); return reload(); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  const raising = !!(agent && form && raisesAutonomy(agent.autonomyLevel, form.autonomyLevel as Agent['autonomyLevel']));
  const droppingConfirmation = !!(agent && form && agent.requiresConfirmation && !form.requiresConfirmation);
  const needsReason = raising || droppingConfirmation;
  const runnable = !!agent && (agent.runnable ?? isRunnable(agent.agentId));

  return (
    <Drawer anchor="right" open={!!agentId} onClose={() => !busy && onClose()}
      PaperProps={{ sx: { width: { xs: '100%', md: '58vw' }, maxWidth: 'calc(100vw - 236px)', minWidth: 340, p: 2.5, display: 'block', overflowY: 'auto' } }}>
      {agent && form && (
        <>
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 1 }}>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 19 }}>{agent.name}</Typography>
              <Typography variant="caption" color="text.secondary">
                {agent.agentId} · {agent.role}{agent.domain ? ` · ${t('agents.domain', { n: agent.domain })}` : ''}
              </Typography>
            </Box>
            <IconButton onClick={onClose} aria-label={t('agents.close')}><CloseRoundedIcon /></IconButton>
          </Stack>

          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {agent.mandated && <Chip size="small" color="primary" variant="outlined" label={t('agents.mandated')} sx={{ height: 20, fontSize: 10.5 }} />}
            <Chip size="small" label={triggerLabel(agent.trigger?.kind, agent.trigger?.cadence)} variant="outlined" sx={{ height: 20, fontSize: 10.5 }} />
            {!agent.enabled && <Chip size="small" color="default" label={t('agents.disabled')} sx={{ height: 20, fontSize: 10.5 }} />}
            {agent.lastRunAt && <Chip size="small" variant="outlined" label={t('agents.lastRan', { at: fmtDT(agent.lastRunAt) })} sx={{ height: 20, fontSize: 10.5 }} />}
          </Stack>
          {agent.description && <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1.5 }}>{agent.description}</Typography>}

          {agent.suspended && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {t('agents.suspendedBy', { by: agent.suspendedBy || t('agents.anOfficer'), reason: agent.suspendedReason || t('agents.noReason') })}
            </Alert>
          )}
          {err && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setErr('')}>{err}</Alert>}
          {note && <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setNote('')}>{note}</Alert>}

          <Card variant="outlined" sx={{ p: 1.75, mb: 2 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1.25 }}>{t('agents.latitude')}</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField select size="small" label={t('agents.autonomyLevel')} sx={{ minWidth: 210 }} value={form.autonomyLevel} disabled={!canConfigure}
                onChange={(e) => setForm({ ...form, autonomyLevel: e.target.value })}>
                {LEVELS.map((l) => <MenuItem key={l} value={l}>{LEVEL_META[l].label}</MenuItem>)}
              </TextField>
              <Box sx={{ flex: 1, minWidth: 220 }}>
                <Typography variant="caption" color="text.secondary">{t('agents.thresholdHelp')}</Typography>
                <Slider size="small" min={0} max={1} step={0.01} valueLabelDisplay="auto" aria-label={t('agents.thresholdHelp')}
                  value={form.confidenceThreshold} disabled={!canConfigure}
                  onChange={(_, v) => setForm({ ...form, confidenceThreshold: Array.isArray(v) ? v[0] : v })} />
              </Box>
            </Stack>
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5 }}>{LEVEL_META[form.autonomyLevel as Agent['autonomyLevel']]?.blurb}</Typography>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1.5 }} alignItems={{ sm: 'center' }}>
              <FormControlLabel sx={{ m: 0 }} disabled={!canConfigure}
                control={<Switch size="small" checked={form.requiresConfirmation} onChange={(e) => setForm({ ...form, requiresConfirmation: e.target.checked })} />}
                label={<Typography sx={{ fontSize: 12.5 }}>{t('agents.requiresConfirmation')}</Typography>} />
              <FormControlLabel sx={{ m: 0 }} disabled={!canConfigure}
                control={<Switch size="small" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />}
                label={<Typography sx={{ fontSize: 12.5 }}>{t('agents.enabled')}</Typography>} />
              <TextField size="small" type="number" label={t('agents.maxPerHour')} sx={{ width: 150 }} value={form.maxActionsPerHour} disabled={!canConfigure}
                inputProps={{ min: 1, max: 10000 }} onChange={(e) => setForm({ ...form, maxActionsPerHour: Number(e.target.value) })} />
              <TextField size="small" label={t('agents.escalateTo')} sx={{ flex: 1, minWidth: 180 }} value={form.escalateTo} disabled={!canConfigure}
                onChange={(e) => setForm({ ...form, escalateTo: e.target.value })} />
            </Stack>

            {needsReason && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>{raising ? t('agents.raising') : t('agents.droppingConfirmation')}</Alert>
            )}
            <TextField size="small" fullWidth sx={{ mt: 1.5 }} label={t('agents.reasonLabel')} value={form.reason} disabled={!canConfigure}
              onChange={(e) => setForm({ ...form, reason: e.target.value })} />

            {canConfigure ? (
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                <Button variant="contained" size="small" disabled={busy} onClick={save}>{t('agents.saveConfig')}</Button>
                {runnable && canReview && (
                  <Tooltip title={agent.suspended || !agent.enabled ? t('agents.runBlocked') : ''}>
                    <span>
                      <Button variant="outlined" size="small" disabled={busy || agent.suspended || !agent.enabled} startIcon={<PlayArrowRoundedIcon />} onClick={runNow}>
                        {t('agents.runNow')}
                      </Button>
                    </span>
                  </Tooltip>
                )}
                <Button variant="outlined" size="small" color={agent.suspended ? 'success' : 'error'} disabled={busy}
                  startIcon={agent.suspended ? <PlayArrowRoundedIcon /> : <BlockRoundedIcon />} onClick={suspend}>
                  {agent.suspended ? t('agents.reinstate') : t('agents.suspend')}
                </Button>
              </Stack>
            ) : <Alert severity="info" sx={{ mt: 1.5 }}>{t('agents.needsConfigurePerm')}</Alert>}
          </Card>

          <Card variant="outlined" sx={{ p: 1.75, mb: 2 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.history')}</Typography>
            {(agent.changes || []).length ? (
              <Stack spacing={0.75}>
                {(agent.changes || []).map((c, i) => (
                  <Typography key={`${c.field}-${c.at}-${i}`} sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                    <b>{fieldLabel(c.field)}</b> {c.from} → {c.to} · {fmtDT(c.at)} · {c.by}{c.reason ? ` — “${c.reason}”` : ''}
                  </Typography>
                ))}
              </Stack>
            ) : <Typography variant="body2" color="text.secondary">{t('agents.noHistory')}</Typography>}
          </Card>

          <Divider sx={{ mb: 1.5 }} />
          <Stack direction="row" spacing={2} sx={{ mb: 1.5 }}>
            <Metric k={t('agents.mDecisions')} v={agent.stats?.decisions ?? 0} />
            <Metric k={t('agents.mEscalated')} v={agent.stats?.escalated ?? 0} />
            <Metric k={t('agents.mOverturned')} v={agent.stats?.overridden ?? 0} />
            <Metric k={t('agents.mAgreement')} v={pctText(agent.agreementRate, 0)} />
            <Metric k={t('agents.mConfidence')} v={agent.stats?.avgConfidence ?? 0} />
          </Stack>

          <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.recent', { n: (agent.recentDecisions || []).length })}</Typography>
          <Stack spacing={1}>
            {(agent.recentDecisions || []).map((d) => <DecisionCard key={d.id} d={d} />)}
            {!(agent.recentDecisions || []).length && <Typography variant="body2" color="text.secondary">{t('agents.noDecisions')}</Typography>}
          </Stack>
        </>
      )}
      {!agent && agentId && err && <Alert severity="error">{err}</Alert>}
    </Drawer>
  );
}

export function Metric({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Box>
      <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 15, lineHeight: 1.1 }}>{v}</Typography>
      <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary' }}>{k}</Typography>
    </Box>
  );
}
