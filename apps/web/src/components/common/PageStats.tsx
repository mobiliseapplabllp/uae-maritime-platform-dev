import { useEffect, useState } from 'react';
import { Box, Card, Typography, Skeleton } from '@mui/material';
import api from '../../api/client';
import type { StatCardData } from '../../types';
import { MONO } from '../../theme';

const SEEN = new Map<string, number>();
const TONE: Record<string, string> = { default: 'text.primary', success: 'success.main', warning: 'warning.main', error: 'error.main', info: 'info.main' };

/** Compact per-page stat strip. Pass a stats `scope` (fetched from /stats/:scope) or ready-made `cards`. `refreshKey` refetches after CRUD actions. */
export default function PageStats({ scope, cards: given, refreshKey = 0 }: { scope?: string; cards?: StatCardData[]; refreshKey?: number }) {
  const [cards, setCards] = useState<StatCardData[] | null>(given || null);
  const guess = given ? given.length : (SEEN.get(scope || '') || 4);
  useEffect(() => {
    if (given) { setCards(given); return; }
    if (!scope) return;
    let on = true;
    api.get<{ cards: StatCardData[] }>(`/stats/${scope}`).then((r) => { SEEN.set(scope, r.data.cards.length); if (on) setCards(r.data.cards); }).catch(() => { if (on) setCards([]); });
    return () => { on = false; };
  }, [scope, refreshKey, given]);

  if (cards && cards.length === 0) return null;
  return (
    <Box data-stats-scope={scope || 'inline'} sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2,1fr)', md: 'repeat(4,1fr)' }, gap: 1.5, mb: 2 }}>
      {(cards || Array.from({ length: guess })).map((c, i) => (
        <Card key={c ? (c as StatCardData).label : i} sx={{ px: 1.75, py: 1.25 }}>
          {c ? (
            <>
              <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 20, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums', color: TONE[(c as StatCardData).tone || 'default'] || 'text.primary' }}>{(c as StatCardData).value}</Typography>
              <Typography sx={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'text.secondary', mt: 0.25 }}>{(c as StatCardData).label}</Typography>
              {(c as StatCardData).sub && <Typography sx={{ fontSize: 11, color: 'text.secondary' }} noWrap>{(c as StatCardData).sub}</Typography>}
            </>
          ) : <Skeleton height={52} />}
        </Card>
      ))}
    </Box>
  );
}
