/* Fleet Manager routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/fleet', perm: 'vessels.view', element: L(() => import('./FleetDashboard')) },
  { path: '/vessels', perm: 'vessels.view', element: L(() => import('./VesselsList')) },
  { path: '/vessels/survey-planner', perm: 'vessels.view', element: L(() => import('./SurveyPlanner')) },
  { path: '/vessels/:id', perm: 'vessels.view', element: L(() => import('./VesselDetail')) },
  { path: '/certificates', perm: 'certificates.view', element: L(() => import('../CertificatesPage')) },
];
