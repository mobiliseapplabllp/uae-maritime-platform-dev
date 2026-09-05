/* Route table — one line per screen. Each module keeps its pages under src/pages/<module>; add a route here when a page lands. */
import { lazy, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useUser } from '../store';
import { hasPerm } from '../utils/perms';
import { StatePage } from '../components/common/StatePage';
import { routes as vesselRoutes } from '../pages/vessels/routes';
import { routes as registryRoutes } from '../pages/registry/routes';
import { routes as riskRoutes } from '../pages/risk/routes';
import { routes as portCallRoutes } from '../pages/portcalls/routes';
import { routes as opsRoutes } from '../pages/ops/routes';
import { routes as nmcRoutes } from '../pages/nmc/routes';
import { routes as seafarerRoutes } from '../pages/seafarers/routes';
import { routes as legislationRoutes } from '../pages/legislation/routes';
import { routes as facilitiesRoutes } from '../pages/facilities/routes';
import { routes as invoiceRoutes } from '../pages/invoices/routes';
import { routes as misRoutes } from '../pages/mis/routes';
import { routes as incidentRoutes } from '../pages/incidents/routes';
import { routes as inspectionRoutes } from '../pages/inspections/routes';
import { routes as agentRoutes } from '../pages/agents/routes';
import { routes as platformRoutes } from '../pages/platform/routes';

export interface RouteDef { path: string; perm?: string; element?: ReactNode; redirect?: string }
const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export function Guard({ perm, children }: { perm?: string; children: ReactNode }) {
  const user = useUser();
  const { t } = useTranslation();
  if (!user) return <Navigate to="/login" replace />;
  if (perm && !hasPerm(user, perm)) return <StatePage code="403" title={t('common.noAccess')} message={t('common.noAccessMsg', { role: user.role?.name })} />;
  return <>{children}</>;
}

export const PUBLIC_ROUTES: RouteDef[] = [
  { path: '/login', element: L(() => import('../pages/Login')) },
  { path: '/verify/:licenseNo', element: L(() => import('../pages/public/VerifyLicense')) },
  // the public legislation portal: the law as published, citable without a session
  { path: '/law', element: L(() => import('../pages/public/LawPortal')) },
  { path: '/law/:slug', element: L(() => import('../pages/public/LawInstrument')) },
];

export const ROUTES: RouteDef[] = [
  { path: '/', perm: 'dashboard.view', element: L(() => import('../pages/Dashboard')) },
  { path: '/berth-board', perm: 'portcalls.view', element: L(() => import('../pages/BerthBoard')) },
  { path: '/masters', perm: 'masters.view', element: L(() => import('../pages/masters/MastersHub')) },
  { path: '/masters/m/:category', perm: 'masters.view', element: L(() => import('../pages/masters/MasterPage')) },
  { path: '/masters/berths', perm: 'masters.view', element: L(() => import('../pages/masters/BerthsPage')) },
  { path: '/masters/lookups', perm: 'masters.view', element: L(() => import('../pages/masters/LookupsPage')) },
  { path: '/masters/tariffs', perm: 'tariffs.view', element: L(() => import('../pages/masters/TariffsPage')) },
  { path: '/masters/checklists', redirect: '/checklist-builder' },
  { path: '/admin/users', perm: 'users.view', element: L(() => import('../pages/admin/UsersPage')) },
  { path: '/admin/roles', perm: 'roles.view', element: L(() => import('../pages/admin/RolesPage')) },
  { path: '/admin/audit', perm: 'audit.view', element: L(() => import('../pages/admin/AuditPage')) },
  { path: '/admin/settings', perm: 'settings.view', element: L(() => import('../pages/admin/SettingsPage')) },
  { path: '/settings/module/:moduleKey', element: L(() => import('../pages/ModuleSettingsPage')) },
  { path: '/profile', element: L(() => import('../pages/ProfilePage')) },
  ...vesselRoutes, ...registryRoutes, ...riskRoutes, ...portCallRoutes, ...opsRoutes, ...nmcRoutes,
  ...seafarerRoutes, ...legislationRoutes, ...facilitiesRoutes, ...invoiceRoutes, ...misRoutes,
  ...incidentRoutes, ...inspectionRoutes, ...agentRoutes,
  ...platformRoutes,
];
