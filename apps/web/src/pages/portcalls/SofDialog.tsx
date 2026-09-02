import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Skeleton, Table, TableBody, TableRow, TableCell, Divider } from '@mui/material';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import api from '../../api/client';
import { useAppDispatch } from '../../store';
import { notify } from '../../store/uiSlice';
import { fmtDT } from '../../utils/format';
import { BRAND, MONO } from '../../theme';
import type { SofData, SofEvent, VesselRef } from './types';

/* Statement of Facts — the chronological port-stay record, compiled server-side from the call's own status history, cargo operations and services. */
export default function SofDialog({ callId, open, onClose }: { callId: string; open: boolean; onClose: () => void }) {
  const dispatch = useAppDispatch();
  const [data, setData] = useState<SofData | null>(null);

  useEffect(() => {
    if (!open) { setData(null); return undefined; }
    let on = true;
    api.get<SofData>(`/port-calls/${callId}/sof`).then((r) => { if (on) setData(r.data); })
      .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' })));
    return () => { on = false; };
  }, [open, callId, dispatch]);

  const download = async () => {
    if (!data) return;
    const v: Partial<VesselRef> = data.call.vessel || {};
    const { exportPdf } = await import('../../utils/exportUtils'); // the PDF engine loads on demand
    exportPdf({
      name: `SOF-${data.call.vcn}`,
      title: `Statement of Facts — ${v.name || ''} (${data.call.vcn})`,
      subtitle: `IMO ${v.imo || '—'} · ${v.flag || ''} · Agent: ${data.call.agentName || data.call.agentCode || '—'} · Berth ${data.call.berth ? data.call.berth.code : '—'}`,
      sections: [{
        heading: 'Chronological record',
        columns: [{ key: 'at', label: 'Date / time (local)', value: (r: SofEvent) => fmtDT(r.at) }, { key: 'event', label: 'Event' }, { key: 'detail', label: 'Detail' }],
        rows: data.events,
      }],
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><DescriptionRoundedIcon aria-hidden sx={{ color: '#0797A5' }} /> Statement of Facts</DialogTitle>
      <DialogContent dividers>
        {!data && <Skeleton variant="rounded" height={300} />}
        {data && (
          <Box>
            <Box sx={{ bgcolor: BRAND.navy, color: '#fff', borderRadius: 2, p: 2, mb: 2 }}>
              <Typography sx={{ fontWeight: 800, fontSize: 16 }}>{data.call.vessel?.name}</Typography>
              <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>IMO {data.call.vessel?.imo} · {data.call.vessel?.flag} · VCN {data.call.vcn} · Berth {data.call.berth ? data.call.berth.code : '—'}</Typography>
              <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', mt: 0.5 }}>Agent: {data.call.agentName || data.call.agentCode || '—'}</Typography>
            </Box>
            <Table size="small" aria-label="Chronological record">
              <TableBody>
                {data.events.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ width: 170, fontFamily: MONO, fontSize: 11.5, color: 'text.secondary', verticalAlign: 'top' }}>{fmtDT(e.at)}</TableCell>
                    <TableCell sx={{ verticalAlign: 'top' }}>
                      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{e.event}</Typography>
                      {e.detail && <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{e.detail}</Typography>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {data.events.length === 0 && <Typography color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>No recorded events yet on this call.</Typography>}
            <Divider sx={{ my: 2 }} />
            <Typography variant="caption" color="text.secondary">Compiled automatically from the port call's status history, cargo operations and services rendered.</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit">Close</Button>
        {data && (
          <>
            <Button startIcon={<PrintRoundedIcon />} onClick={() => window.print()}>Print</Button>
            <Button variant="contained" startIcon={<PictureAsPdfRoundedIcon />} onClick={download}>Download PDF</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}
