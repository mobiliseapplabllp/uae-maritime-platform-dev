/* Port Companies routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/companies', perm: 'facilities.view', element: L(() => import('./CompaniesPage')) },
  { path: '/companies/:id', perm: 'facilities.view', element: L(() => import('./CompanyDetail')) },
  { path: '/accreditations', perm: 'facilities.view', element: L(() => import('./AccreditationDesk')) },
  { path: '/facilities', perm: 'facilities.view', element: L(() => import('./FacilitiesList')) },
  { path: '/facilities/:id', perm: 'facilities.view', element: L(() => import('./FacilityDetail')) },
];
