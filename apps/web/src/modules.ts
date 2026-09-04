/* Module registry — drives the app launcher and the per-module side navigation. A module is visible when the user holds its perm. */
import type { SvgIconComponent } from '@mui/icons-material';
import DashboardRoundedIcon from '@mui/icons-material/DashboardRounded';
import ViewTimelineRoundedIcon from '@mui/icons-material/ViewTimelineRounded';
import EventRepeatRoundedIcon from '@mui/icons-material/EventRepeatRounded';
import GridViewRoundedIcon from '@mui/icons-material/GridViewRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import SmartToyRoundedIcon from '@mui/icons-material/SmartToyRounded';
import AssessmentRoundedIcon from '@mui/icons-material/AssessmentRounded';
import PendingActionsRoundedIcon from '@mui/icons-material/PendingActionsRounded';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded';
import ChecklistRoundedIcon from '@mui/icons-material/ChecklistRounded';
import GroupRoundedIcon from '@mui/icons-material/GroupRounded';
import HistoryRoundedIcon from '@mui/icons-material/HistoryRounded';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import PriceChangeRoundedIcon from '@mui/icons-material/PriceChangeRounded';
import CrisisAlertRoundedIcon from '@mui/icons-material/CrisisAlertRounded';
import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded';
import TrackChangesRoundedIcon from '@mui/icons-material/TrackChangesRounded';
import SpaceDashboardRoundedIcon from '@mui/icons-material/SpaceDashboardRounded';
import EventNoteRoundedIcon from '@mui/icons-material/EventNoteRounded';
import DirectionsBoatRoundedIcon from '@mui/icons-material/DirectionsBoatRounded';
import HealthAndSafetyRoundedIcon from '@mui/icons-material/HealthAndSafetyRounded';
import MonitorHeartRoundedIcon from '@mui/icons-material/MonitorHeartRounded';
import SettingsSuggestRoundedIcon from '@mui/icons-material/SettingsSuggestRounded';
import LibraryBooksRoundedIcon from '@mui/icons-material/LibraryBooksRounded';
import CampaignRoundedIcon from '@mui/icons-material/CampaignRounded';
import AppRegistrationRoundedIcon from '@mui/icons-material/AppRegistrationRounded';
import DesignServicesRoundedIcon from '@mui/icons-material/DesignServicesRounded';
import StorefrontRoundedIcon from '@mui/icons-material/StorefrontRounded';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import SpeedRoundedIcon from '@mui/icons-material/SpeedRounded';
import RuleRoundedIcon from '@mui/icons-material/RuleRounded';

export interface NavItem { to: string; label: string; icon: SvgIconComponent; perm: string; end?: boolean }
export interface NavGroup { header: string; items: NavItem[] }
export interface ModuleDef { key: string; name: string; short: string; color: string; desc: string; icon: SvgIconComponent; perm: string; home: string; nav: NavGroup[] }

