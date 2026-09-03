import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Card, Chip, Drawer, IconButton, Skeleton, Stack, TextField, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import { fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import DecisionCard from './DecisionCard';
import { dispositionMeta, escalationMeta, escalationText, reviewStatusMeta } from './constants';
import type { AiDecisionDetail } from './types';

/* One decision, opened.
 *
 * The register is append-only by construction: a verdict is a new row that supersedes the original, never an edit.
 * That is what lets the authority answer "why did the platform do that?" months later with the decision exactly as
 * the agent made it — so this drawer shows the original, the verdict recorded on it, and the reason for both. */

export default function DecisionDrawer({ id, onClose, onReviewed }: { id: string | null; onClose: () => void; onReviewed: () => void }) {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const user = useUser();
  const canReview = hasPerm(user, 'agents.review');
  const [d, setD] = useState<AiDecisionDetail | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!id) { setD(null); return; }
    setD(null); setReason(''); setErr('');
    api.get<AiDecisionDetail>(`/agents/decisions/${id}`).then((r) => setD(r.data)).catch((e: Error) => setErr(e.message));
  }, [id]);

  const review = (accept: boolean) => {
    if (!d) return;
    if (!accept && !reason.trim()) { setErr(t('agents.overturnNeedsReason')); return; }
    setBusy(true); setErr('');
    api.post(`/agents/decisions/${d.id}/review`, { accept, reason: reason.trim() })
      .then(() => {
        dispatch(notify(accept ? t('agents.approved') : t('agents.overturned')));
        onReviewed(); onClose();
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <Drawer anchor="right" open={!!id} onClose={() => !busy && onClose()}
      PaperProps={{ sx: { width: { xs: '100%', md: '54vw' }, maxWidth: 'calc(100vw - 236px)', minWidth: 340, p: 2.5, display: 'block', overflowY: 'auto' } }}>
      {!d && id && !err && <Skeleton variant="rounded" height={420} />}
      {err && !d && <Alert severity="error">{err}</Alert>}
      {d && (
        <>
          <Stack direction="row" alignItems="flex-start" sx={{ mb: 1.5 }}>
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 18 }}>{d.action}</Typography>
              <Typography variant="caption" color="text.secondary">{d.agentName || d.agentId} · {fmtDT(d.at)}</Typography>
            </Box>
            <IconButton onClick={onClose} aria-label={t('agents.close')}><CloseRoundedIcon /></IconButton>
          </Stack>

          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Chip size="small" color={dispositionMeta(d.disposition).color} label={dispositionMeta(d.disposition).label} sx={{ height: 20, fontSize: 10.5 }} />
            <Chip size="small" variant="outlined" color={reviewStatusMeta(d.reviewStatus).color} label={reviewStatusMeta(d.reviewStatus).label} sx={{ height: 20, fontSize: 10.5 }} />
            {d.escalationCode && <Chip size="small" variant="outlined" color={escalationMeta(d.escalationCode).color} label={escalationMeta(d.escalationCode).label} sx={{ height: 20, fontSize: 10.5 }} />}
          </Stack>

          {err && <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setErr('')}>{err}</Alert>}
          <DecisionCard d={d} />

          {d.escalationCode && (
            <Alert severity={d.escalationCode === 'IRREVERSIBLE_EFFECT' || d.escalationCode === 'AGENT_SUSPENDED' ? 'error' : 'warning'} sx={{ mt: 1.5 }}>
              <b>{escalationMeta(d.escalationCode).label}</b> — {escalationText(d.escalationCode, d.escalationReason)}
            </Alert>
          )}

          <Card variant="outlined" sx={{ p: 1.75, mt: 1.5 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.givenProduced')}</Typography>
            <Box component="pre" sx={{ m: 0, fontSize: 11, fontFamily: MONO, whiteSpace: 'pre-wrap', color: 'text.secondary', maxHeight: 260, overflow: 'auto' }}>
              {JSON.stringify({ inputs: d.inputs, output: d.output }, null, 2)}
            </Box>
            {!!Object.keys(d.cohort || {}).length && (
              <Typography sx={{ mt: 1, fontSize: 11, color: 'text.secondary' }}>
                {t('agents.cohort')}: {Object.entries(d.cohort).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}
              </Typography>
            )}
          </Card>

          {d.review && (
            <Card variant="outlined" sx={{ p: 1.75, mt: 1.5, borderColor: 'info.main' }}>
              <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.humanVerdict')}</Typography>
              <DecisionCard d={d.review} dense />
            </Card>
          )}
          {d.supersedes && (
            <Card variant="outlined" sx={{ p: 1.75, mt: 1.5 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.originalDecision')}</Typography>
              <DecisionCard d={d.supersedes} dense />
            </Card>
          )}

          {d.openForReview && canReview && (
            <Card variant="outlined" sx={{ p: 1.75, mt: 1.5 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 13, mb: 1 }}>{t('agents.review')}</Typography>
              <TextField size="small" fullWidth label={t('agents.reviewReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                <Button variant="contained" size="small" disabled={busy} onClick={() => review(true)}>{t('agents.approve')}</Button>
                <Button variant="outlined" size="small" color="error" disabled={busy} onClick={() => review(false)}>{t('agents.overturn')}</Button>
              </Stack>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1 }}>{t('agents.overturnNote')}</Typography>
            </Card>
          )}
          {d.openForReview && !canReview && <Alert severity="info" sx={{ mt: 1.5 }}>{t('agents.needsPerm')}</Alert>}
          {!d.openForReview && !d.review && !d.supersedesId && (
            <Alert severity="success" sx={{ mt: 1.5 }}>{t('agents.noReviewNeeded')}</Alert>
          )}
        </>
      )}
    </Drawer>
  );
}
