import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Box, Typography, Chip, Stack, Skeleton, Table, TableHead, TableRow, TableCell, TableBody, Collapse, IconButton, Button, Slider, Grid, Divider, TableContainer } from '@mui/material';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import api from '../../api/client';
import { useAppDispatch, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import { hasPerm } from '../../utils/perms';
import PageHeader from '../../components/common/PageHeader';
import FormDrawer from '../../components/common/FormDrawer';
import PageStats from '../../components/common/PageStats';
import { MONO } from '../../theme';
import { bandMeta, factorPct, ScoreBar, WEIGHT_KEYS, WEIGHT_LABELS, WEIGHT_MAX } from './shared';
import type { RiskScoreRow, RiskWeights } from './types';

/* The vessel risk register — every active ship scored live from its operational records. A row opens into its factor
 * decomposition, because a score nobody can trace to a record is a score nobody should act on. */
const SR_ONLY = { position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 } as const;

function Row({ r }: { r: RiskScoreRow }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const [bl, bc] = bandMeta(r.band);
  return (
    <>
      <TableRow hover sx={{ cursor: 'pointer', '& td': { borderBottom: open ? 0 : undefined } }} onClick={() => setOpen(!open)}>
        <TableCell sx={{ width: 34, px: 1 }}>
          <IconButton size="small" aria-label={`${open ? 'Collapse' : 'Expand'} ${r.name}`} aria-expanded={open}>{open ? <KeyboardArrowUpRoundedIcon fontSize="inherit" /> : <KeyboardArrowDownRoundedIcon fontSize="inherit" />}</IconButton>
        </TableCell>
        <TableCell><b>{r.name}</b></TableCell>
        <TableCell sx={{ fontFamily: MONO, fontSize: 12.5 }}>{r.imo}</TableCell>
        <TableCell>{r.type}</TableCell>
        <TableCell>{r.flag}</TableCell>
        <TableCell>{r.built ?? '—'}</TableCell>
        <TableCell sx={{ minWidth: 160 }}><ScoreBar score={r.score} band={r.band} /></TableCell>
        <TableCell><Chip size="small" label={bl} color={bc} sx={{ height: 21, fontSize: 11 }} /></TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ py: 1.5, pl: 5, pr: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Factor decomposition — every point traces to a record; nothing in this score is a black box.</Typography>
              <Grid container spacing={1}>
                {r.factors.map((f) => (
                  <Grid item xs={12} sm={6} md={4} key={f.key}>
                    <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                        <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>{f.label}</Typography>
                        <Typography sx={{ fontFamily: MONO, fontSize: 12 }}>{f.points}/{f.max}</Typography>
                      </Stack>
                      <Box aria-hidden sx={{ height: 4, borderRadius: 3, bgcolor: 'divider', mt: 0.5, mb: 0.5, overflow: 'hidden' }}>
                        <Box sx={{ width: `${factorPct(f)}%`, height: '100%', bgcolor: 'primary.main' }} />
                      </Box>
                      <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{f.evidence}</Typography>
                    </Box>
                  </Grid>
                ))}
              </Grid>
              <Button size="small" sx={{ mt: 1 }} onClick={(e) => { e.stopPropagation(); navigate(`/vessels/${r.vesselId}`); }}>Open vessel record →</Button>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

export default function RiskRegister() {
  const dispatch = useAppDispatch();
  const user = useUser();
  const [rows, setRows] = useState<RiskScoreRow[] | null>(null);
  const [weights, setWeights] = useState<Partial<RiskWeights>>({});
  const [weightsDlg, setWeightsDlg] = useState(false);
  const [draft, setDraft] = useState<Partial<RiskWeights>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<RiskScoreRow[]>('/risk/scores')
    .then((r) => { setRows(r.data); setWeights((r.meta?.weights as RiskWeights | undefined) || {}); })
    .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))), [dispatch]);
  useEffect(() => { load(); }, [load]);

  if (!rows) return <Skeleton variant="rounded" height={480} />;

  const applyWeights = () => {
    setBusy(true);
    api.put('/risk/weights', draft)
      .then(() => { dispatch(notify('Weights updated — scores recomputed')); setWeightsDlg(false); load(); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <PageHeader icon={InsightsRoundedIcon} iconColor="#A33229" title="Vessel risk register" sub="Explainable, factor-weighted profiles across the active fleet — recomputed live from operational records"
        actions={hasPerm(user, 'risk.manage') && (
          <Button variant="outlined" startIcon={<TuneRoundedIcon />} onClick={() => { setDraft({ ...weights }); setWeightsDlg(true); }}>Model weights</Button>
        )} />
      <PageStats scope="risk" />
      <Card>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" aria-label="Vessel risk register">
            <TableHead><TableRow>
              <TableCell><Box component="span" sx={SR_ONLY}>Details</Box></TableCell><TableCell>Vessel</TableCell><TableCell>IMO</TableCell><TableCell>Type</TableCell>
              <TableCell>Flag</TableCell><TableCell>Built</TableCell><TableCell>Risk score</TableCell><TableCell>Band</TableCell>
            </TableRow></TableHead>
            <TableBody>
              {rows.map((r) => <Row key={r.vesselId} r={r} />)}
              {rows.length === 0 && <TableRow><TableCell colSpan={8}><Typography sx={{ py: 3, textAlign: 'center' }} color="text.secondary">No active vessels to score.</Typography></TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      <FormDrawer open={weightsDlg} title="Risk model weights" width="480px" subtitle="Weights are policy — every change is audited and versioned"
        onClose={() => setWeightsDlg(false)} busy={busy} submitLabel="Apply weights" onSubmit={applyWeights}>
        <Stack spacing={2.5} divider={<Divider />}>
          {WEIGHT_KEYS.map((key) => (
            <Box key={key}>
              <Stack direction="row" justifyContent="space-between">
                <Typography id={`risk-weight-${key}`} sx={{ fontWeight: 600, fontSize: 14 }}>{WEIGHT_LABELS[key]}</Typography>
                <Typography sx={{ fontFamily: MONO }}>{draft[key] ?? 0}</Typography>
              </Stack>
              <Slider size="small" min={0} max={WEIGHT_MAX} value={draft[key] ?? 0} aria-labelledby={`risk-weight-${key}`}
                onChange={(_, v) => setDraft((d) => ({ ...d, [key]: v as number }))} />
            </Box>
          ))}
          <Typography variant="caption" color="text.secondary">Scores are normalised to 100 across the total weight, so raising one factor lowers the relative influence of the rest.</Typography>
        </Stack>
      </FormDrawer>
    </>
  );
}
