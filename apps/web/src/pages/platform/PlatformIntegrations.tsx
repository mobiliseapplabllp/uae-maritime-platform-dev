import { useTranslation } from 'react-i18next';
import { Box, Card } from '@mui/material';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import PageHeader from '../../components/common/PageHeader';
import IntegrationsPanel from '../admin/IntegrationsPanel';

/* Platform → Integrations: the same adapter console Settings carries, reached from the operations module by a
 * person who holds platform.view. Configuration stays behind settings.manage; here the console reads. */
export default function PlatformIntegrationsPage() {
  const { t } = useTranslation();
  return (
    <Box>
      <PageHeader icon={HubRoundedIcon} title={t('platform.integrations.title')} sub={t('platform.integrations.subtitle')} />
      <Card sx={{ p: 2 }}>
        <IntegrationsPanel />
      </Card>
    </Box>
  );
}
