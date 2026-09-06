import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import api from '../../api/client';
import { MONO } from '../../theme';

/* Drafting a service definition with the assistant, from the Service Studio.
 *
 * The person describes the service in plain language; the assistant proposes the definition — key, names in both
 * languages, applicant, category, documents, fees, service level, outputs — and says what it read each value from
 * and what it could not read. Nothing exists until the person creates the proposal as a DEV draft through the
 * Studio's own create path, after which review, approval, publication and promotion apply unchanged. */

export interface DraftField { key: string; label: string; labelAr: string; type: string; required: boolean }
export interface DraftDocument { code: string; label: string; labelAr: string; required: boolean }
export interface DraftFeeLine { code: string; description: string; descriptionAr: string; amount: number }
export interface DefinitionDraft {
  key: string; code: string; name: string; nameAr: string; category: string; categoryAr: string; domain: number; subjectKind: string;
  description: string; descriptionAr: string | null; issuesInstrument: string | null; autoApprovable: boolean; changeNote: string;
  content: { form: { fields: DraftField[]; sections: unknown[] }; documents: DraftDocument[]; fees: { lines: DraftFeeLine[]; currency: string }; sla: { days: number }; outputs: { instrumentType: string | null; instrumentClass: string | null; validityMonths: number | null } };
  basedOn: { id: string; key: string; name: string } | null;
  inferred: { field: string; value: string; evidence: string }[]; gaps: { en: string; ar: string }[]; engine: string;
  citations: { id: string; label: string; kind: string; ref: string; link: string }[];
}
export interface CreatedDefinition { id: string; key: string; code: string; name: string; nameAr: string | null; category: string; subjectKind: string; ownerModule: string; issuesInstrument: string | null; autoApprovable: boolean; currentVersion: number; status: string; versions: { version: number; environment: string; status: string; changeNote?: string; updatedAt?: string }[] }

interface Props { open: boolean; onClose: () => void; onCreated: (created: CreatedDefinition) => void }

