/* MIS routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/reports', perm: 'reports.view', element: L(() => import('./ReportLibrary')) },
  { path: '/reports/view/:key', perm: 'reports.view', element: L(() => import('./ReportViewer')) },
  { path: '/mis', perm: 'reports.view', element: L(() => import('./MisReport')) },
];
