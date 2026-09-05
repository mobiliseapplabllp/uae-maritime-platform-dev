import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, Skeleton, Stack, Button, TextField, MenuItem, IconButton, Chip, Divider, Dialog, DialogTitle, DialogContent, DialogActions, Switch, FormControlLabel, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, ButtonBase, Tooltip } from '@mui/material';
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import ExportMenu from '../../components/common/ExportMenu';
import { MONO } from '../../theme';
import { ANSWER_TYPES, DEFAULT_PASS_PCT, REGIME_LOOKUP, answerTypeLabel, groupSections, moveItem, newTemplate, reseq, slug, totalWeight, type IndexedItem } from './constants';
import { useLookups } from '../../hooks/useLookups';
import type { ChecklistItem, ChecklistTemplate } from './types';

/* Checklist Builder — create checklist types, then add / edit / delete / reorder questions with sections, answer types, weights and critical flags.
 * Saved templates feed every new survey opened in the register. */
const BROWN = '#9C6412';
type QuestionDialog = { index?: number } | null;

export default function ChecklistBuilder() {
  const { t } = useTranslation();
  const regimes = useLookups(REGIME_LOOKUP);
  const dispatch = useAppDispatch();
  const user = useUser();
  const canManage = hasPerm(user, 'masters.manage') || hasPerm(user, 'inspections.edit');
  const [templates, setTemplates] = useState<ChecklistTemplate[] | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChecklistTemplate | null>(null);   // working copy of the selected template
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qDlg, setQDlg] = useState<QuestionDialog>(null);                // { index } edits, {} adds
  const [qVals, setQVals] = useState<Record<string, any>>({});
  const [delQ, setDelQ] = useState<IndexedItem | null>(null);
  const [delTpl, setDelTpl] = useState<ChecklistTemplate | null>(null);

  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = (keepSel?: string) => api.get<ChecklistTemplate[]>('/checklist-templates', { params: { limit: 100, sort: 'name' } }).then((r) => {
    setTemplates(r.data);
    const target = keepSel && r.data.find((x) => x.id === keepSel) ? keepSel : r.data[0]?.id;
    setSelId(target || null);
  }).catch(err);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const found = (templates || []).find((x) => x.id === selId);
    setDraft(found ? JSON.parse(JSON.stringify(found)) : null);
    setDirty(false);
  }, [selId, templates]);

  const sections = useMemo(() => (draft ? groupSections(draft.items || []) : []), [draft]);
  const weight = totalWeight(draft?.items || []);

  const mutate = (fn: (d: ChecklistTemplate) => void) => { setDraft((d) => { if (!d) return d; const n: ChecklistTemplate = JSON.parse(JSON.stringify(d)); fn(n); return n; }); setDirty(true); };
  const move = (idx: number, dir: -1 | 1) => mutate((d) => { d.items = moveItem(d.items, idx, dir); });
  const removeQ = (idx: number) => mutate((d) => { d.items = reseq(d.items.filter((_, i) => i !== idx)); });
  const saveQ = () => {
    if (!qVals.text || !qDlg) return;
    const item: Omit<ChecklistItem, 'seq'> = { text: qVals.text, category: qVals.category || 'General', answerType: qVals.answerType || 'YES_NO_NA', weight: Number(qVals.weight) || 1, critical: !!qVals.critical, guidance: qVals.guidance || '' };
    const at = qDlg.index;
    mutate((d) => {
      if (at !== undefined) d.items[at] = { ...d.items[at], ...item };
      else d.items.push({ ...item, seq: d.items.length + 1 });
      d.items = reseq(d.items);
    });
    setQDlg(null);
  };
  const saveTemplate = () => {
    if (!draft) return;
    setBusy(true);
    const version = dirty && draft.id ? (draft.version || 1) + 1 : draft.version;
    const body = { name: draft.name, inspectionType: draft.inspectionType, description: draft.description, items: draft.items, active: draft.active, passScorePct: draft.passScorePct, version };
    const req = draft.id ? api.put<ChecklistTemplate>(`/checklist-templates/${draft.id}`, body) : api.post<ChecklistTemplate>('/checklist-templates', body);
    req.then((r) => { dispatch(notify(draft.id ? t('inspections.checklistSavedVersion', { v: version }) : t('inspections.checklistSaved'))); load(r.data?.id || draft.id); }).catch(err).finally(() => setBusy(false));
  };
  const startNew = () => { setSelId(null); setDraft(newTemplate()); setDirty(true); };
  const duplicate = () => { setSelId(null); setDraft((d) => (d ? { ...JSON.parse(JSON.stringify(d)), id: undefined, name: `${d.name} (copy)`, version: 1 } : d)); setDirty(true); };
  const deleteTemplate = () => {
    if (!delTpl?.id) return;
    setBusy(true);
    api.delete(`/checklist-templates/${delTpl.id}`).then(() => { dispatch(notify(t('inspections.checklistDeleted'))); setDelTpl(null); load(); }).catch(err).finally(() => setBusy(false));
  };

  if (!templates) return <Skeleton variant="rounded" height={480} />;

  return (
    <>
      <PageHeader icon={ChecklistRoundedIcon} iconColor={BROWN} title={t('inspections.builderTitle')} sub={t('inspections.builderSub')}
        actions={canManage && (
          <Stack direction="row" spacing={1}>
            {draft && draft.items.length > 0 && (
              <ExportMenu name={`checklist-${slug(draft.name)}`} title={draft.name} landscape={false}
                columns={[{ label: '#', value: (r: ChecklistItem) => r.seq }, { label: 'Section', value: (r: ChecklistItem) => r.category }, { label: 'Question', value: (r: ChecklistItem) => r.text }, { label: 'Answer', value: (r: ChecklistItem) => r.answerType }, { label: 'Weight', value: (r: ChecklistItem) => r.weight }, { label: 'Critical', value: (r: ChecklistItem) => (r.critical ? 'YES' : '') }]}
                getRows={async () => draft.items} />
            )}
            <Button startIcon={<AddRoundedIcon />} onClick={startNew}>{t('inspections.newChecklist')}</Button>
            <Button variant="contained" startIcon={<SaveRoundedIcon />} onClick={saveTemplate} disabled={!draft || busy || !dirty || !draft.name}>{t('common.save')}{dirty ? ' *' : ''}</Button>
          </Stack>
        )} />
      <Grid container spacing={2}>
        <Grid item xs={12} md={3.5}>
          <Stack spacing={1}>
            {templates.map((x) => (
              <ButtonBase key={x.id} onClick={() => setSelId(x.id || null)} sx={{ textAlign: 'left', borderRadius: 2.5, width: '100%' }} aria-label={`Open checklist ${x.name}`}>
                <Card variant="outlined" sx={{ p: 1.5, width: '100%', borderColor: selId === x.id ? BROWN : 'divider', borderWidth: selId === x.id ? 2 : 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Typography noWrap sx={{ fontWeight: 700, fontSize: 13.5 }}>{x.name}</Typography>
                    <Chip size="small" label={x.inspectionType} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{(x.items || []).length} questions · v{x.version || 1} · pass ≥{x.passScorePct || DEFAULT_PASS_PCT}%{x.active === false ? ' · inactive' : ''}</Typography>
                </Card>
              </ButtonBase>
            ))}
            {draft && !draft.id && (
              <Card variant="outlined" sx={{ p: 1.5, borderColor: BROWN, borderWidth: 2, borderStyle: 'dashed' }}>
                <Typography sx={{ fontWeight: 700, fontSize: 13.5 }}>{draft.name || t('inspections.unsaved')}</Typography>
              </Card>
            )}
          </Stack>
        </Grid>
        <Grid item xs={12} md={8.5}>
          {!draft ? (
            <Card sx={{ p: 4, textAlign: 'center' }}><Typography color="text.secondary">{t('inspections.selectOrCreate')}</Typography></Card>
          ) : (
            <Card sx={{ p: 2.5 }}>
              <Grid container spacing={2} sx={{ mb: 1 }}>
                <Grid item xs={12} md={4}><TextField fullWidth size="small" label="Checklist name" required value={draft.name} disabled={!canManage} onChange={(e) => mutate((d) => { d.name = e.target.value; })} /></Grid>
                <Grid item xs={6} md={2.5}>
                  <TextField select fullWidth size="small" label="Type" value={draft.inspectionType} disabled={!canManage} onChange={(e) => mutate((d) => { d.inspectionType = e.target.value; })}>
                    {regimes.options.map((x) => <MenuItem key={x.value} value={x.value}>{x.label}</MenuItem>)}
                  </TextField>
                </Grid>
                <Grid item xs={6} md={2}><TextField fullWidth size="small" type="number" label="Pass score %" value={draft.passScorePct ?? DEFAULT_PASS_PCT} disabled={!canManage} onChange={(e) => mutate((d) => { d.passScorePct = Number(e.target.value); })} /></Grid>
                <Grid item xs={6} md={2} sx={{ display: 'flex', alignItems: 'center' }}>
                  <FormControlLabel control={<Switch checked={draft.active !== false} disabled={!canManage} onChange={(e) => mutate((d) => { d.active = e.target.checked; })} />} label="Active" />
                </Grid>
                <Grid item xs={6} md={1.5} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
                  {draft.id && canManage && (
                    <>
                      <Tooltip title="Duplicate as a new checklist"><IconButton onClick={duplicate} aria-label="Duplicate checklist"><ContentCopyRoundedIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Delete checklist"><IconButton color="error" onClick={() => setDelTpl(draft)} aria-label="Delete checklist"><DeleteOutlineRoundedIcon fontSize="small" /></IconButton></Tooltip>
                    </>
                  )}
                </Grid>
                <Grid item xs={12}><TextField fullWidth size="small" label="Description" value={draft.description || ''} disabled={!canManage} onChange={(e) => mutate((d) => { d.description = e.target.value; })} /></Grid>
              </Grid>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <Chip size="small" label={`${draft.items.length} questions`} sx={{ fontWeight: 700 }} />
                <Chip size="small" variant="outlined" label={`total weight ${weight}`} />
                <Chip size="small" variant="outlined" color="warning" icon={<WarningAmberRoundedIcon sx={{ fontSize: 13 }} />} label={`${draft.items.filter((i) => i.critical).length} critical`} />
                <Box sx={{ flex: 1 }} />
                {canManage && (
                  <Button size="small" variant="outlined" startIcon={<AddRoundedIcon />} onClick={() => { setQVals({ category: sections[sections.length - 1]?.[0] || 'General', answerType: 'YES_NO_NA', weight: 1 }); setQDlg({}); }}>{t('inspections.addQuestion')}</Button>
                )}
              </Stack>
              {sections.map(([cat, items]) => (
                <Box key={cat} sx={{ mb: 2 }}>
                  <Typography sx={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.5 }}>{cat} · {items.length}</Typography>
                  <TableContainer sx={{ overflowX: 'auto' }}>
                    <Table size="small" aria-label={`Section ${cat}`}>
                      <TableHead><TableRow>
                        <TableCell width={40}>#</TableCell><TableCell>Question</TableCell><TableCell width={110}>Answer</TableCell><TableCell width={64} align="right">Weight</TableCell><TableCell width={70}>Critical</TableCell>
                        {canManage && <TableCell width={130} align="right">Actions</TableCell>}
                      </TableRow></TableHead>
                      <TableBody>
                        {items.map((it) => (
                          <TableRow key={it.idx} hover>
                            <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>{it.seq}</TableCell>
                            <TableCell>
                              <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{it.text}</Typography>
                              {it.guidance && <Typography variant="caption" color="text.secondary">{it.guidance}</Typography>}
                            </TableCell>
                            <TableCell><Chip size="small" variant="outlined" label={answerTypeLabel(it.answerType)} sx={{ height: 19, fontSize: 10 }} /></TableCell>
                            <TableCell align="right">{it.weight || 1}</TableCell>
                            <TableCell>{it.critical ? <Chip size="small" color="warning" label="Critical" sx={{ height: 19, fontSize: 10 }} /> : '—'}</TableCell>
                            {canManage && (
                              <TableCell align="right">
                                <IconButton size="small" aria-label={`Move up — ${it.text}`} onClick={() => move(it.idx, -1)}><ArrowUpwardRoundedIcon sx={{ fontSize: 15 }} /></IconButton>
                                <IconButton size="small" aria-label={`Move down — ${it.text}`} onClick={() => move(it.idx, 1)}><ArrowDownwardRoundedIcon sx={{ fontSize: 15 }} /></IconButton>
                                <IconButton size="small" aria-label={`Edit — ${it.text}`} onClick={() => { setQVals({ ...it }); setQDlg({ index: it.idx }); }}><EditRoundedIcon sx={{ fontSize: 15 }} /></IconButton>
                                <IconButton size="small" color="error" aria-label={`Delete — ${it.text}`} onClick={() => setDelQ(it)}><DeleteOutlineRoundedIcon sx={{ fontSize: 15 }} /></IconButton>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Box>
              ))}
              {draft.items.length === 0 && <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>{t('inspections.noQuestions')}</Typography>}
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="caption" color="text.secondary">{t('inspections.versionNote')}</Typography>
            </Card>
          )}
        </Grid>
      </Grid>

      <Dialog open={!!qDlg} onClose={() => setQDlg(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{qDlg?.index !== undefined ? t('inspections.editQuestion') : t('inspections.addQuestion')}</DialogTitle>
        <DialogContent sx={{ pt: '12px !important' }}>
          <Grid container spacing={2}>
            <Grid item xs={12}><TextField fullWidth size="small" label="Question text" required multiline minRows={2} value={qVals.text || ''} onChange={(e) => setQVals((v) => ({ ...v, text: e.target.value }))} /></Grid>
            <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Section" value={qVals.category || ''} placeholder="e.g. Fire Safety" onChange={(e) => setQVals((v) => ({ ...v, category: e.target.value }))} /></Grid>
            <Grid item xs={6} sm={3}>
              <TextField select fullWidth size="small" label="Answer type" value={qVals.answerType || 'YES_NO_NA'} onChange={(e) => setQVals((v) => ({ ...v, answerType: e.target.value }))}>
                {ANSWER_TYPES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={6} sm={3}><TextField fullWidth size="small" type="number" label="Weight" value={qVals.weight ?? 1} onChange={(e) => setQVals((v) => ({ ...v, weight: e.target.value }))} /></Grid>
            <Grid item xs={12} sm={6} sx={{ display: 'flex', alignItems: 'center' }}>
              <FormControlLabel control={<Switch checked={!!qVals.critical} onChange={(e) => setQVals((v) => ({ ...v, critical: e.target.checked }))} />} label="Critical — a NO fails the checklist" />
            </Grid>
            <Grid item xs={12}><TextField fullWidth size="small" label="Inspector guidance (optional)" value={qVals.guidance || ''} onChange={(e) => setQVals((v) => ({ ...v, guidance: e.target.value }))} /></Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setQDlg(null)}>Cancel</Button>
          <Button variant="contained" onClick={saveQ} disabled={!qVals.text}>{qDlg?.index !== undefined ? t('inspections.saveQuestion') : t('inspections.addQuestion')}</Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog open={!!delQ} title={t('inspections.deleteQuestion')} message={`Remove "${delQ?.text?.slice(0, 80)}" from this checklist?`} onClose={() => setDelQ(null)} onConfirm={() => { if (delQ) removeQ(delQ.idx); setDelQ(null); }} />
      <ConfirmDialog open={!!delTpl} busy={busy} title={t('inspections.deleteChecklist')} message={`Delete "${delTpl?.name}"? Surveys that already used it keep their copied questions.`} onClose={() => setDelTpl(null)} onConfirm={deleteTemplate} />
    </>
  );
}
