import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, Box, Typography, Skeleton, Stack, ButtonGroup, Button, Tooltip } from '@mui/material';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { CONSEQ, LIKELY, matrixBand } from './constants';
import type { MatrixCell, RiskMatrixData } from './types';

/* 5×5 likelihood × consequence matrix — initial risk (as reported) next to residual risk (after response/closure), the classic HSE heatmap. */
const WINDOWS = [90, 180, 365];

function Matrix({ title, cells, days }: { title: string; cells: MatrixCell[]; days: number }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const byKey = Object.fromEntries(cells.map((c) => [`${c.likelihood}:${c.consequence}`, c])) as Record<string, MatrixCell | undefined>;
  return (
    <Card sx={{ p: 2.5, height: '100%' }}>
      <Typography variant="h6" component="h2" sx={{ fontSize: 15, mb: 0.5 }}>{title}</Typography>
      <Typography variant="caption" color="text.secondary">{t('incidents.casesFrom', { n: days })}</Typography>
      {/* A grid owns rows and rows own cells: putting gridcells straight under the grid left assistive
          technology with fifty cells and no way to say which row any of them was in. The CSS grid still
          lays the whole thing out in one flow — `display: contents` lets each row carry the semantics
          without taking part in the layout. */}
      <Box role="grid" aria-label={title} sx={{ display: 'grid', gridTemplateColumns: '92px repeat(5, 1fr)', mt: 2.5, gap: '3px' }}>
        <Box role="row" sx={{ display: 'contents' }}>
          <Box role="columnheader" />
          {CONSEQ.map((c) => <Typography role="columnheader" key={c} sx={{ fontSize: 9.5, fontWeight: 700, textAlign: 'center', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{c}</Typography>)}
        </Box>
        {[5, 4, 3, 2, 1].map((l) => (
          <Box role="row" key={l} sx={{ display: 'contents' }}>
            <Typography role="rowheader" sx={{ fontSize: 10.5, fontWeight: 700, color: 'text.secondary', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', pr: 1 }}>{LIKELY[l - 1]}</Typography>
            {[1, 2, 3, 4, 5].map((c) => {
              const cell = byKey[`${l}:${c}`];
              const n = cell ? cell.count : 0;
              const tip = cell ? cell.sample.map((s) => `${s.number} — ${s.title}`).join('\n') : t('incidents.noCases');
              return (
                <Tooltip key={c} title={tip}>
                  <Box role="gridcell" aria-label={`${LIKELY[l - 1]} × ${CONSEQ[c - 1]}: ${n}`} onClick={() => cell && cell.sample[0] && navigate(`/incidents/${cell.sample[0].id}`)}
                    sx={{ bgcolor: matrixBand(l, c), opacity: n ? 1 : 0.18, borderRadius: '5px', minHeight: 46, display: 'grid', placeItems: 'center', cursor: n ? 'pointer' : 'default', transition: 'transform .12s', '&:hover': n ? { transform: 'scale(1.04)' } : {} }}>
                    {n > 0 && <Typography sx={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{n}</Typography>}
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
        ))}
      </Box>
    </Card>
  );
}

export default function RiskMatrix() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [data, setData] = useState<RiskMatrixData | null>(null);
  const [days, setDays] = useState(180);

  useEffect(() => {
    api.get<RiskMatrixData>('/incidents/risk-matrix', { params: { days } }).then((r) => setData(r.data)).catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
  }, [dispatch, days]);

  if (!data) return <><PageHeader icon={GridViewRoundedIcon} iconColor="#B3452E" title={t('incidents.matrixTitle')} sub="Loading…" /><Skeleton variant="rounded" height={420} /></>;

  return (
    <>
      <PageHeader icon={GridViewRoundedIcon} iconColor="#B3452E" title={t('incidents.matrixTitle')} sub={t('incidents.matrixSub', { n: data.total })}
        actions={(
          <ButtonGroup size="small" variant="outlined" aria-label="Window">
            {WINDOWS.map((d) => <Button key={d} variant={days === d ? 'contained' : 'outlined'} onClick={() => setDays(d)}>{d === 365 ? t('incidents.oneYear') : t('incidents.nDays', { n: d })}</Button>)}
          </ButtonGroup>
        )} />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Box sx={{ flex: 1 }}><Matrix title={t('incidents.initialRisk')} cells={data.initial} days={days} /></Box>
        <Box sx={{ flex: 1 }}><Matrix title={t('incidents.residualRisk')} cells={data.residual} days={days} /></Box>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>{t('incidents.matrixNote')}</Typography>
    </>
  );
}
