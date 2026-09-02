/* Compliance & risk routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/risk', perm: 'risk.view', element: L(() => import('./RiskRegister')) },
  { path: '/risk/targeting', perm: 'risk.view', element: L(() => import('./TargetingPage')) },
];
