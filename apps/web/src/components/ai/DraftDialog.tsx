import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import api from '../../api/client';
import { MONO } from '../../theme';

/* Bilingual drafting: the assistant prepares a notice, a decision letter, an inspection summary or a deficiency notice
 * from the record it is given, in the language asked for, and says which records it drew on. A draft is never issued
 * from here — the person copies it into the screen that issues, and reads it first. */

export type DraftKind = 'NOTICE' | 'DECISION_LETTER' | 'INSPECTION_SUMMARY' | 'DEFICIENCY_NOTICE';
interface Draft { id: string; kind: DraftKind; title: string; body: string; citations: { label: string; link: string }[]; language: string; engine: string; subjectLabel: string; preparedAt?: string }
const KIND_LABEL: Record<DraftKind, [string, string]> = { NOTICE: ['Notice', 'إشعار'], DECISION_LETTER: ['Decision letter', 'خطاب قرار'], INSPECTION_SUMMARY: ['Inspection summary', 'ملخص التفتيش'], DEFICIENCY_NOTICE: ['Deficiency notice', 'إشعار بأوجه القصور'] };

export default function DraftDialog({ open, onClose, kind, subjectId, subjectLabel }: { open: boolean; onClose: () => void; kind: DraftKind; subjectId: string; subjectLabel?: string }) {
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const [language, setLanguage] = useState<'en' | 'ar'>(ar ? 'ar' : 'en');
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null); const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) { setDraft(null); setError(null); setCopied(false); } }, [open, subjectId]);
  const prepare = () => {
    setBusy(true); setError(null);
    api.post<Draft>('/ai/drafts', { kind, subjectId, language, ...(note.trim() ? { note: note.trim() } : {}) }).then((r) => setDraft(r.data)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const copy = () => { if (!draft) return; navigator.clipboard?.writeText(`${draft.title}\n\n${draft.body}`).then(() => setCopied(true)).catch(() => setCopied(false)); };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth data-testid="draft-dialog">
      <DialogTitle sx={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 1 }}><AutoAwesomeRoundedIcon sx={{ fontSize: 18, color: '#75479C' }} />{t('ai.draft.title', { defaultValue: 'Draft a {{kind}} with the assistant', kind: ar ? KIND_LABEL[kind][1] : KIND_LABEL[kind][0].toLowerCase() })}</DialogTitle>
      <DialogContent>
        {subjectLabel && <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>{subjectLabel}</Typography>}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
          <ToggleButtonGroup size="small" exclusive value={language} onChange={(_e, v: 'en' | 'ar' | null) => v && setLanguage(v)} aria-label={t('ai.draft.language', 'Language')}>
            <ToggleButton value="en" data-testid="draft-lang-en">English</ToggleButton><ToggleButton value="ar" data-testid="draft-lang-ar">العربية</ToggleButton>
          </ToggleButtonGroup>
          <TextField size="small" fullWidth label={t('ai.draft.note', 'Anything the draft should say')} value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 400, 'data-testid': 'draft-note' }} />
          <Button variant="contained" onClick={prepare} disabled={busy} startIcon={busy ? <CircularProgress size={14} /> : undefined} data-testid="draft-prepare" sx={{ whiteSpace: 'nowrap' }}>{draft ? t('ai.draft.again', 'Prepare again') : t('ai.draft.prepare', 'Prepare the draft')}</Button>
        </Stack>
        {error && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
        {draft && (
          <Box data-testid="draft-body">
            <Typography sx={{ fontWeight: 700, fontSize: 14, mb: 0.75 }} dir={draft.language === 'ar' ? 'rtl' : 'ltr'}>{draft.title}</Typography>
            <Box component="pre" dir={draft.language === 'ar' ? 'rtl' : 'ltr'} sx={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6, m: 0, p: 1.5, bgcolor: 'action.hover', borderRadius: 1.5, maxHeight: 360, overflowY: 'auto' }}>{draft.body}</Box>
            <Stack direction="row" spacing={0.75} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
              {draft.citations.map((c) => <Chip key={`${c.label}-${c.link}`} size="small" label={c.label} sx={{ height: 22, fontSize: 11 }} />)}
              <Typography sx={{ fontSize: 10.5, color: 'text.secondary', fontFamily: MONO, ml: 'auto !important' }}>{draft.engine}</Typography>
            </Stack>
            <Alert severity="info" sx={{ mt: 1, fontSize: 12 }}>{t('ai.draft.notIssued', 'A draft, prepared from the record and not issued. Read it before it goes anywhere.')}</Alert>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {draft && <Button startIcon={<ContentCopyRoundedIcon sx={{ fontSize: 15 }} />} onClick={copy} data-testid="draft-copy">{copied ? t('ai.draft.copied', 'Copied') : t('ai.draft.copy', 'Copy the text')}</Button>}
        <Button onClick={onClose}>{t('common.close', 'Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
