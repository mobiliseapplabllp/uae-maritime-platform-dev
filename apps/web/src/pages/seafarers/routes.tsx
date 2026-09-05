/* Crew & Manning routes — same paths and permissions as the reference product. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/seafarers/overview', perm: 'seafarers.view', element: L(() => import('./CrewDashboard')) },
  { path: '/seafarers', perm: 'seafarers.view', element: L(() => import('./SeafarersList')) },
  // phase 3: the MET register, the FAL-5 crew lists, safe manning and the foreign ledger — static paths, so they never read as a seafarer id
  { path: '/seafarers/met', perm: 'seafarers.view', element: L(() => import('./MetRegister')) },
  { path: '/seafarers/met/:id', perm: 'seafarers.view', element: L(() => import('./MetInstitutionDetail')) },
  { path: '/seafarers/crew-lists', perm: 'seafarers.view', element: L(() => import('./CrewLists')) },
  { path: '/seafarers/crew-lists/:id', perm: 'seafarers.view', element: L(() => import('./CrewListDetail')) },
  { path: '/seafarers/manning', perm: 'seafarers.view', element: L(() => import('./ManningScales')) },
  { path: '/seafarers/foreign', perm: 'seafarers.view', element: L(() => import('./ForeignLedger')) },
  { path: '/seafarers/:id', perm: 'seafarers.view', element: L(() => import('./SeafarerDetail')) },
];
