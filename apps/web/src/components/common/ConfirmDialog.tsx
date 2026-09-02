import { Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button } from '@mui/material';

interface Props { open: boolean; title: string; message?: React.ReactNode; confirmLabel?: string; danger?: boolean; onClose: () => void; onConfirm: () => void; busy?: boolean }
export default function ConfirmDialog({ open, title, message, confirmLabel = 'Delete', danger = true, onClose, onConfirm, busy }: Props) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent><DialogContentText>{message}</DialogContentText></DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">Cancel</Button>
        <Button onClick={onConfirm} variant="contained" color={danger ? 'error' : 'primary'} disabled={busy}>{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}
