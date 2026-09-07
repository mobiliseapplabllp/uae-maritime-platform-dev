import type { SvgIconComponent } from '@mui/icons-material';
import ApartmentRoundedIcon from '@mui/icons-material/ApartmentRounded';
import ReceiptLongRoundedIcon from '@mui/icons-material/ReceiptLongRounded';
import NotificationsActiveRoundedIcon from '@mui/icons-material/NotificationsActiveRounded';
import MailRoundedIcon from '@mui/icons-material/MailRounded';
import AutoAwesomeRoundedIcon from '@mui/icons-material/AutoAwesomeRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';

/* The settings catalogue as the landing draws it: every platform section and every module's settings as a card, each
 * saying what it governs, which modules read it, and the few values worth showing before the page is opened. The
 * "read by" lists are the truth of the code — a value that no service reads has no card here. */

export interface Fact { label: string; value: string }
type Values = Record<string, any>;
const on = (v: unknown) => (v === false || String(v).toLowerCase() === 'false' ? 'off' : 'on');
const num = (v: unknown, unit = '') => (v === undefined || v === null || v === '' ? '—' : `${v}${unit}`);
const text = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? '—' : String(v));

export interface SectionDef { key: string; label: string; icon: SvgIconComponent; color: string; blurb: string; readBy: string[]; facts: (v: Values) => Fact[] }
export const SECTIONS: SectionDef[] = [
  { key: 'org', label: 'Organisation', icon: ApartmentRoundedIcon, color: '#0A2239',
    blurb: 'Who the platform is: the port, its operator, address, tax registration, currency, timezone and contact details.',
    readBy: ['Revenue & Billing — the issuer block on every invoice', 'Notifications — the sender name on relayed email', 'The public jurisdiction endpoint the web app boots from'],
    facts: (v) => [{ label: 'Port', value: text(v.portName) }, { label: 'UN/LOCODE', value: text(v.unlocode) }, { label: 'Timezone', value: text(v.timezone) }] },
  { key: 'billing', label: 'Billing & tax', icon: ReceiptLongRoundedIcon, color: '#BD3861',
    blurb: 'The tax head, its rate and registration label, the place of supply, the service code and the invoice currency.',
    readBy: ['Revenue & Billing — every new invoice and its tax line', 'Harbour Operations — the pre-arrival cost estimate', 'Service Desk — the fee on every application'],
    facts: (v) => [{ label: 'Tax', value: `${text(v.taxName)} ${num(v.taxRate, '%')}` }, { label: 'Currency', value: text(v.currency) }, { label: 'Place of supply', value: text(v.placeOfSupply) }] },
  { key: 'notifications', label: 'Notifications', icon: NotificationsActiveRoundedIcon, color: '#8A5810',
    blurb: 'Which channels leave the platform, the hour the daily digests go out, and how long an unread critical notice waits before it is escalated.',
    readBy: ['Notifications — email and SMS delivery, the escalation sweep', 'Scheduler — the digest jobs move to the configured hour'],
    facts: (v) => [{ label: 'Channels', value: `email ${on(v.emailEnabled)} · SMS ${on(v.smsEnabled)}` }, { label: 'Digest hour', value: v.digestHour === undefined || v.digestHour === '' ? '—' : `${String(v.digestHour).padStart(2, '0')}:00` }, { label: 'Escalate after', value: num(v.escalationHours, ' h') }] },
  { key: 'smtp', label: 'SMTP', icon: MailRoundedIcon, color: '#06737E',
    blurb: "The platform's own mail relay. With a host set, email goes out through it; without one, through the messaging adapter in Integrations.",
    readBy: ['Notifications — every email, including escalations'],
    facts: (v) => [{ label: 'Relay', value: v.host ? `${v.host}:${v.port || (v.secure === false ? 587 : 465)}` : 'Not set — messaging adapter' }, { label: 'TLS', value: v.host ? on(v.secure) : '—' }, { label: 'From', value: text(v.from) }] },
  { key: 'ai', label: 'AI assistant', icon: AutoAwesomeRoundedIcon, color: '#75479C',
    blurb: 'The switch, the provider and profile that compose, grounded-only mode, the temperature, the daily token budget, the provider key, and the in-country slot with its residency rules.',
    readBy: ['AI assistant — every question and every draft', 'The tool gateway — every hosted completion for the assistant and the agents', 'The assistant dock in the shell'],
    facts: (v) => [{ label: 'Assistant', value: on(v.enabled) }, { label: 'Provider', value: v.provider === 'cli' ? 'command line on the gateway host' : v.provider === 'uae' || v.provider === 'uae-hosted' ? 'in-country endpoint' : v.provider === 'anthropic' || v.provider === 'gateway' ? 'hosted, via tool gateway' : 'platform composer' }, { label: 'Residency', value: String(v.residencyRequired) === 'true' ? 'required' : String(v.preferResident) === 'true' ? 'preferred' : 'not enforced' }, { label: 'Daily budget', value: Number(v.dailyTokenBudget) > 0 ? `${Number(v.dailyTokenBudget).toLocaleString('en-GB')} tokens` : 'unlimited' }] },
];
export const INTEGRATIONS_CARD = {
  key: 'integrations', label: 'Integrations', icon: HubRoundedIcon, color: '#1E7A6F',
  blurb: 'Every counterpart the platform speaks to, as an adapter: where it points, how it authenticates, its recorded contract for stub mode, and what it has done lately.',
  readBy: ['Every service that calls a counterpart — MOHRE, ICP, the AIS feed, the payment gateway, the messaging adapter'],
};

