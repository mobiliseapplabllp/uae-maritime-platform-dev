import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Box, Card, CardActionArea, Chip, FormControl, FormControlLabel, Grid, InputLabel, MenuItem, Pagination, Select, Stack, Switch, TextField, Typography } from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import api from '../../api/client';
import { useAppSelector } from '../../store';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';
import LawFrame from './LawFrame';
import { STANDING_META, lawPath } from '../legislation/shared';
import type { PortalFacets, PortalList, PublicInstrument } from '../legislation/types';

/* The public register of legal instruments: what is in force, searchable by anyone, with the history on request.
 * The list never carries the text; the instrument page does. Filters are the facets the service computed from
 * the published register, so a type or a subject that exists appears here and one that does not, does not. */
const LIMIT = 20;
export default function LawPortal() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lang = useAppSelector((s) => s.ui.lang);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? ''; const type = params.get('type') ?? ''; const subject = params.get('subject') ?? ''; const year = params.get('year') ?? '';
  const history = params.get('history') === 'true'; const page = Math.max(1, Number(params.get('page')) || 1);
  const [draft, setDraft] = useState(q);
  const [rows, setRows] = useState<PublicInstrument[]>([]); const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<PortalFacets>({ types: [], subjects: [], years: [] });
  const [feed, setFeed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };
  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    let live = true; setLoading(true); setError('');
    api.get<PublicInstrument[]>('/public/legislation', { params: { q: q || undefined, type: type || undefined, subject: subject || undefined, year: year || undefined, history: history ? 'true' : undefined, page, limit: LIMIT, sort: '-issuedDate' }, headers: { 'X-Quiet': '1' } })
      .then((r) => { if (!live) return; const list = r as unknown as PortalList; setRows(list.data); setTotal(list.meta?.total ?? list.data.length); setFacets(list.facets ?? { types: [], subjects: [], years: [] }); setFeed(list.portal?.feed ?? null); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [q, type, subject, year, history, page]);
  useEffect(() => { const prev = document.title; document.title = t('legislation.portal.publicTitle'); return () => { document.title = prev; }; }, [t]);

  const title = (r: PublicInstrument) => (lang === 'ar' && r.titleAr ? r.titleAr : r.title);
  const typeLabel = (r: PublicInstrument) => (lang === 'ar' && r.typeLabelAr ? r.typeLabelAr : r.typeLabel);
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const typeOptions = useMemo(() => facets.types.map((f) => ({ value: f.code, label: `${lang === 'ar' && f.labelAr ? f.labelAr : f.label} (${f.count})` })), [facets.types, lang]);

  return (
    <LawFrame feedUrl={feed}>
      <Typography variant="h4" component="h1" sx={{ fontWeight: 800, mb: 0.5 }}>{t('legislation.portal.heading')}</Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>{t('legislation.portal.lead')}</Typography>
      <Box component="form" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: draft.trim() }); }} sx={{ mb: 2 }}>
        <Grid container spacing={1.5} alignItems="center">
          <Grid item xs={12} md={5}>
            <TextField fullWidth size="small" value={draft} onChange={(e) => setDraft(e.target.value)} label={t('legislation.portal.search')} placeholder={t('legislation.searchPlaceholder')} InputProps={{ startAdornment: <SearchRoundedIcon fontSize="small" sx={{ mr: 0.75, color: 'text.secondary' }} aria-hidden /> }} />
          </Grid>
          <Grid item xs={6} md={2.5}>
            <FormControl fullWidth size="small"><InputLabel id="law-type">{t('legislation.type')}</InputLabel>
              <Select labelId="law-type" label={t('legislation.type')} value={type} onChange={(e) => set({ type: String(e.target.value) })}><MenuItem value="">{t('legislation.portal.allTypes')}</MenuItem>{typeOptions.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}</Select>
            </FormControl>
          </Grid>
          <Grid item xs={6} md={2}>
            <FormControl fullWidth size="small"><InputLabel id="law-year">{t('legislation.portal.year')}</InputLabel>
              <Select labelId="law-year" label={t('legislation.portal.year')} value={year} onChange={(e) => set({ year: String(e.target.value) })}><MenuItem value="">{t('legislation.portal.allYears')}</MenuItem>{facets.years.map((y) => <MenuItem key={y.year} value={String(y.year)}>{y.year} ({y.count})</MenuItem>)}</Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} md={2.5}>
            <FormControlLabel control={<Switch checked={history} onChange={(e) => set({ history: e.target.checked ? 'true' : '' })} />} label={t('legislation.portal.includeHistory')} />
          </Grid>
        </Grid>
      </Box>
      {facets.subjects.length > 0 && (
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 2 }} role="group" aria-label={t('legislation.category')}>
          {facets.subjects.map((s) => <Chip key={s.subject} size="small" label={`${s.subject} · ${s.count}`} color={subject === s.subject ? 'primary' : 'default'} variant={subject === s.subject ? 'filled' : 'outlined'} onClick={() => set({ subject: subject === s.subject ? '' : s.subject })} />)}
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }} aria-live="polite">{loading ? t('common.loading') : error ? error : t('legislation.portal.count', { count: total })}</Typography>
      <Stack component="ul" spacing={1.25} sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {rows.map((r) => (
          <Card component="li" key={r.slug} variant="outlined">
            <CardActionArea onClick={() => navigate(lawPath(r.slug))} sx={{ p: 2 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                <Typography component="span" sx={{ fontFamily: MONO, fontWeight: 700 }}>{r.refNo}</Typography>
                <Chip size="small" variant="outlined" label={typeLabel(r)} sx={{ height: 20, fontSize: 10.5 }} />
                <Chip size="small" color={STANDING_META[r.standing]?.color ?? 'default'} label={t(`legislation.portal.standing.${r.standing}`)} sx={{ height: 20, fontSize: 10.5 }} />
              </Stack>
              <Typography component="h2" sx={{ fontWeight: 600, fontSize: 16 }}>{title(r)}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{r.subject} · {t('legislation.issuedByOn', { date: fmtD(r.issuedDate), by: r.issuedBy })}{r.effectiveDate ? ` · ${t('legislation.effectiveFrom', { date: fmtD(r.effectiveDate) })}` : ''}</Typography>
              {r.summary && <Typography variant="body2" sx={{ mt: 0.75 }}>{r.summary}</Typography>}
            </CardActionArea>
          </Card>
        ))}
      </Stack>
      {!loading && !error && rows.length === 0 && <Typography sx={{ py: 4, textAlign: 'center' }} color="text.secondary">{t('common.nothingFound')}</Typography>}
      {pages > 1 && <Pagination sx={{ mt: 2.5, display: 'flex', justifyContent: 'center' }} count={pages} page={page} onChange={(_, p) => set({ page: String(p) })} getItemAriaLabel={(kind, p) => (kind === 'page' ? t('legislation.portal.page', { page: p }) : kind)} />}
    </LawFrame>
  );
}
