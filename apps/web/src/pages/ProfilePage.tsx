import { useState } from 'react';
import { Card, Grid, Box, Typography, TextField, Button, Stack, Avatar, Divider, Chip } from '@mui/material';
import api from '../api/client';
import { useAppDispatch, useUser } from '../store';
import { notify } from '../store/uiSlice';
import PageHeader from '../components/common/PageHeader';
import { fmtDT, initials } from '../utils/format';

export default function ProfilePage() {
  const user = useUser();
  const dispatch = useAppDispatch();
  const [vals, setVals] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader title="My profile" />
      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 3 }}>
            <Stack direction="row" spacing={2} alignItems="center">
              <Avatar sx={{ width: 56, height: 56, bgcolor: 'primary.main', fontSize: 22, fontWeight: 700 }}>{initials(user?.name)}</Avatar>
              <Box><Typography variant="h6" sx={{ fontSize: 17 }}>{user?.name}</Typography><Typography variant="body2" color="text.secondary">{user?.email}</Typography><Chip size="small" label={user?.role?.name} variant="outlined" sx={{ mt: 0.75 }} /></Box>
            </Stack>
            <Divider sx={{ my: 2 }} />
            <Typography variant="body2" color="text.secondary">Designation: {user?.designation || '—'}</Typography>
            <Typography variant="body2" color="text.secondary">Department: {user?.department || '—'}</Typography>
            <Typography variant="body2" color="text.secondary">Last login: {fmtDT(user?.lastLoginAt)}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>Permissions: {user?.perms?.includes('*') ? 'all modules' : `${user?.perms?.length || 0} granted`}</Typography>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 3 }}>
            <Typography variant="h6" sx={{ fontSize: 15, mb: 2 }}>Change password</Typography>
            <Stack spacing={2}>
              <TextField type="password" label="Current password" autoComplete="current-password" value={vals.currentPassword} onChange={(e) => setVals((v) => ({ ...v, currentPassword: e.target.value }))} />
              <TextField type="password" label="New password" autoComplete="new-password" value={vals.newPassword} helperText="Min 12 characters with upper, lower and digits" onChange={(e) => setVals((v) => ({ ...v, newPassword: e.target.value }))} />
              <TextField type="password" label="Confirm new password" autoComplete="new-password" value={vals.confirm} error={!!vals.confirm && vals.confirm !== vals.newPassword} helperText={vals.confirm && vals.confirm !== vals.newPassword ? 'Passwords do not match' : ''} onChange={(e) => setVals((v) => ({ ...v, confirm: e.target.value }))} />
              <Button variant="contained" disabled={busy || !vals.currentPassword || vals.newPassword.length < 8 || vals.newPassword !== vals.confirm} onClick={() => {
                setBusy(true);
                api.post('/auth/change-password', { currentPassword: vals.currentPassword, newPassword: vals.newPassword })
                  .then(() => { dispatch(notify('Password changed')); setVals({ currentPassword: '', newPassword: '', confirm: '' }); })
                  .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
              }}>Change password</Button>
            </Stack>
          </Card>
        </Grid>
      </Grid>
    </>
  );
}
