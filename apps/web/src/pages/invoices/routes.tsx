/* Revenue & Billing routes — same paths and permissions as the reference product. Tariffs stay under Data Studio. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/invoices', perm: 'invoices.view', element: L(() => import('./InvoicesList')) },
  { path: '/invoices/:id', perm: 'invoices.view', element: L(() => import('./InvoiceDetail')) },
];
