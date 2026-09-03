/* Incident Desk routes — same paths and permissions as the reference product; /nmc/incidents redirects here. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/incidents/overview', perm: 'incidents.view', element: L(() => import('./IncidentDashboard')) },
  { path: '/incidents/risk-matrix', perm: 'incidents.view', element: L(() => import('./RiskMatrix')) },
  { path: '/incidents', perm: 'incidents.view', element: L(() => import('./IncidentsRegister')) },
  { path: '/incidents/:id', perm: 'incidents.view', element: L(() => import('./IncidentCase')) },
];