export interface ModuleDef { key: string; blurb: string; readBy: string[]; facts: (v: Values) => Fact[] }
export const MODULE_CARDS: ModuleDef[] = [
  { key: 'ops', blurb: 'Call numbering, tug defaults, berth window slack, anchorage waiting, the schedule span and the surveillance thresholds.',
    readBy: ['Port calls — VCN prefix, tug defaults, berth conflicts', 'Operations board — anchorage alert, schedule window', 'Live Traffic — channel speed, AIS gap, anchor drift, zone entry', 'Traffic analytics — cell size, window'],
    facts: (v) => [{ label: 'VCN prefix', value: text(v.vcnPrefix) }, { label: 'Channel limit', value: num(v.channelSpeedLimitKn, ' kn') }, { label: 'AIS gap', value: num(v.aisGapAlertMin, ' min') }] },
  { key: 'ships', blurb: 'The certificate expiry window, the dry-dock reminder and how long a risk score is held before it is recomputed.',
    readBy: ['Fleet — EXPIRING certificates, dry-dock due list', 'Risk register — score cache', 'Scheduler — the certificate digest'],
    facts: (v) => [{ label: 'Certificates expiring within', value: num(v.certExpiringDays, ' days') }, { label: 'Dry-dock reminder', value: num(v.dryDockReminderDays, ' days') }, { label: 'Risk refresh', value: num(v.riskRefreshMinutes, ' min') }] },
  { key: 'crew', blurb: 'The medical expiry window, the sign-on margin and whether a certificate of competency is verified at sign-on.',
    readBy: ['Seafarers — the document gate and the crew dashboard', 'Crew lists — sign-on checks'],
    facts: (v) => [{ label: 'Medical expiring within', value: num(v.medicalExpiringDays, ' days') }, { label: 'Sign-on margin', value: num(v.signOnMarginDays, ' days') }, { label: 'Verify CoC on sign-on', value: on(v.cocVerifyOnSignOn) }] },
  { key: 'legis', blurb: 'Whether a new notice needs acknowledgment, when the reminder goes, and how long superseded instruments stay in the list.',
    readBy: ['Notices & Circulars — acknowledgments, reminders, the register'],
    facts: (v) => [{ label: 'Ack required by default', value: on(v.ackRequiredDefault) }, { label: 'Reminder after', value: num(v.ackReminderDays, ' days') }, { label: 'Show superseded for', value: num(v.showSupersededDays, ' days') }] },
  { key: 'incidents', blurb: 'The response targets, which severities page the desk, how long a closed case may be reopened, and how soon an injury must be reported.',
    readBy: ['Incident Desk — dashboard targets, paging, reopen window, injury report clock', 'Notifications — the incident rule'],
    facts: (v) => [{ label: 'MTTA / MTTR', value: `${num(v.mttaTargetMin, ' min')} / ${num(v.mttrTargetHrs, ' h')}` }, { label: 'Page the desk from', value: text(v.autoNotifySeverity) }, { label: 'Reopen window', value: num(v.reopenWindowDays, ' days') }] },
  { key: 'inspect', blurb: 'Finding rectification, the detention threshold, the checklist pass mark and the Smart Inspection programme targets.',
    readBy: ['Survey & Audit Cell — findings, closing a survey, checklists, the six KPIs'],
    facts: (v) => [{ label: 'Findings due in', value: num(v.findingDueDays, ' days') }, { label: 'Detention at', value: `${num(v.detentionThreshold)} finding(s)` }, { label: 'Pass score', value: num(v.passScorePct, '%') }] },
  { key: 'facil', blurb: 'How often a company is audited and how far ahead a renewal is flagged.',
    readBy: ['Port Companies — audit due dates and the renewal window', 'Port Facilities'],
    facts: (v) => [{ label: 'Audit interval', value: num(v.auditIntervalMonths, ' months') }, { label: 'Renewal reminder', value: num(v.renewalReminderDays, ' days ahead') }] },
  { key: 'finance', blurb: 'Invoice numbering, payment terms, the overdue reminder cadence and whether totals round to the whole unit.',
    readBy: ['Revenue & Billing — numbering, due dates, rounding, overdue reminders'],
    facts: (v) => [{ label: 'Invoice prefix', value: text(v.invoicePrefix) }, { label: 'Payment terms', value: num(v.paymentTermsDays, ' days') }, { label: 'Round totals', value: on(v.roundTotalsToWholeUnit) }] },
  { key: 'mis', blurb: 'The default period a report opens on and the footer printed under every export.',
    readBy: ['MIS Reports — the period and the export footer'],
    facts: (v) => [{ label: 'Default period', value: num(v.defaultPeriodMonths, ' months') }, { label: 'Export footer', value: text(v.exportFooter) }] },
  { key: 'masters', blurb: 'Whether a master entry may be deleted outright or only retired.',
    readBy: ['Data Studio — the delete policy on every master'],
    facts: (v) => [{ label: 'Hard delete', value: on(v.allowHardDelete) }] },
  { key: 'agents', blurb: 'How long a decision may wait for review, and how long an agent may stay suspended before the desk is reminded.',
    readBy: ['AI Agent Operations — the hourly sweep', 'Notifications — the overdue and suspension rules'],
    facts: (v) => [{ label: 'Chase a review after', value: num(v.escalationHours, ' h') }, { label: 'Suspension notice after', value: num(v.suspensionNoticeHours, ' h') }] },
  { key: 'admin', blurb: 'Token lifetimes, the idle timeout, password length, two-step verification, dormancy, access reviews and audit retention.',
    readBy: ['Users & security — sign-in, sessions, MFA, dormancy, four-eyes, reviews', 'Audit ledger — retention'],
    facts: (v) => [{ label: 'Access token', value: num(v.accessTokenMinutes, ' min') }, { label: 'Idle timeout', value: num(v.idleTimeoutMinutes, ' min') }, { label: 'Dormant after', value: num(v.dormantAfterDays, ' days') }] },
];

/** Where a retired tab of the old settings screen now lives, so a saved link still lands somewhere sensible. */
export const LEGACY_TABS: Record<string, string> = { operations: '/settings/module/ops', riskWeights: '/risk' };