export const MODULES: ModuleDef[] = [
  { key: 'home', name: 'Command Centre', short: 'Home', color: '#0B74B0', desc: 'Port-wide KPIs, throughput, berth occupancy and live activity', icon: DashboardRoundedIcon, perm: 'dashboard.view', home: '/',
    nav: [{ header: 'Overview', items: [{ to: '/', label: 'Command Centre', icon: DashboardRoundedIcon, perm: 'dashboard.view', end: true }] }] },
  { key: 'ops', name: 'Harbour Operations', short: 'Harbour', color: '#06737E', desc: 'Vessel calls, quay view, day schedule, berthing and marine craft', icon: ViewTimelineRoundedIcon, perm: 'portcalls.view', home: '/port-calls',
    nav: [{ header: 'Marine operations', items: [
      { to: '/port-calls', label: 'Vessel Calls', icon: ViewTimelineRoundedIcon, perm: 'portcalls.view' },
      { to: '/berth-board', label: 'Berth Board', icon: AnchorRoundedIcon, perm: 'portcalls.view' },
      { to: '/berth-planner', label: 'Berth Window Planner', icon: EventRepeatRoundedIcon, perm: 'portcalls.view' },
      { to: '/quay-view', label: 'Quay View (2D)', icon: SpaceDashboardRoundedIcon, perm: 'portcalls.view' },
      { to: '/schedule', label: 'Vessel Schedule', icon: EventNoteRoundedIcon, perm: 'portcalls.view' },
      { to: '/marine-services', label: 'Marine Craft & Pilots', icon: DirectionsBoatRoundedIcon, perm: 'portcalls.view' },
      { to: '/nmc/map', label: 'Live Traffic', icon: RadarRoundedIcon, perm: 'nmc.view' },
    ] }] },
  { key: 'ships', name: 'Fleet Manager', short: 'Fleet', color: '#3B6FB6', desc: 'Vessel particulars, certificates, voyages and risk profiling', icon: DirectionsBoatFilledRoundedIcon, perm: 'vessels.view', home: '/fleet',
    nav: [{ header: 'Fleet', items: [
      { to: '/fleet', label: 'Fleet Dashboard', icon: SpaceDashboardRoundedIcon, perm: 'vessels.view', end: true },
      { to: '/vessels', label: 'Vessel Register', icon: DirectionsBoatFilledRoundedIcon, perm: 'vessels.view' },
      { to: '/registry', label: 'Ship Registration', icon: AppRegistrationRoundedIcon, perm: 'registry.view' },
      { to: '/certificates', label: 'Certificates', icon: WorkspacePremiumRoundedIcon, perm: 'certificates.view' },
      { to: '/vessels/survey-planner', label: 'Survey & Dry-Dock Planner', icon: EventRepeatRoundedIcon, perm: 'vessels.view' },
      { to: '/risk', label: 'Vessel Risk Register', icon: InsightsRoundedIcon, perm: 'risk.view', end: true },
    ] }] },
  { key: 'crew', name: 'Crew & Manning', short: 'Crew', color: '#75479C', desc: 'Crew records — competency, medicals and sea service', icon: GroupsRoundedIcon, perm: 'seafarers.view', home: '/seafarers',
    nav: [{ header: 'Crew', items: [
      { to: '/seafarers/overview', label: 'Crew Dashboard', icon: SpaceDashboardRoundedIcon, perm: 'seafarers.view' },
      { to: '/seafarers', label: 'Crew Register', icon: BadgeRoundedIcon, perm: 'seafarers.view', end: true },
    ] }] },
  { key: 'legis', name: 'Notices & Circulars', short: 'Notices', color: '#8A5A2B', desc: 'Acts, rules, notices and circulars — with acknowledgments', icon: CampaignRoundedIcon, perm: 'legislation.view', home: '/legislation',
    nav: [{ header: 'Instruments', items: [{ to: '/legislation', label: 'Notice Library', icon: GavelRoundedIcon, perm: 'legislation.view' }] }] },
  { key: 'incidents', name: 'Incident Desk', short: 'Incidents', color: '#B3452E', desc: 'HSE & marine incident case files — response, RCA and closure', icon: CrisisAlertRoundedIcon, perm: 'incidents.view', home: '/incidents',
    nav: [{ header: 'Case management', items: [
      { to: '/incidents/overview', label: 'Incident Dashboard', icon: MonitorHeartRoundedIcon, perm: 'incidents.view' },
      { to: '/incidents/risk-matrix', label: 'Risk Matrix', icon: GridViewRoundedIcon, perm: 'incidents.view' },
      { to: '/incidents', label: 'Incident Register', icon: CrisisAlertRoundedIcon, perm: 'incidents.view', end: true },
    ] }] },
  { key: 'inspect', name: 'Survey & Audit Cell', short: 'Surveys', color: '#8A5810', desc: 'PSC, FSI, ISM, ISPS and MLC surveys with findings and targeting', icon: FactCheckRoundedIcon, perm: 'inspections.view', home: '/inspections',
    nav: [{ header: 'Surveys', items: [
      { to: '/inspections/overview', label: 'Audit Dashboard', icon: SpaceDashboardRoundedIcon, perm: 'inspections.view' },
      { to: '/inspections', label: 'Survey Register', icon: FactCheckRoundedIcon, perm: 'inspections.view', end: true },
      { to: '/checklist-builder', label: 'Checklist Builder', icon: ChecklistRoundedIcon, perm: 'inspections.view' },
      { to: '/risk/targeting', label: 'Boarding Targets', icon: TrackChangesRoundedIcon, perm: 'risk.view' },
    ] }] },
  { key: 'facil', name: 'Port Companies', short: 'Companies', color: '#2C6E52', desc: 'The company directory and licensing of everyone working in the port', icon: CorporateFareRoundedIcon, perm: 'facilities.view', home: '/companies',
    nav: [{ header: 'Companies', items: [
      { to: '/companies', label: 'Company Directory', icon: CorporateFareRoundedIcon, perm: 'facilities.view' },
      { to: '/facilities', label: 'Licence Register', icon: WorkspacePremiumRoundedIcon, perm: 'facilities.view' },
    ] }] },
  { key: 'services', name: 'Service Desk', short: 'Services', color: '#0E7C86', desc: 'The catalogue of maritime services, applications and the Service Studio', icon: StorefrontRoundedIcon, perm: 'services.view', home: '/services',
    nav: [{ header: 'Services', items: [
      { to: '/services', label: 'Service Catalogue', icon: StorefrontRoundedIcon, perm: 'services.view', end: true },
      { to: '/services/requests', label: 'Applications', icon: AccountTreeRoundedIcon, perm: 'services.view' },
      { to: '/services/studio', label: 'Service Studio', icon: DesignServicesRoundedIcon, perm: 'services.manage' },
    ] }] },
  { key: 'finance', name: 'Revenue & Billing', short: 'Revenue', color: '#BD3861', desc: 'Invoicing, tariffs and collections', icon: ReceiptLongRoundedIcon, perm: 'invoices.view', home: '/invoices',
    nav: [{ header: 'Billing', items: [
      { to: '/invoices', label: 'Invoices', icon: ReceiptLongRoundedIcon, perm: 'invoices.view' },
      { to: '/masters/tariffs', label: 'Tariffs', icon: PriceChangeRoundedIcon, perm: 'tariffs.view' },
    ] }] },
  { key: 'mis', name: 'MIS Reports', short: 'MIS', color: '#0B5D8A', desc: 'Management reports — cargo, traffic, revenue, compliance', icon: AssessmentRoundedIcon, perm: 'reports.view', home: '/mis',
    nav: [{ header: 'Reporting', items: [
      { to: '/reports', label: 'Report Library', icon: LibraryBooksRoundedIcon, perm: 'reports.view', end: true },
      { to: '/mis', label: 'MIS Report', icon: AssessmentRoundedIcon, perm: 'reports.view' },
    ] }] },
  { key: 'masters', name: 'Data Studio', short: 'Masters', color: '#5A6B78', desc: 'Berth master, lookups and checklist templates', icon: HubRoundedIcon, perm: 'masters.view', home: '/masters',
    nav: [{ header: 'Reference data', items: [
      { to: '/masters', label: 'All Masters', icon: HubRoundedIcon, perm: 'masters.view', end: true },
      { to: '/masters/berths', label: 'Berths & Terminals', icon: AnchorRoundedIcon, perm: 'masters.view' },
      { to: '/masters/lookups', label: 'Raw Lookups', icon: ListAltRoundedIcon, perm: 'masters.view' },
    ] }] },
  { key: 'agents', name: 'AI Agent Operations', short: 'AI Agents', color: '#75479C', desc: 'Agent registry, autonomy, the decision register, the escalation queue and assurance', icon: SmartToyRoundedIcon, perm: 'agents.view', home: '/agents',
    nav: [{ header: 'AI Agents', items: [
      { to: '/agents', label: 'Agent Operations', icon: SmartToyRoundedIcon, perm: 'agents.view' },
      { to: '/agents/decisions', label: 'Decision Register', icon: FactCheckRoundedIcon, perm: 'agents.view' },
      { to: '/agents/escalations', label: 'Escalation Queue', icon: PendingActionsRoundedIcon, perm: 'agents.view' },
      { to: '/agents/assurance', label: 'Assurance', icon: VerifiedUserRoundedIcon, perm: 'agents.view' },
    ] }] },
  { key: 'platform', name: 'Platform Operations', short: 'Platform', color: '#1E7A6F', desc: 'Service health, infrastructure, event backlog, service levels and outage history', icon: MonitorHeartRoundedIcon, perm: 'platform.view', home: '/platform',
    nav: [{ header: 'Platform', items: [
      { to: '/platform', label: 'Service Health', icon: MonitorHeartRoundedIcon, perm: 'platform.view', end: true },
      { to: '/platform/slas', label: 'Service Levels', icon: SpeedRoundedIcon, perm: 'platform.view' },
      { to: '/platform/incidents', label: 'Outage History', icon: HistoryRoundedIcon, perm: 'platform.view' },
      { to: '/platform/compliance', label: 'RFP Compliance', icon: RuleRoundedIcon, perm: 'platform.view' },
    ] }] },
  { key: 'admin', name: 'Administration', short: 'Admin', color: '#0A2239', desc: 'Users, roles, audit log and settings', icon: AdminPanelSettingsRoundedIcon, perm: 'users.view', home: '/admin/users',
    nav: [{ header: 'Administration', items: [
      { to: '/admin/users', label: 'Users', icon: GroupRoundedIcon, perm: 'users.view' },
      { to: '/admin/roles', label: 'Roles & Permissions', icon: AdminPanelSettingsRoundedIcon, perm: 'roles.view' },
      { to: '/admin/audit', label: 'Audit Log', icon: HistoryRoundedIcon, perm: 'audit.view' },
      { to: '/admin/settings', label: 'Settings', icon: SettingsRoundedIcon, perm: 'settings.view' },
    ] }] },
];

