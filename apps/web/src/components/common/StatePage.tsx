import { Box, Typography, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { MONO } from '../../theme';

export function StatePage({ code, title, message }: { code: string; title: string; message: string }) {
  const navigate = useNavigate();
  return (
    <Box sx={{ minHeight: '60vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 4 }}>
      <Typography sx={{ fontFamily: MONO, fontSize: 13, letterSpacing: '0.2em', color: 'text.secondary' }}>{code}</Typography>
      <Typography variant="h5" component="h1">{title}</Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 420, textAlign: 'center' }}>{message}</Typography>
      <Button variant="outlined" sx={{ mt: 1 }} onClick={() => navigate('/')}>Go to dashboard</Button>
    </Box>
  );
}
