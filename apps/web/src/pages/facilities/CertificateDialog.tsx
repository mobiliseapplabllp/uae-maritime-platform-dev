import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Typography, Divider, Chip } from '@mui/material';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import PrintRoundedIcon from '@mui/icons-material/PrintRounded';
import { BRAND_GRADIENT, MONO } from '../../theme';
import { fmtD } from '../../utils/format';
import { useProfile } from '../../config/runtime';
import { verifyUrl } from './shared';
import type { LicenceDetail } from './types';

/* Official-style certificate with a QR code that resolves to the public, unauthenticated verification page — anyone holding the print can confirm it is genuinely in force. */
export default function CertificateDialog({ licence, open, onClose }: { licence: LicenceDetail | null; open: boolean; onClose: () => void }) {
  const profile = useProfile();
  const { t } = useTranslation();
  const [qr, setQr] = useState('');

  useEffect(() => {
    if (!open || !licence) return;
    Promise.resolve().then(() => QRCode.toDataURL(verifyUrl(licence.licenseNo), { width: 220, margin: 1, color: { dark: '#0A2239', light: '#FFFFFF' } })).then(setQr).catch(() => setQr(''));
  }, [open, licence]);

  if (!licence) return null;
  const url = verifyUrl(licence.licenseNo);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}><VerifiedUserRoundedIcon aria-hidden sx={{ color: '#2C6E52' }} /> {t('facilities.certificateTitle', { cls: licence.classLabel })}</DialogTitle>
      <DialogContent dividers>
        <Box id="cert-print-area" sx={{ border: '2px solid #0A2239', borderRadius: 2, overflow: 'hidden' }}>
          <Box sx={{ background: BRAND_GRADIENT, px: 3, py: 2.5, color: '#fff' }}>
            <Typography sx={{ fontFamily: 'Archivo', fontWeight: 800, fontSize: 13, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{profile.authority}</Typography>
            <Typography sx={{ fontSize: 20, fontWeight: 800, mt: 0.5 }}>{licence.certificateName || t('facilities.certificateOf', { cls: licence.classLabel })}</Typography>
          </Box>
          <Box sx={{ p: 3, display: 'flex', gap: 3 }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{t('facilities.thisCertifies')}</Typography>
              <Typography sx={{ fontSize: 21, fontWeight: 800, mt: 0.25 }}>{licence.entityName}</Typography>
              <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>{t('facilities.holdsValid', { cls: licence.classLabel.toLowerCase() })}</Typography>
              <Typography sx={{ fontSize: 15, fontWeight: 700 }}>{licence.typeLabel}</Typography>
              {licence.convention && <Typography variant="caption" color="text.secondary">{t('facilities.issuedUnder', { convention: licence.convention })}</Typography>}
              <Divider sx={{ my: 1.5 }} />
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.25 }}>
                <Box><Typography variant="caption" color="text.secondary">{t('facilities.licenceNo')}</Typography><Typography sx={{ fontFamily: MONO, fontWeight: 700, fontSize: 13 }}>{licence.licenseNo}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">{t('facilities.status')}</Typography><Box><Chip size="small" label={licence.inForce ? t('facilities.inForce') : licence.forceReason || t('facilities.notInForce')} color={licence.inForce ? 'success' : 'error'} sx={{ height: 20 }} /></Box></Box>
                <Box><Typography variant="caption" color="text.secondary">{t('facilities.issued')}</Typography><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{fmtD(licence.issueDate)}</Typography></Box>
                <Box><Typography variant="caption" color="text.secondary">{t('facilities.validTill')}</Typography><Typography sx={{ fontSize: 13, fontWeight: 600 }}>{licence.nonExpiring ? t('facilities.nonExpiring') : fmtD(licence.expiryDate)}</Typography></Box>
              </Box>
            </Box>
            <Box sx={{ width: 150, textAlign: 'center', flexShrink: 0 }}>
              {qr && <Box component="img" src={qr} alt={t('facilities.verificationQr')} sx={{ width: 120, height: 120, border: '1px solid #E4EAE9', borderRadius: 1 }} />}
              <Typography sx={{ fontSize: 9.5, color: 'text.secondary', mt: 0.75 }}>{t('facilities.scanToVerify')}</Typography>
              {licence.signature?.verification?.valid && <Typography sx={{ fontSize: 9.5, color: 'success.main', mt: 0.5, fontFamily: MONO }}>{t('facilities.signedKey', { key: licence.signature.keyId })}</Typography>}
            </Box>
          </Box>
          <Divider />
          <Box sx={{ px: 3, py: 1.5, bgcolor: (th) => (th.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : '#F4F7F7'), display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary">{t('facilities.verifyAt')} {url}</Typography>
            <Typography variant="caption" color="text.secondary">{t('facilities.issuedByLine', { issuer: licence.issuer || profile.authority })}</Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit">{t('facilities.close')}</Button>
        <Button variant="contained" startIcon={<PrintRoundedIcon />} onClick={() => window.print()}>{t('facilities.printCertificate')}</Button>
      </DialogActions>
    </Dialog>
  );
}
