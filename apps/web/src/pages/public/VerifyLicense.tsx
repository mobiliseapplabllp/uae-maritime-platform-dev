import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Box, Card, Typography, Chip, Stack, Divider, CircularProgress } from '@mui/material';
import VerifiedRoundedIcon from '@mui/icons-material/VerifiedRounded';
import GppBadRoundedIcon from '@mui/icons-material/GppBadRounded';
import api from '../../api/client';
import PlatformWordmark from '../../components/brand/PlatformWordmark';
import { fmtD } from '../../utils/format';
import { MONO } from '../../theme';

interface Verification { licenseNo: string; entityName: string; entityType: string; status: string; issueDate?: string; expiryDate?: string; valid: boolean; signatureValid?: boolean; signedAt?: string; keyId?: string; message?: string }
/* Public verification page — anyone scanning the QR on a printed certificate lands here; no session required. */
export default function VerifyLicense() {
  const { licenseNo } = useParams();
  const [data, setData] = useState<Verification | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get<Verification>(`/public/verify/${encodeURIComponent(licenseNo || '')}`).then((r) => setData(r.data)).catch((e: Error) => setError(e.message)); }, [licenseNo]);
  const ok = data?.valid && data?.signatureValid !== false;
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 3, bgcolor: 'background.default' }}>
      <Card sx={{ p: 4, width: 520, maxWidth: '100%' }} component="main">
        <PlatformWordmark height={26} />
        <Typography variant="h5" component="h1" sx={{ mt: 2 }}>Instrument verification</Typography>
        <Typography variant="body2" color="text.secondary">Public register check for <span style={{ fontFamily: MONO }}>{licenseNo}</span></Typography>
        <Divider sx={{ my: 2 }} />
        {!data && !error && <CircularProgress size={22} />}
        {error && <Stack direction="row" spacing={1} alignItems="center"><GppBadRoundedIcon color="error" /><Typography color="error">{error}</Typography></Stack>}
        {data && (
          <Stack spacing={1.25}>
            <Stack direction="row" spacing={1} alignItems="center">
              {ok ? <VerifiedRoundedIcon color="success" sx={{ fontSize: 30 }} /> : <GppBadRoundedIcon color="error" sx={{ fontSize: 30 }} />}
              <Typography sx={{ fontWeight: 700, fontSize: 17 }}>{ok ? 'Valid and in force' : data.message || 'Not valid'}</Typography>
            </Stack>
            {[['Holder', data.entityName], ['Type', data.entityType.replace(/_/g, ' ')], ['Status', data.status], ['Issued', fmtD(data.issueDate)], ['Expires', fmtD(data.expiryDate)], ['Signed', data.signedAt ? `${fmtD(data.signedAt)} · key ${data.keyId}` : '—']].map(([k, v]) => (
              <Box key={k} sx={{ display: 'flex', gap: 2 }}><Typography sx={{ width: 90, fontFamily: MONO, fontSize: 11, textTransform: 'uppercase', color: 'text.secondary', pt: 0.3 }}>{k}</Typography><Typography sx={{ fontWeight: 600 }}>{v}</Typography></Box>
            ))}
            <Chip size="small" variant="outlined" label={data.signatureValid === false ? 'Signature mismatch — treat as tampered' : 'Signature verified against the published signing key'} color={data.signatureValid === false ? 'error' : 'success'} sx={{ alignSelf: 'flex-start' }} />
          </Stack>
        )}
      </Card>
    </Box>
  );
}
