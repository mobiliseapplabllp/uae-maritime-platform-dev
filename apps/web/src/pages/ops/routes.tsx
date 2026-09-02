/* Harbour-operations routes — same paths and permissions as the reference product. The berth board lives in the core route table. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/berth-planner', perm: 'portcalls.view', element: L(() => import('./BerthPlanner')) },
  { path: '/quay-view', perm: 'portcalls.view', element: L(() => import('./PortTwin')) },
  { path: '/schedule', perm: 'portcalls.view', element: L(() => import('./VesselSchedule')) },
  { path: '/marine-services', perm: 'portcalls.view', element: L(() => import('./MarineServices')) },
];
