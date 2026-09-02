/* Ship-registration routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/registry', perm: 'registry.view', element: L(() => import('./RegistrationsList')) },
  { path: '/registry/:id', perm: 'registry.view', element: L(() => import('./RegistrationDetail')) },
];
