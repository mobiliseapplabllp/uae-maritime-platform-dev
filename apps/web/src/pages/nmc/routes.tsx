/* Surveillance routes — the live traffic picture; the old incidents path folds into the Incident Desk. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/nmc/map', perm: 'nmc.view', element: L(() => import('./TrafficMap')) },
  { path: '/nmc/incidents', redirect: '/incidents' },
];
