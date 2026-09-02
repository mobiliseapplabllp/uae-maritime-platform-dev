/* Vessel-call routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/port-calls', perm: 'portcalls.view', element: L(() => import('./PortCallsList')) },
  { path: '/port-calls/:id', perm: 'portcalls.view', element: L(() => import('./PortCallDetail')) },
];
