/** Single source of truth for permissions — consumed by guards, seeds, tests and the roles matrix editor. */
export interface PermissionGroup { module: string; label: string; actions: string[] }

export const PERMISSION_GROUPS: PermissionGroup[] = [
  { module: 'dashboard',    label: 'Dashboard',              actions: ['view'] },
  { module: 'vessels',      label: 'Vessel Registry',        actions: ['view', 'create', 'edit', 'delete'] },
  { module: 'certificates', label: 'Certificates',           actions: ['view', 'manage'] },
  { module: 'portcalls',    label: 'Port Calls',             actions: ['view', 'create', 'edit', 'delete', 'transition'] },
  { module: 'cargo',        label: 'Cargo Operations',       actions: ['manage'] },
  { module: 'inspections',  label: 'Inspections',            actions: ['view', 'create', 'edit', 'close', 'delete'] },
  { module: 'invoices',     label: 'Invoices',               actions: ['view', 'create', 'issue', 'pay', 'delete'] },
  { module: 'tariffs',      label: 'Tariff Master',          actions: ['view', 'manage'] },
  { module: 'masters',      label: 'Masters',                actions: ['view', 'manage'] },
  { module: 'users',        label: 'Users',                  actions: ['view', 'manage'] },
  { module: 'roles',        label: 'Roles & Permissions',    actions: ['view', 'manage'] },
  { module: 'audit',        label: 'Audit Log',              actions: ['view'] },
  { module: 'settings',     label: 'Settings',               actions: ['view', 'manage'] },
  { module: 'seafarers',    label: 'Seafarers',              actions: ['view', 'create', 'edit', 'delete'] },
  { module: 'legislation',  label: 'Notices & Circulars',    actions: ['view', 'manage', 'approve'] },
  { module: 'facilities',   label: 'Port Companies',         actions: ['view', 'manage', 'approve'] },
  { module: 'nmc',          label: 'Maritime Surveillance',  actions: ['view', 'manage'] },
  { module: 'incidents',    label: 'Incident Management',    actions: ['view', 'create', 'manage', 'close'] },
  { module: 'risk',         label: 'Risk Intelligence',      actions: ['view', 'manage'] },
  { module: 'ai',           label: 'AI Assistant',           actions: ['use'] },
  { module: 'reports',      label: 'MIS Reports',            actions: ['view'] },
  { module: 'services',     label: 'Service Requests',       actions: ['view', 'apply', 'assess', 'approve', 'manage'] },
  { module: 'agents',       label: 'AI Agents & Autonomy',   actions: ['view', 'configure', 'review'] },
  { module: 'registry',     label: 'Ship Registration',      actions: ['view', 'apply', 'assess', 'grant'] },
];

/** Groups added by the rebuild (stewardship and the Service Studio). Kept apart so the reference count of 66 stays auditable. */
export const EXTENDED_PERMISSION_GROUPS: PermissionGroup[] = [
  { module: 'mdm',    label: 'Master Data Stewardship', actions: ['review', 'approve'] },
  { module: 'studio', label: 'Service Studio',          actions: ['view', 'design', 'review', 'promote'] },
  { module: 'platform', label: 'Platform Operations',   actions: ['view'] },
  /* The model platform is split three ways because the three are genuinely different authorities: reading
   * what is deployed, changing the registry, and putting a version in front of the public. */
  { module: 'models',   label: 'AI Model Platform',     actions: ['view', 'manage', 'deploy'] },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) => g.actions.map((a) => `${g.module}.${a}`));
export const ALL_EXTENDED_PERMISSIONS: string[] = [
  ...ALL_PERMISSIONS,
  ...EXTENDED_PERMISSION_GROUPS.flatMap((g) => g.actions.map((a) => `${g.module}.${a}`)),
];

export const WILDCARD = '*';

/** Deny by default: a principal holds a permission only if it is listed, or if it holds the wildcard. */
export function hasPerm(perms: readonly string[] | null | undefined, perm: string): boolean {
  if (!Array.isArray(perms)) return false;
  return perms.includes(WILDCARD) || perms.includes(perm);
}

export function isKnownPermission(perm: string): boolean {
  return perm === WILDCARD || ALL_EXTENDED_PERMISSIONS.includes(perm);
}
