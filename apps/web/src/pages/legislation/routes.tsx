/* Notices & Circulars routes — the register, and the IMO watch beside it. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/legislation', perm: 'legislation.view', element: L(() => import('./LegislationPage')) },
  { path: '/legislation/imo', perm: 'legislation.view', element: L(() => import('./ImoWatch')) },
];