export default function DefinitionDraftDialog({ open, onClose, onCreated }: Props) {
  const { t, i18n } = useTranslation(); const ar = i18n.language === 'ar';
  const [description, setDescription] = useState(''); const [name, setName] = useState(''); const [basedOn, setBasedOn] = useState('');
  const [draft, setDraft] = useState<DefinitionDraft | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const reset = () => { setDraft(null); setDescription(''); setName(''); setBasedOn(''); setError(null); };
  const close = () => { reset(); onClose(); };
  const compose = () => {
    setBusy(true); setError(null); setDraft(null);
    api.post<DefinitionDraft>('/ai/definitions/draft', { description: description.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(basedOn.trim() ? { basedOn: basedOn.trim() } : {}), language: ar ? 'ar' : 'en' })
      .then((r) => setDraft(r.data)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const create = () => {
    if (!draft) return;
    setBusy(true); setError(null);
    api.post<CreatedDefinition>('/services/definitions', {
      key: draft.key, code: draft.code, name: draft.name, nameAr: draft.nameAr, category: draft.category, categoryAr: draft.categoryAr, domain: draft.domain, subjectKind: draft.subjectKind,
      description: draft.description, descriptionAr: draft.descriptionAr, issuesInstrument: draft.issuesInstrument, autoApprovable: false, content: draft.content, changeNote: draft.changeNote,
    }).then((r) => { onCreated(r.data); reset(); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const lbl = (en: string, arText: string) => (ar && arText ? arText : en);
  const c = draft?.content;
  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="md" data-testid="dd-dialog">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><AutoAwesomeRoundedIcon sx={{ color: '#75479C' }} />{t('studio.ai.title', 'Draft a service definition with the assistant')}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{t('studio.ai.intro', 'Describe the service in plain language: who applies, what they lodge, what it costs, how long a decision takes, what is issued and for how long. The assistant proposes the definition; nothing is created until you say so, and the usual review, approval and publication apply.')}</Typography>
        <TextField fullWidth multiline minRows={3} label={t('studio.ai.description', 'Description')} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy}
          helperText={t('studio.ai.descriptionHelp', 'e.g. Approval for a ship chandler to supply provisions alongside; needs a trade licence and an insurance certificate; fee AED 1,500; decision within 7 working days; valid 1 year')}
          inputProps={{ 'data-testid': 'dd-description' }} sx={{ mb: 1.5 }} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
          <TextField fullWidth size="small" label={t('studio.ai.name', 'Name (optional)')} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} inputProps={{ 'data-testid': 'dd-name', maxLength: 120 }} />
          <TextField fullWidth size="small" label={t('studio.ai.basedOn', 'Based on (definition key, optional)')} value={basedOn} onChange={(e) => setBasedOn(e.target.value)} disabled={busy} inputProps={{ 'data-testid': 'dd-based-on', maxLength: 120 }} />
        </Stack>
        {error && <Alert severity="error" sx={{ mb: 1.5 }} data-testid="dd-error">{error}</Alert>}
        {draft && c && (
          <Box data-testid="dd-preview" sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 2 }}>
            <Typography sx={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'text.secondary', mb: 0.5 }}>{t('studio.ai.proposal', 'Proposed definition')}</Typography>
            <Typography sx={{ fontWeight: 700, fontSize: 16 }}>{draft.name}</Typography>
            <Typography dir="rtl" sx={{ fontSize: 14, color: 'text.secondary' }}>{draft.nameAr}</Typography>
            <Stack direction="row" spacing={0.75} sx={{ my: 1 }} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={draft.key} sx={{ fontFamily: MONO, fontSize: 11 }} /><Chip size="small" label={draft.code} sx={{ fontFamily: MONO, fontSize: 11 }} />
              <Chip size="small" label={`${t('studio.ai.subject', 'Applicant')}: ${draft.subjectKind.replace(/_/g, ' ').toLowerCase()}`} />
              <Chip size="small" label={`${t('studio.ai.category', 'Category')}: ${ar ? draft.categoryAr : draft.category}`} />
              <Chip size="small" label={`${t('studio.ai.instrument', 'Issues')}: ${draft.issuesInstrument ? draft.issuesInstrument.replace(/_/g, ' ').toLowerCase() : c.outputs.instrumentClass ? c.outputs.instrumentClass.toLowerCase() : t('studio.ai.none', 'none')}`} />
              {draft.basedOn && <Chip size="small" color="info" variant="outlined" label={`${t('studio.ai.basedOnLabel', 'Based on')}: ${draft.basedOn.name}`} />}
            </Stack>
            <Typography variant="body2" sx={{ mb: 1 }}>{draft.description}</Typography>
            <Divider sx={{ my: 1 }} />
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 12.5 }}>{t('studio.ai.documents', 'Documents')}</Typography>
                {c.documents.length ? (
                  <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 12.5 }}>{c.documents.map((d) => <li key={d.code}><span style={{ fontFamily: MONO }}>{d.code}</span> · {lbl(d.label, d.labelAr)} · {d.required ? t('studio.ai.required', 'required') : t('studio.ai.optional', 'optional')}</li>)}</Box>
                ) : <Typography variant="caption" color="text.secondary">{t('studio.ai.noDocuments', 'No document named')}</Typography>}
                <Typography sx={{ fontWeight: 700, fontSize: 12.5, mt: 1 }}>{t('studio.ai.fields', 'Form fields')}</Typography>
                <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 12.5 }}>{c.form.fields.map((f) => <li key={f.key}><span style={{ fontFamily: MONO }}>{f.key}</span> · {lbl(f.label, f.labelAr)} · {f.type}{f.required ? ` · ${t('studio.ai.required', 'required')}` : ''}</li>)}</Box>
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 12.5 }}>{t('studio.ai.fees', 'Fees')}</Typography>
                {c.fees.lines.length ? (
                  <Box component="ul" sx={{ m: 0, pl: 2.5, fontSize: 12.5 }}>{c.fees.lines.map((l) => <li key={l.code}>{lbl(l.description, l.descriptionAr)} · {c.fees.currency} {l.amount.toLocaleString()}</li>)}</Box>
                ) : <Typography variant="caption" color="text.secondary">{t('studio.ai.noFees', 'No fee stated')}</Typography>}
                <Typography sx={{ fontSize: 12.5, mt: 1 }}><b>{t('studio.ai.sla', 'Service level')}:</b> {t('studio.ai.days', { defaultValue: '{{n}} days', n: c.sla.days })}</Typography>
                <Typography sx={{ fontSize: 12.5 }}><b>{t('studio.ai.validity', 'Validity')}:</b> {c.outputs.validityMonths ? t('studio.ai.months', { defaultValue: '{{n}} months', n: c.outputs.validityMonths }) : t('studio.ai.none', 'none')}</Typography>
                <Typography sx={{ fontSize: 12.5 }}>{t('studio.ai.workflow', 'Standard workflow: submit, screening, assessment, decision, issue')}</Typography>
              </Box>
            </Stack>
            {draft.inferred.length > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography sx={{ fontWeight: 700, fontSize: 12.5, mb: 0.5 }}>{t('studio.ai.inferred', 'Read from the description')}</Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap data-testid="dd-inferred">{draft.inferred.map((i, n) => <Chip key={`${i.field}-${n}`} size="small" variant="outlined" label={`${i.field}: ${i.value} ← "${i.evidence}"`} sx={{ fontSize: 11, height: 22 }} />)}</Stack>
              </Box>
            )}
            {draft.gaps.length > 0 && (
              <Alert severity="warning" sx={{ mt: 1.5, fontSize: 12.5 }} data-testid="dd-gaps">
                <b>{t('studio.ai.gaps', 'To fill in before publishing')}</b>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>{draft.gaps.map((g, n) => <li key={n}>{ar ? g.ar : g.en}</li>)}</Box>
              </Alert>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{t('studio.ai.engine', 'Composed by')}: {draft.engine}</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={busy}>{t('common.close', 'Close')}</Button>
        <Button onClick={compose} disabled={busy || description.trim().length < 12} variant={draft ? 'outlined' : 'contained'} data-testid="dd-compose">{draft ? t('studio.ai.again', 'Compose again') : t('studio.ai.compose', 'Compose')}</Button>
        {draft && <Button onClick={create} disabled={busy} variant="contained" data-testid="dd-create">{t('studio.ai.create', 'Create as DEV draft')}</Button>}
      </DialogActions>
    </Dialog>
  );
}
