/* Survey & Audit Cell routes — same paths and permissions as the reference product. The risk register and boarding targets live under src/pages/risk. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/inspections/overview', perm: 'inspections.view', element: L(() => import('./AuditDashboard')) },
  { path: '/inspections', perm: 'inspections.view', element: L(() => import('./InspectionsList')) },
  { path: '/checklist-builder', perm: 'inspections.view', element: L(() => import('./ChecklistBuilder')) },
  { path: '/inspections/:id', perm: 'inspections.view', element: L(() => import('./InspectionDetail')) },
];
