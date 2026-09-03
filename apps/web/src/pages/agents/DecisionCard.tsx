import { Box, Card, Chip, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import { MONO } from '../../theme';
import { fmtDT } from '../../utils/format';
import { confText, dispositionMeta, effectLabel, escalationMeta, escalationText, maxContribution } from './constants';
import type { AiDecision } from './types';

/* One decision, as an officer needs to read it: what the agent decided, what it decided it about, why, and how
 * far each input carried the conclusion. The factor bars are the explainable part — a reviewer sees which inputs
 * did the work, not only what the answer was. Nothing here identifies a vendor: the runtime profile in force is
 * a configuration key on the record. */

export default function DecisionCard({ d, dense = false }: { d: AiDecision; dense?: boolean }) {
  const { label, color } = dispositionMeta(d.disposition);
  const factors = d.factors || [];
  const max = maxContribution(factors);
  const esc = escalationMeta(d.escalationCode);
  return (
    <Card variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography sx={{ fontWeight: 700, fontSize: 12.5, flex: 1 }}>{d.action}</Typography>
        {d.effect === 'IRREVERSIBLE' && <Chip size="small" color="error" variant="outlined" label={effectLabel(d.effect)} sx={{ height: 19, fontSize: 10 }} />}
        <Chip size="small" color={color} label={label} sx={{ height: 19, fontSize: 10 }} variant={color === 'default' ? 'outlined' : 'filled'} />
      </Stack>
      <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
        {d.subjectType}{d.subjectLabel ? ` · ${d.subjectLabel}` : ''} · {fmtDT(d.at)}
      </Typography>
      {d.explanation && <Typography sx={{ fontSize: 12, mt: 0.75 }}>{d.explanation}</Typography>}

      {!!factors.length && !dense && (
        <Box sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>What drove it</Typography>
          {factors.map((f, i) => (
            <Box key={`${f.factor}-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.4 }}>
              <Tooltip describeChild title={f.weight != null ? `Weight ${f.weight}` : ''}>
                <Typography sx={{ fontSize: 11, width: 150 }} noWrap>{f.factor}</Typography>
              </Tooltip>
              <LinearProgress variant="determinate" aria-label={f.factor} value={Math.min(100, (Math.abs(f.contribution || 0) / max) * 100)}
                color={(f.contribution || 0) < 0 ? 'warning' : 'primary'} sx={{ flex: 1, height: 6, borderRadius: 3 }} />
              <Typography sx={{ fontSize: 10.5, width: 74, textAlign: 'right', fontFamily: MONO, color: 'text.secondary' }}>
                {f.value ?? f.contribution ?? '—'}
              </Typography>
            </Box>
          ))}
        </Box>
      )}

      <Typography sx={{ mt: 1, fontSize: 10.5, fontFamily: MONO, color: 'text.secondary' }}>
        confidence {confText(d.confidence)} · threshold {confText(d.threshold)} · {String(d.autonomyLevel || '').toLowerCase()}
        {d.modelVersion ? ` · profile ${d.modelKey || 'platform'} ${d.modelVersion}` : ''}
        {d.latencyMs ? ` · ${d.latencyMs} ms` : ''}
      </Typography>
      {d.escalationCode && (
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.5 }}>
          <b>{esc.label}</b> — {escalationText(d.escalationCode, d.escalationReason)}
        </Typography>
      )}
      {d.reviewedBy && (
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>
          Reviewed by {d.reviewedBy}{d.reviewedAt ? ` · ${fmtDT(d.reviewedAt)}` : ''}{d.overrideReason ? ` — “${d.overrideReason}”` : ''}
        </Typography>
      )}
    </Card>
  );
}
