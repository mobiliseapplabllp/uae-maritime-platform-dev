import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Card, Chip, LinearProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, ToggleButton, ToggleButtonGroup } from '@mui/material';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import PageHeader from '../../components/common/PageHeader';
import { fmtDT } from '../../utils/format';
import { duration } from './shared';
import type { Incident } from './types';

/* Outages as records with measured durations, rather than something you reconstruct by eye from a
 * chart. Restarts appear here too: uptime going backwards between two probes is a flap that an
 * up/down chart cannot show. */

const num = { fontVariantNumeric: 'tabular-nums' } as const;

export default function PlatformIncidentsPage() {
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [rows, setRows] = useState<Incident[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'open'>('all');

  const load = useCallback(async (f: 'all' | 'open') => {
    setRows(null);
    try {
      const r = await api.get<Incident[]>('/platform/incidents', { params: { limit: 200, open: f === 'open' ? 'true' : undefined } });
      setRows(r.data);
    } catch (e) { dispatch(notify({ message: (e as Error).message, severity: 'error' })); }
  }, [dispatch]);
  useEffect(() => { void load(filter); }, [load, filter]);

  return (
    <Box>
      <PageHeader icon={HistoryRoundedIcon} title={t('platform.incidents.title')} sub={t('platform.incidents.subtitle')}
        actions={
          <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}>
            <ToggleButton value="all" data-testid="incidents-all">{t('platform.incidents.all')}</ToggleButton>
            <ToggleButton value="open" data-testid="incidents-open">{t('platform.incidents.openOnly')}</ToggleButton>
          </ToggleButtonGroup>
        } />
      {!rows && <LinearProgress sx={{ mb: 2 }} />}
      <Card>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('platform.incidents.target')}</TableCell>
                <TableCell>{t('platform.incidents.kind')}</TableCell>
                <TableCell>{t('platform.incidents.started')}</TableCell>
                <TableCell>{t('platform.incidents.ended')}</TableCell>
                <TableCell align="right">{t('platform.incidents.duration')}</TableCell>
                <TableCell>{t('platform.incidents.detail')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows?.length === 0 && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary', fontSize: 12.5 }}>{t('platform.incidents.none')}</TableCell></TableRow>}
              {(rows ?? []).map((i) => (
                <TableRow key={i.id} hover data-testid={`incident-${i.id}`}>
                  <TableCell sx={{ fontSize: 12.5, fontWeight: 600 }}>{i.target}</TableCell>
                  <TableCell><Chip size="small" color={i.kind === 'outage' ? 'error' : i.kind === 'restart' ? 'warning' : 'default'} label={i.kind} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{fmtDT(i.startedAt)}</TableCell>
                  <TableCell sx={{ fontSize: 12 }}>{i.endedAt ? fmtDT(i.endedAt) : <Chip size="small" color="error" label={t('platform.incidents.ongoing')} sx={{ height: 18, fontSize: 10 }} />}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 12, ...num }}>{duration(i.durationSec)}</TableCell>
                  <TableCell sx={{ fontSize: 11, color: 'text.secondary', maxWidth: 320 }} title={JSON.stringify(i.detail)}>
                    {typeof i.detail.error === 'string' ? i.detail.error
                      : typeof i.detail.previousUptimeSec === 'number' ? t('platform.incidents.restartedFrom', { sec: i.detail.previousUptimeSec })
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
    </Box>
  );
}
