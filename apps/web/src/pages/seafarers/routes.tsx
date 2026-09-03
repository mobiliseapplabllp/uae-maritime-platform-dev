/* Crew & Manning routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/seafarers/overview', perm: 'seafarers.view', element: L(() => import('./CrewDashboard')) },
  { path: '/seafarers', perm: 'seafarers.view', element: L(() => import('./SeafarersList')) },
  { path: '/seafarers/:id', perm: 'seafarers.view', element: L(() => import('./SeafarerDetail')) },
];
