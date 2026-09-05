import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Grid, Box, Typography, TextField, Button, Stack, Avatar, Divider, Chip, Dialog, DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemText, IconButton, Tooltip } from '@mui/material';
import QRCode from 'qrcode';
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded';
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import { passwordProblems, PASSWORD_RULE_TEXT } from '@maritime/contracts';
import api from '../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../store';
import { setMfa } from '../store/authSlice';
import { notify } from '../store/uiSlice';
import PageHeader from '../components/common/PageHeader';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { fmtDT, initials } from '../utils/format';
import { MONO } from '../theme';

interface MfaStatus { enrolled: boolean; enrolledAt?: string | null; required: boolean; dueAt?: string | null; recoveryCodesLeft: number; enforcedFrom: string | null; graceDays: number }
interface SessionRow { id: string; startedAt: string; lastUsedAt: string; expiresAt: string; userAgent: string; ip: string; device: string }

/** Two-step verification: status, enrolment with a scannable code, recovery codes, and switching it off where the role allows. */
function SecurityCard() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<'off' | 'codes' | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<MfaStatus>('/auth/mfa').then((r) => { setStatus(r.data); dispatch(setMfa({ required: r.data.required, enrolled: r.data.enrolled, dueAt: r.data.dueAt ?? null })); }).catch(err), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const start = () => { setBusy(true); api.post<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', {}).then(async (r) => { const qr = await QRCode.toDataURL(r.data.otpauthUri, { margin: 1, width: 196 }).catch(() => ''); setEnrol({ ...r.data, qr }); setCode(''); }).catch(err).finally(() => setBusy(false)); };
  const activate = () => { setBusy(true); api.post<{ recoveryCodes: string[] }>('/auth/mfa/activate', { code: code.trim() }).then((r) => { setEnrol(null); setCodes(r.data.recoveryCodes); dispatch(notify(t('security.enrolled'))); load(); }).catch(err).finally(() => setBusy(false)); };
  const withPassword = () => {
    setBusy(true);
    const req = confirming === 'off' ? api.post('/auth/mfa/disable', { password }).then(() => { dispatch(notify(t('security.disabled'))); }) : api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { password }).then((r) => setCodes(r.data.recoveryCodes));
    req.then(() => { setConfirming(null); setPassword(''); load(); }).catch(err).finally(() => setBusy(false));
  };
  return (
    <Card sx={{ p: 3 }} data-testid="security-card">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}><ShieldRoundedIcon color="primary" /><Typography variant="h6" sx={{ fontSize: 15 }}>{t('security.twoStep')}</Typography></Stack>
      {status && (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Chip size="small" color={status.enrolled ? 'success' : 'default'} label={status.enrolled ? t('security.on') : t('security.off')} data-testid="mfa-status" />
            <Chip size="small" variant="outlined" label={status.required ? t('security.requiredByRole') : t('security.optional')} />
            {status.enrolled && <Typography variant="caption" color="text.secondary">{t('security.codesLeft', { n: status.recoveryCodesLeft })}</Typography>}
            {!status.enrolled && status.dueAt && <Typography variant="caption" color="warning.main">{t('login.mfaDue', { date: String(status.dueAt).slice(0, 10) })}</Typography>}
          </Stack>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            {!status.enrolled && <Button variant="contained" size="small" onClick={start} disabled={busy} data-testid="mfa-setup">{t('security.setUp')}</Button>}
            {status.enrolled && <Button size="small" onClick={() => { setConfirming('codes'); setPassword(''); }} disabled={busy}>{t('security.newCodes')}</Button>}
            {status.enrolled && !status.required && <Button size="small" color="error" onClick={() => { setConfirming('off'); setPassword(''); }} disabled={busy}>{t('security.turnOff')}</Button>}
          </Stack>
        </Stack>
      )}
      <Dialog open={!!enrol} onClose={() => !busy && setEnrol(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('login.mfaEnrolTitle')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">{t('security.scanHint')}</Typography>
            {enrol?.qr && <Box component="img" src={enrol.qr} alt={t('login.mfaQrAlt')} sx={{ width: 196, height: 196, alignSelf: 'center', borderRadius: 1, border: 1, borderColor: 'divider' }} />}
            <Typography variant="caption" color="text.secondary">{t('login.mfaSecret')}</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: 13, letterSpacing: '0.08em', wordBreak: 'break-all' }} data-testid="mfa-secret">{enrol?.secret}</Typography>
            <TextField autoFocus size="small" label={t('login.mfaCode')} value={code} onChange={(e) => setCode(e.target.value)} inputProps={{ 'data-testid': 'mfa-code', inputMode: 'numeric' }} autoComplete="one-time-code" />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setEnrol(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={activate} disabled={busy || code.trim().length !== 6} data-testid="mfa-activate">{t('security.activate')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!codes} onClose={() => setCodes(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('login.mfaRecoveryTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{t('login.mfaRecoveryHint')}</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5, columns: 2, fontFamily: MONO, fontSize: 14 }} data-testid="recovery-codes">{(codes ?? []).map((c) => <li key={c}>{c}</li>)}</Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}><Button variant="contained" onClick={() => setCodes(null)}>{t('common.close')}</Button></DialogActions>
      </Dialog>
      <Dialog open={!!confirming} onClose={() => !busy && setConfirming(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{confirming === 'off' ? t('security.turnOff') : t('security.newCodes')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            {confirming === 'off' && <Typography variant="body2" color="text.secondary">{t('security.confirmTurnOff')}</Typography>}
            <TextField autoFocus size="small" type="password" label={t('security.currentPassword')} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={() => setConfirming(null)} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="contained" color={confirming === 'off' ? 'error' : 'primary'} onClick={withPassword} disabled={busy || !password}>{t('common.confirm')}</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

/** Every device signed in to the account, and a way to end any of them. */
function SessionsCard() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const current = useAppSelector((s) => s.auth.sessionId);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [ending, setEnding] = useState<SessionRow | 'others' | null>(null);
  const [busy, setBusy] = useState(false);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));
  const load = useCallback(() => api.get<SessionRow[]>('/auth/sessions').then((r) => setRows(r.data)).catch(err), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const end = () => {
    if (!ending) return; setBusy(true);
    const req = ending === 'others' ? api.delete<{ revoked: number }>('/auth/sessions', { data: current ? { keep: current } : {} }).then((r) => dispatch(notify(t('security.endedOthers', { n: r.data.revoked })))) : api.delete(`/auth/sessions/${ending.id}`).then(() => dispatch(notify(t('security.ended'))));
    req.then(() => { setEnding(null); load(); }).catch(err).finally(() => setBusy(false));
  };
  return (
    <Card sx={{ p: 3 }} data-testid="sessions-card">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}><DevicesRoundedIcon color="primary" /><Typography variant="h6" sx={{ fontSize: 15 }}>{t('security.sessions')}</Typography></Stack>
      <Typography variant="body2" color="text.secondary">{t('security.sessionsHint')}</Typography>
      <List dense disablePadding sx={{ mt: 1 }} aria-label={t('security.sessions')}>
        {(rows ?? []).map((s) => (
          <ListItem key={s.id} disableGutters secondaryAction={s.id === current ? <Chip size="small" color="primary" label={t('security.thisDevice')} /> : <Tooltip title={t('security.end')}><IconButton size="small" edge="end" aria-label={`${t('security.end')} ${s.device}`} onClick={() => setEnding(s)}><LogoutRoundedIcon fontSize="small" /></IconButton></Tooltip>}>
            <ListItemText primary={<span style={{ fontWeight: 600 }}>{s.device}</span>} secondary={`${s.ip || '—'} · ${t('security.started')} ${fmtDT(s.startedAt)} · ${t('security.lastUsed')} ${fmtDT(s.lastUsedAt)}`} />
          </ListItem>
        ))}
      </List>
      {rows && rows.filter((s) => s.id !== current).length === 0 && <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>{t('security.noSessions')}</Typography>}
      {rows && rows.filter((s) => s.id !== current).length > 0 && <Button size="small" color="error" onClick={() => setEnding('others')} sx={{ mt: 1 }}>{t('security.endOthers')}</Button>}
      <ConfirmDialog open={!!ending} busy={busy} title={ending === 'others' ? t('security.endOthers') : t('security.end')} message={ending && ending !== 'others' ? `${ending.device} · ${ending.ip || '—'}` : ''} onClose={() => setEnding(null)} onConfirm={end} />
    </Card>
  );
}

export default function ProfilePage() {
  const user = useUser();
  const dispatch = useAppDispatch();
  const { t } = useTranslation();
  const [vals, setVals] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  // The same check the API runs, so the button and the server never disagree about what is acceptable.
  const problems = vals.newPassword ? passwordProblems(vals.newPassword, { email: user?.email, name: user?.name }) : [];
  const mismatch = !!vals.confirm && vals.confirm !== vals.newPassword;
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
            <Typography variant="body2" color="text.secondary">Scope: {user?.scope?.level === 'NATIONAL' || !user?.scope ? 'National' : `${user.scope.level} — ${[...(user.scope.ports ?? []), ...(user.scope.facilities ?? []), ...(user.scope.companies ?? [])].join(', ')}`}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>Permissions: {user?.perms?.includes('*') ? 'all modules' : `${user?.perms?.length || 0} granted`}</Typography>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}>
          <Card sx={{ p: 3 }}>
            <Typography variant="h6" sx={{ fontSize: 15, mb: 2 }}>Change password</Typography>
            <Stack spacing={2}>
              <TextField type="password" label="Current password" autoComplete="current-password" value={vals.currentPassword} onChange={(e) => setVals((v) => ({ ...v, currentPassword: e.target.value }))} />
              <TextField type="password" label="New password" autoComplete="new-password" value={vals.newPassword} error={problems.length > 0} helperText={problems.length ? problems.join('. ') : PASSWORD_RULE_TEXT} onChange={(e) => setVals((v) => ({ ...v, newPassword: e.target.value }))} />
              <TextField type="password" label="Confirm new password" autoComplete="new-password" value={vals.confirm} error={mismatch} helperText={mismatch ? 'Passwords do not match' : ''} onChange={(e) => setVals((v) => ({ ...v, confirm: e.target.value }))} />
              <Button variant="contained" disabled={busy || !vals.currentPassword || problems.length > 0 || !vals.confirm || mismatch} onClick={() => {
                setBusy(true);
                api.post('/auth/change-password', { currentPassword: vals.currentPassword, newPassword: vals.newPassword })
                  .then(() => { dispatch(notify('Password changed')); setVals({ currentPassword: '', newPassword: '', confirm: '' }); })
                  .catch((e: Error) => dispatch(notify({ message: e.message, severity: 'error' }))).finally(() => setBusy(false));
              }}>Change password</Button>
            </Stack>
          </Card>
        </Grid>
        <Grid item xs={12} md={5}><SecurityCard /></Grid>
        <Grid item xs={12} md={5}><SessionsCard /></Grid>
      </Grid>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>{t('security.title')}: {t('security.twoStep')} · {t('security.sessions')}</Typography>
    </>
  );
}
