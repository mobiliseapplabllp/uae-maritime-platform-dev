import { useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Link, List, ListItem, ListItemText, Stack, Table, TableBody, TableCell, TableRow, Tooltip, Typography } from '@mui/material';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import DataObjectRoundedIcon from '@mui/icons-material/DataObjectRounded';
import api from '../../api/client';
import { useAppSelector } from '../../store';
import { fmtD, fmtDT } from '../../utils/format';
import { MONO } from '../../theme';
import LawFrame, { LAW_ROOT } from './LawFrame';
import { STANDING_META, lawPath } from '../legislation/shared';
import type { PublicInstrument } from '../legislation/types';

/* One published instrument at its stable address. A superseded or withdrawn one still answers and says so,
 * so a citation written last year still resolves this year. The citation box gives the form the service
 * computed — reference, title, standing, address and content version — in both languages. */
const slugFromUrl = (url: string | null) => (url ? url.split('/').filter(Boolean).pop() ?? '' : '');
export default function LawInstrument() {
  const { slug = '' } = useParams();
  const { t } = useTranslation();
  const lang = useAppSelector((s) => s.ui.lang);
  const [row, setRow] = useState<PublicInstrument | null>(null);
  const [error, setError] = useState(''); const [copied, setCopied] = useState('');

  useEffect(() => {
    let live = true; setRow(null); setError('');
    api.get<PublicInstrument>(`/public/legislation/${encodeURIComponent(slug)}`, { headers: { 'X-Quiet': '1' } }).then((r) => { if (live) setRow(r.data); }).catch((e: Error) => { if (live) setError(e.message || t('legislation.portal.notFound')); });
    return () => { live = false; };
  }, [slug, t]);
  useEffect(() => { if (!row) return; const prev = document.title; document.title = `${row.refNo} — ${lang === 'ar' && row.titleAr ? row.titleAr : row.title}`; return () => { document.title = prev; }; }, [row, lang]);

  const copy = (what: string, text: string) => { void navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(''), 2500); }); };
  const title = row ? (lang === 'ar' && row.titleAr ? row.titleAr : row.title) : '';
  const typeLabel = row ? (lang === 'ar' && row.typeLabelAr ? row.typeLabelAr : row.typeLabel) : '';
  const successor = row?.links.find((l) => l.refNo === row.supersededBy) ?? null;
  const severity = row ? (row.standing === 'IN_FORCE' ? 'success' : row.standing === 'NOT_YET_IN_FORCE' ? 'info' : row.standing === 'WITHDRAWN' ? 'error' : 'warning') : 'info';
  const facts: [string, React.ReactNode][] = row ? [
    [t('legislation.reference'), <span style={{ fontFamily: MONO }}>{row.refNo}</span>], [t('legislation.type'), typeLabel], [t('legislation.category'), row.subject], [t('legislation.issuedBy'), row.issuedBy],
    [t('legislation.issuedDate'), fmtD(row.issuedDate)], [t('legislation.effectiveDate'), fmtD(row.effectiveDate)], [t('legislation.expiryDate'), fmtD(row.expiryDate)],
    [t('legislation.portal.published'), fmtD(row.publishedAt)], [t('legislation.portal.lastModified'), fmtDT(row.lastModified)], [t('legislation.portal.versionLabel'), <span style={{ fontFamily: MONO, fontSize: 12 }}>{row.contentHash}</span>],
  ] : [];

  return (
    <LawFrame crumb={<Button component={RouterLink} to={LAW_ROOT} size="small" startIcon={<ArrowBackRoundedIcon />}>{t('legislation.portal.backToRegister')}</Button>}>
      {!row && !error && <CircularProgress size={24} aria-label={t('common.loading')} />}
      {error && (
        <Alert severity="warning" role="alert">
          <Typography sx={{ fontWeight: 700 }}>{t('legislation.portal.notFound')}</Typography>
          <Typography variant="body2">{t('legislation.portal.notFoundHelp')}</Typography>
          <Button component={RouterLink} to={LAW_ROOT} size="small" sx={{ mt: 1 }}>{t('legislation.portal.backToRegister')}</Button>
        </Alert>
      )}
      {row && (
        <Box component="article" aria-labelledby="law-title">
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Typography component="span" sx={{ fontFamily: MONO, fontWeight: 700, fontSize: 15 }}>{row.refNo}</Typography>
            <Chip size="small" variant="outlined" label={typeLabel} />
            <Chip size="small" color={STANDING_META[row.standing]?.color ?? 'default'} label={t(`legislation.portal.standing.${row.standing}`)} />
          </Stack>
          <Typography variant="h4" component="h1" id="law-title" sx={{ fontWeight: 800, mb: 0.5 }}>{title}</Typography>
          {lang !== 'ar' && row.titleAr && <Typography dir="rtl" lang="ar" sx={{ fontWeight: 600, mb: 1, textAlign: 'right' }}>{row.titleAr}</Typography>}
          {lang === 'ar' && row.titleAr && <Typography dir="ltr" lang="en" sx={{ fontWeight: 600, mb: 1, textAlign: 'left' }}>{row.title}</Typography>}
          <Alert severity={severity} sx={{ my: 2 }} data-testid="standing-banner">
            {t(`legislation.portal.standingText.${row.standing}`, { from: fmtD(row.effectiveDate), until: fmtD(row.expiryDate), by: row.supersededBy, on: fmtD(row.withdrawnAt) })}
            {row.standing === 'SUPERSEDED' && row.supersededBy && <> <Link component={RouterLink} to={lawPath(slugFromUrl(successor?.url ?? null) || row.supersededBy)}>{t('legislation.portal.openSuccessor', { ref: row.supersededBy })}</Link></>}
          </Alert>
          <Stack direction="row" spacing={1} sx={{ mb: 2, '@media print': { display: 'none' } }} flexWrap="wrap" useFlexGap>
            <Button size="small" variant="outlined" startIcon={<PrintRoundedIcon />} onClick={() => window.print()}>{t('legislation.portal.print')}</Button>
            <Button size="small" variant="outlined" startIcon={<ContentCopyRoundedIcon />} onClick={() => copy('url', row.url)}>{copied === 'url' ? t('legislation.portal.copied') : t('legislation.portal.copyAddress')}</Button>
            <Button size="small" variant="outlined" startIcon={<DataObjectRoundedIcon />} component="a" href={`/api/public/legislation/${encodeURIComponent(row.slug)}`} target="_blank" rel="noopener">{t('legislation.portal.machineReadable')}</Button>
          </Stack>
          <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover', mb: 3 }} data-testid="citation-box">
            <Typography variant="subtitle2" component="h2" gutterBottom>{t('legislation.portal.citeAs')}</Typography>
            {row.citation && (['en', 'ar'] as const).map((l) => (
              <Stack key={l} direction="row" spacing={0.5} alignItems="flex-start" sx={{ mb: 0.75 }}>
                <Typography variant="body2" lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'} sx={{ flex: 1, textAlign: l === 'ar' ? 'right' : 'left' }}>{row.citation![l]}</Typography>
                <Tooltip title={t('legislation.portal.copyCitation')}><IconButton size="small" aria-label={l === 'ar' ? t('legislation.portal.copyCitationAr') : t('legislation.portal.copyCitation')} onClick={() => copy(l, row.citation![l])}>{copied === l ? <Typography variant="caption">{t('legislation.portal.copied')}</Typography> : <ContentCopyRoundedIcon sx={{ fontSize: 16 }} />}</IconButton></Tooltip>
              </Stack>
            ))}
            <Typography variant="caption" color="text.secondary">{t('legislation.portal.citeHelp')}</Typography>
          </Box>
          <Table size="small" sx={{ mb: 3, maxWidth: 720 }} aria-label={t('legislation.portal.facts')}>
            <TableBody>{facts.map(([k, v]) => <TableRow key={k}><TableCell component="th" scope="row" sx={{ width: 180, color: 'text.secondary', fontWeight: 600 }}>{k}</TableCell><TableCell>{v}</TableCell></TableRow>)}</TableBody>
          </Table>
          {row.summary && <Typography sx={{ fontWeight: 600, mb: 2 }}>{row.summary}</Typography>}
          <Divider sx={{ mb: 2 }} />
          <Typography component="section" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.75, fontSize: 15 }}>{row.body || t('legislation.fullTextRepository')}</Typography>
          {row.attachments.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" component="h2">{t('legislation.portal.attachments')}</Typography>
              <List dense>{row.attachments.map((a) => <ListItem key={a.name} disableGutters><ListItemText primary={<Link href={a.url!} target="_blank" rel="noopener">{a.name}</Link>} secondary={a.kind} /></ListItem>)}</List>
            </Box>
          )}
          {row.links.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="subtitle2" component="h2">{t('legislation.portal.related')}</Typography>
              <List dense>{row.links.map((l, i) => <ListItem key={`${l.kind}-${l.refNo}-${i}`} disableGutters><ListItemText primary={<Link component={RouterLink} to={lawPath(slugFromUrl(l.url) || l.refNo)} sx={{ fontFamily: MONO }}>{l.refNo}</Link>} secondary={l.kind.replace(/_/g, ' ').toLowerCase()} /></ListItem>)}</List>
            </Box>
          )}
          {row.tags.length > 0 && <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>{row.tags.map((tag) => <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} />)}</Stack>}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 3 }}>{t('legislation.portal.version', { hash: row.contentHash })} · {t('legislation.portal.lastModified')} {fmtDT(row.lastModified)}</Typography>
        </Box>
      )}
    </LawFrame>
  );
}
