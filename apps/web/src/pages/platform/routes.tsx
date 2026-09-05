/* Platform operations routes — gated on platform.view, which no seeded role but Super Admin holds. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/platform', perm: 'platform.view', element: L(() => import('./PlatformStatus')) },
  { path: '/platform/slas', perm: 'platform.view', element: L(() => import('./PlatformSlas')) },
  { path: '/platform/incidents', perm: 'platform.view', element: L(() => import('./PlatformIncidents')) },
  { path: '/platform/compliance', perm: 'platform.view', element: L(() => import('./PlatformCompliance')) },
  { path: '/platform/integrations', perm: 'platform.view', element: L(() => import('./PlatformIntegrations')) },
];
