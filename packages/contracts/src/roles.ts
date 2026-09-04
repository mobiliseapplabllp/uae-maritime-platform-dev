/** The sixteen roles delivered with the platform. Ten are system roles guaranteed by the seeder. */
export interface RoleDefinition { code: string; name: string; description: string; system: boolean; permissions: string[] }

const P = (...ps: string[]) => ps;

export const ROLE_CATALOGUE: RoleDefinition[] = [
  { code: 'SA', name: 'Super Admin', description: 'Full access to every module', system: true, permissions: ['*'] },
  { code: 'HM', name: 'Harbour Master', description: 'Marine operations — port calls, berthing, cargo', system: true,
    permissions: P('dashboard.view','vessels.view','vessels.create','vessels.edit','certificates.view',
      'portcalls.view','portcalls.create','portcalls.edit','portcalls.delete','portcalls.transition',
      'cargo.manage','inspections.view','invoices.view','tariffs.view','masters.view',
      'nmc.view','risk.view','seafarers.view','legislation.view','facilities.view','ai.use','reports.view',
      'registry.view','services.view','incidents.view','incidents.create','incidents.manage') },
  { code: 'MS', name: 'Marine Surveyor', description: 'Inspections, certificates and vessel compliance', system: true,
    permissions: P('dashboard.view','vessels.view','certificates.view','certificates.manage',
      'portcalls.view','inspections.view','inspections.create','inspections.edit','inspections.close','masters.view',
      'seafarers.view','seafarers.create','seafarers.edit','risk.view','legislation.view','facilities.view','ai.use','reports.view',
      'registry.view','registry.assess','services.view','services.assess',
      'incidents.view','incidents.create','incidents.manage','incidents.close') },
  { code: 'FO', name: 'Finance Officer', description: 'Tariffs, invoicing and collections', system: true,
    permissions: P('dashboard.view','portcalls.view','vessels.view','invoices.view','invoices.create',
      'invoices.issue','invoices.pay','invoices.delete','tariffs.view','tariffs.manage','masters.view',
      'legislation.view','facilities.view','ai.use','reports.view','incidents.view') },
  { code: 'AG', name: 'Shipping Agent', description: 'External agent — announce calls, track invoices', system: true,
    // facilities.view opens the company directory and the licence register. For an agent that is their own
    // entry and their own licences: the tenancy predicate on those registers is ownership, so the permission
    // grants a view of themselves, not of the industry.
    permissions: P('dashboard.view','vessels.view','portcalls.view','portcalls.create','invoices.view','legislation.view','ai.use',
      'registry.view','registry.apply','services.view','services.apply','facilities.view') },
  { code: 'MA', name: 'Manning Agent', description: 'Licensed recruitment and placement service — its own seafarers', system: true,
    // A manning agency is licensed under MLC 2006 Regulation 1.4 and answers to the administration for the
    // seafarers it places. It reads and maintains its own placements — the register partitions on the agent
    // named on each seafarer — and nothing of any other agency's crew.
    permissions: P('dashboard.view','seafarers.view','seafarers.edit','certificates.view','vessels.view',
      'legislation.view','facilities.view','services.view','services.apply','ai.use') },
  { code: 'ND', name: 'NMC Duty Officer', description: 'Surveillance centre — traffic picture, incidents, SAR', system: true,
    permissions: P('dashboard.view','nmc.view','nmc.manage','risk.view','vessels.view','portcalls.view','inspections.view','legislation.view','ai.use','reports.view',
      'incidents.view','incidents.create','incidents.manage','incidents.close') },
  { code: 'TS', name: 'Terminal Supervisor', description: 'Terminal shift operations — cargo work and berth activity', system: false,
    permissions: P('dashboard.view','portcalls.view','cargo.manage','vessels.view','incidents.view','incidents.create','masters.view','ai.use') },
  { code: 'HO', name: 'HSE Officer', description: 'Health, safety & environment — incident response and closure', system: false,
    permissions: P('dashboard.view','incidents.view','incidents.create','incidents.manage','incidents.close','inspections.view','legislation.view','reports.view','ai.use') },
  { code: 'BC', name: 'Billing Clerk', description: 'Invoice preparation and collections follow-up', system: false,
    permissions: P('dashboard.view','invoices.view','invoices.create','tariffs.view','portcalls.view','vessels.view','ai.use') },
  { code: 'SO', name: 'Security Officer', description: 'ISPS and gate security — watchkeeping and incident reporting', system: false,
    permissions: P('dashboard.view','nmc.view','incidents.view','incidents.create','legislation.view','ai.use') },
  { code: 'PP', name: 'Port Pilot', description: 'Pilotage — vessel movements and schedules', system: false,
    permissions: P('dashboard.view','portcalls.view','vessels.view','legislation.view','ai.use') },
  { code: 'LO', name: 'Legal Officer', description: 'Drafts and versions legislative instruments, circulars and notices', system: true,
    permissions: P('dashboard.view','legislation.view','legislation.manage',
      'vessels.view','seafarers.view','facilities.view','services.view','masters.view',
      'reports.view','audit.view','ai.use') },
  { code: 'AP', name: 'Approver', description: 'Puts drafted instruments in force — cannot approve what they drafted', system: true,
    permissions: P('dashboard.view','legislation.view','legislation.approve',
      'vessels.view','seafarers.view','facilities.view','services.view',
      'reports.view','audit.view','ai.use') },
  { code: 'RS', name: 'Registrar of Ships', description: 'Ship registration, statutory certificates and the service desk', system: true,
    permissions: P('dashboard.view','registry.view','registry.apply','registry.assess','registry.grant',
      'vessels.view','vessels.create','vessels.edit','certificates.view','certificates.manage',
      'services.view','services.assess','services.approve','services.manage',
      'facilities.view','facilities.manage','facilities.approve','seafarers.view',
      'masters.view','legislation.view','reports.view','audit.view','ai.use') },
  { code: 'MV', name: 'Management Viewer', description: 'Read-only management view across modules', system: false,
    permissions: P('dashboard.view','portcalls.view','vessels.view','incidents.view','inspections.view','invoices.view','legislation.view','facilities.view','reports.view','nmc.view','risk.view','seafarers.view','ai.use',
      'registry.view','services.view','agents.view','models.view') },
];

export const roleByName = (name: string): RoleDefinition | undefined => ROLE_CATALOGUE.find((r) => r.name === name);
