import { Dialog, DialogTitle, DialogContent, Box, Grid, Typography, IconButton } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { MONO } from '../../theme';

const Pre = ({ data }: { data: unknown }) => (
  <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: 1.5, fontSize: 11.5, lineHeight: 1.5, overflow: 'auto', maxHeight: 420, fontFamily: MONO, bgcolor: (t) => (t.palette.mode === 'dark' ? '#081B26' : '#F4F7F6'), border: 1, borderColor: 'divider' }}>
    {data ? JSON.stringify(data, null, 2) : '—'}
  </Box>
);
export default function JsonDialog({ open, onClose, title, before, after }: { open: boolean; onClose: () => void; title: string; before?: unknown; after?: unknown }) {
  const both = before !== undefined && after !== undefined && before && after;
  return (
    <Dialog open={open} onClose={onClose} maxWidth={both ? 'md' : 'sm'} fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{title}<IconButton onClick={onClose} aria-label="Close"><CloseRoundedIcon /></IconButton></DialogTitle>
      <DialogContent>
        {both ? (
          <Grid container spacing={2}>
            <Grid item xs={12} md={6}><Typography variant="subtitle2" gutterBottom>Before</Typography><Pre data={before} /></Grid>
            <Grid item xs={12} md={6}><Typography variant="subtitle2" gutterBottom>After</Typography><Pre data={after} /></Grid>
          </Grid>
        ) : <Pre data={after || before} />}
      </DialogContent>
    </Dialog>
  );
}
