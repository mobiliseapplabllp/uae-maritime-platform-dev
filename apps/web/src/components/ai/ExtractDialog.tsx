import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import DocumentScannerRoundedIcon from '@mui/icons-material/DocumentScannerRounded';
import api from '../../api/client';
import { MONO } from '../../theme';

/* Document intelligence: the fields asked for, read out of a lodged document by the in-country model platform, through
 * the tool gateway as this person. Every value carries its confidence, and a low one is shown as something to check by
 * hand rather than as a fact. Nothing is written back from here. */

interface Extraction { callId?: string; model: string; version: number; residency: string; mode: string; fields: Record<string, { value: string; confidence: number }>; pages: number; confidence: number; latencyMs: number; withinSla: boolean }

export default function ExtractDialog({ open, onClose, documentRef, subject, defaultFields }: { open: boolean; onClose: () => void; documentRef: string; subject?: string; defaultFields: string[] }) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(defaultFields.join(', '));
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [out, setOut] = useState<Extraction | null>(null);
  useEffect(() => { if (open) { setOut(null); setError(null); setFields(defaultFields.join(', ')); } }, [open, documentRef]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = () => {
    const list = fields.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) { setError(t('ai.extract.needFields', 'Name at least one field to read')); return; }
    setBusy(true); setError(null);
    api.post<Extraction>('/ai/extract', { documentRef, fields: list, subject }).then((r) => setOut(r.data)).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const entries = out ? Object.entries(out.fields ?? {}) : [];
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="extract-dialog">
      <DialogTitle sx={{ fontSize: 15, display: 'flex', alignItems: 'center', gap: 1 }}><DocumentScannerRoundedIcon sx={{ fontSize: 18, color: '#75479C' }} />{t('ai.extract.title', 'Read the document')}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>{subject ? `${subject} · ` : ''}{documentRef}</Typography>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mb: 1.5 }}>
          <TextField size="small" fullWidth label={t('ai.extract.fields', 'Fields to read, comma-separated')} value={fields} onChange={(e) => setFields(e.target.value)} inputProps={{ 'data-testid': 'extract-fields' }} />
          <Button variant="contained" onClick={read} disabled={busy} startIcon={busy ? <CircularProgress size={14} /> : undefined} data-testid="extract-read" sx={{ whiteSpace: 'nowrap' }}>{t('ai.extract.read', 'Read')}</Button>
        </Stack>
        {error && <Alert severity="warning" sx={{ mb: 1 }}>{error}</Alert>}
        {out && (
          <Box data-testid="extract-result">
            <Stack direction="row" spacing={0.75} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`${t('ai.extract.residency', 'Residency')} ${out.residency}`} color={out.residency === 'AE' ? 'success' : 'default'} sx={{ height: 22, fontSize: 11 }} />
              <Chip size="small" label={`${out.mode} · ${out.latencyMs} ms${out.withinSla ? '' : ` · ${t('ai.extract.slow', 'over the latency budget')}`}`} sx={{ height: 22, fontSize: 11, fontFamily: MONO }} />
              <Chip size="small" label={`${t('ai.extract.overall', 'Overall confidence')} ${Math.round((out.confidence ?? 0) * 100)}%`} sx={{ height: 22, fontSize: 11 }} />
            </Stack>
            <Table size="small"><TableHead><TableRow><TableCell sx={{ fontSize: 11.5, fontWeight: 700 }}>{t('ai.extract.field', 'Field')}</TableCell><TableCell sx={{ fontSize: 11.5, fontWeight: 700 }}>{t('ai.extract.value', 'Value')}</TableCell><TableCell sx={{ fontSize: 11.5, fontWeight: 700, width: 160 }}>{t('ai.extract.confidence', 'Confidence')}</TableCell></TableRow></TableHead>
              <TableBody>{entries.map(([name, f]) => { const c = Math.round((f?.confidence ?? 0) * 100); const low = c < 50; return (
                <TableRow key={name}><TableCell sx={{ fontSize: 12.5 }}>{name}</TableCell><TableCell sx={{ fontSize: 12.5, color: low ? 'text.secondary' : 'text.primary' }}>{low ? t('ai.extract.checkByHand', 'unreadable — check by hand') : String(f?.value ?? '')}</TableCell>
                  <TableCell><Stack direction="row" alignItems="center" spacing={1}><LinearProgress variant="determinate" value={c} color={low ? 'warning' : 'success'} sx={{ flex: 1, height: 6, borderRadius: 3 }} aria-label={`${name} ${c}%`} /><Typography sx={{ fontSize: 11, fontFamily: MONO, minWidth: 34 }}>{c}%</Typography></Stack></TableCell></TableRow>); })}</TableBody></Table>
            <Typography sx={{ mt: 1, fontSize: 10.5, color: 'text.secondary' }}>{t('ai.extract.footer', 'Read through the tool gateway as you and logged there; nothing has been written to the record.')}</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{t('common.close', 'Close')}</Button></DialogActions>
    </Dialog>
  );
}
