import { useState } from 'react';
import { useInRouterContext, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import api from '../../api/client';
import { useUser } from '../../store';
import { hasPerm } from '../../utils/perms';
import { moduleOfPath } from '../shell/AiDock';

/* "Explain this" on a chart, a panel, a yardstick or a stat card.
 *
 * The card hands over the figures it is drawn from — never more than the rows on the screen — and the assistant
 * explains them: what the card shows, what the numbers say, whether it is on target, what the measure means in the
 * trade. The facts are composed from the figures; when Settings → AI name a provider, the prose comes from it
 * through the tool gateway, as the person asking, and the dialog says so. */

export type ExplainKind = 'chart' | 'stat' | 'yardstick' | 'panel' | 'list';
export interface ExplainContext { kind: ExplainKind; title: string; sub?: string; data?: unknown; value?: string | number | null; target?: string | number | null; unit?: string; period?: string }
interface Explanation { text: string; engine: string; provider?: string; residency?: string; facts: string[]; meaning: string | null }

/** Only the rows the card draws leave the browser: long lists are cut, long strings shortened. */
const trim = (data: unknown): unknown => {
  const cut = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 80) : v);
  if (Array.isArray(data)) return data.slice(0, 120).map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r as Record<string, unknown>).slice(0, 16).map(([k, v]) => [k, Array.isArray(v) ? v.length : cut(v)])) : cut(r)));
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data as Record<string, unknown>).slice(0, 24).map(([k, v]) => [k, Array.isArray(v) ? trim(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 16)) : cut(v)]));
  return data;
};

export default function ExplainButton({ ctx, testId, corner = false }: { ctx: ExplainContext; testId?: string; corner?: boolean }) {
  const inRouter = useInRouterContext();
  const user = useUser();
  if (!inRouter || !hasPerm(user, 'ai.use')) return null;
  return <ExplainControl ctx={ctx} testId={testId} corner={corner} />;
}

function ExplainControl({ ctx, testId, corner }: { ctx: ExplainContext; testId?: string; corner: boolean }) {
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Explanation | null>(null); const [error, setError] = useState<string | null>(null);
  const ask = () => {
    setBusy(true); setError(null); setResult(null);
    const body = { kind: ctx.kind, title: ctx.title, sub: ctx.sub, value: ctx.value, target: ctx.target, unit: ctx.unit, period: ctx.period, ...(ctx.data === undefined ? {} : { data: trim(ctx.data) }), module: moduleOfPath(pathname)?.key, language: ar ? 'ar' : 'en' };
    api.post<Explanation>('/ai/explain', body).then((r) => setResult(r.data)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const label = t('ai.explain.button', 'Explain with the assistant');
  return (
    <>
      <Tooltip title={label}>
        <IconButton size="small" onClick={() => { setOpen(true); ask(); }} aria-label={`${label}: ${ctx.title}`} data-testid={testId ? `explain-${testId}` : undefined}
          sx={corner ? { position: 'absolute', top: 2, insetInlineEnd: 2, color: '#75479C', opacity: 0.7, '&:hover, &:focus-visible': { opacity: 1 } } : { color: '#75479C', p: 0.5 }}>
          <AutoAwesomeRoundedIcon sx={{ fontSize: 15 }} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth data-testid="explain-dialog">
        <DialogTitle sx={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 1 }}><AutoAwesomeRoundedIcon sx={{ color: '#75479C', fontSize: 18 }} />{ctx.title}</DialogTitle>
        <DialogContent>
          {ctx.sub && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{ctx.sub}</Typography>}
          {busy && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }} data-testid="explain-busy"><CircularProgress size={18} /><Typography sx={{ fontSize: 13 }}>{t('ai.explain.loading', 'Reading the figures…')}</Typography></Box>}
          {!busy && error && <Alert severity="warning" data-testid="explain-error">{t('ai.explain.unavailable', 'The assistant could not explain this just now.')} {error}</Alert>}
          {!busy && result && (
            <>
              <Typography component="pre" dir={ar ? 'rtl' : 'ltr'} sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13.5, lineHeight: 1.6, m: 0 }} data-testid="explain-text">{result.text}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }} data-testid="explain-engine">{t('ai.explain.engine', 'Explained by')}: {result.engine}</Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={ask} disabled={busy} data-testid="explain-again">{t('ai.explain.again', 'Explain again')}</Button>
          <Button onClick={() => setOpen(false)}>{t('common.close', 'Close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