export { HealthAndSafetyRoundedIcon };

// every module carries its own settings page, looped back into behaviour
for (const m of MODULES) {
  if (m.key === 'home') continue;
  m.nav.push({ header: 'Configuration', items: [{ to: `/settings/module/${m.key}`, label: 'Module Settings', icon: SettingsSuggestRoundedIcon, perm: m.perm }] });
}

const FALLBACK: [string, string][] = [['/vessels', 'ships'], ['/seafarers', 'crew'], ['/facilities', 'facil'], ['/nmc', 'ops'], ['/incidents', 'incidents'], ['/inspections', 'inspect'], ['/invoices', 'finance'], ['/port-calls', 'ops'], ['/services', 'services']];
export const moduleOf = (pathname: string): ModuleDef => {
  if (pathname === '/') return MODULES[0];
  let best: { m: ModuleDef; len: number } | null = null;
  for (const m of MODULES) for (const g of m.nav) for (const item of g.items) {
    if (item.to !== '/' && pathname.startsWith(item.to) && (!best || item.to.length > best.len)) best = { m, len: item.to.length };
  }
  if (!best) { const hit = FALLBACK.find(([p]) => pathname.startsWith(p)); if (hit) return MODULES.find((m) => m.key === hit[1]) || MODULES[0]; }
  return best ? best.m : MODULES[0];
};
export const moduleByKey = (key: string) => MODULES.find((m) => m.key === key);
