import type { AdapterDefinition } from './types';

/* The eight external systems RFP §5.4 names, each behind one adapter. Every operation here has a
 * recorded fixture under stubs/<adapter>/<operation>.json, and that fixture is the contract: the
 * contract test asserts the adapter's shape against it, so "certified" means something checkable
 * rather than something claimed.
 *
 * Live connection dates are the client's to grant. Every adapter therefore ships in stub mode and
 * is switched per adapter, which is what plan v2 means by "live connection dates gate content, not
 * the build". */

export const ADAPTERS: AdapterDefinition[] = [
  {
    key: 'uae-pass', name: 'UAE PASS', nameAr: 'الهوية الرقمية', counterpart: 'UAE PASS (federated through Keycloak)',
    reference: 'RFP §5.4 R-X-02 · TAD 12.8', baseUrlEnv: 'UAE_PASS_URL', defaultBaseUrl: 'https://stub.local/uaepass', protocol: 'rest',
    operations: [
      { key: 'verifyIdentity', summary: 'Verify an Emirates ID and return the citizen profile', method: 'GET', path: '/v1/identity/{emiratesId}', required: ['emiratesId'], idempotent: false },
      { key: 'linkAccount', summary: 'Link a UAE PASS subject to a platform principal', method: 'POST', path: '/v1/link', required: ['subject', 'principalId'], idempotent: true },
    ],
  },
  {
    key: 'ais-lrit', name: 'AIS / LRIT feed', nameAr: 'تغذية AIS/LRIT', counterpart: 'Terrestrial and satellite AIS, LRIT data centre',
    reference: 'RFP §5.3 D4 R-D4-01', baseUrlEnv: 'AIS_LRIT_URL', defaultBaseUrl: 'https://stub.local/ais', protocol: 'rest',
    operations: [
      { key: 'positions', summary: 'Positions since a watermark, for the track store', method: 'GET', path: '/v1/positions', required: ['since'], idempotent: false },
      { key: 'vesselTrack', summary: 'Movement history for one vessel over a window', method: 'GET', path: '/v1/vessels/{imo}/track', required: ['imo', 'from', 'to'], idempotent: false },
    ],
  },
  {
    key: 'icp', name: 'ICP exchange', nameAr: 'تبادل الهيئة الاتحادية للهوية', counterpart: 'Federal Authority for Identity, Citizenship, Customs and Port Security',
    reference: 'RFP §5.3 D6 R-D6-01/03', baseUrlEnv: 'ICP_URL', defaultBaseUrl: 'https://stub.local/icp', protocol: 'soap',
    operations: [
      { key: 'requestReview', summary: 'Submit a port facility for ICP security review', method: 'POST', path: '/ws/PortFacilityReview', required: ['facilityId', 'reason'], idempotent: true },
      { key: 'reviewStatus', summary: 'Poll the outcome of a submitted review', method: 'GET', path: '/ws/PortFacilityReview/{reference}', required: ['reference'], idempotent: false },
    ],
  },
  {
    key: 'mohre', name: 'MOHRE', nameAr: 'وزارة الموارد البشرية والتوطين', counterpart: 'Ministry of Human Resources and Emiratisation',
    reference: 'RFP §5.3 D2 · TAD 5.11', baseUrlEnv: 'MOHRE_URL', defaultBaseUrl: 'https://stub.local/mohre', protocol: 'rest',
    operations: [
      { key: 'verifyEmployment', summary: 'Confirm a seafarer’s employment and sponsor', method: 'GET', path: '/v1/employment/{emiratesId}', required: ['emiratesId'], idempotent: false },
      { key: 'verifyAgency', summary: 'Confirm a manning agency licence is current', method: 'GET', path: '/v1/establishment/{licenceNo}', required: ['licenceNo'], idempotent: false },
    ],
  },
  {
    key: 'gisis', name: 'GISIS / IMO', nameAr: 'المنظمة البحرية الدولية', counterpart: 'IMO Global Integrated Shipping Information System',
    reference: 'RFP §5.3 D4 R-D4-06 · D3 R-D3-07', baseUrlEnv: 'GISIS_URL', defaultBaseUrl: 'https://stub.local/gisis', protocol: 'rest',
    operations: [
      { key: 'submitRegistry', summary: 'Flag-state registry return', method: 'POST', path: '/v1/returns/registry', required: ['period', 'records'], idempotent: true },
      { key: 'submitCasualty', summary: 'Casualty and incident return', method: 'POST', path: '/v1/returns/casualty', required: ['period', 'records'], idempotent: true },
      { key: 'instruments', summary: 'IMO instrument adoptions and amendments since a date', method: 'GET', path: '/v1/instruments', required: ['since'], idempotent: false },
      // the legislation desk's IMO watch: one monitored source (a committee's circular series, the Assembly's resolutions, GISIS notices) read since a date
      { key: 'sourceItems', summary: 'Documents published by one monitored IMO body or series since a date', method: 'GET', path: '/v1/sources/{body}/documents', required: ['body', 'series', 'since'], idempotent: false },
    ],
  },
  {
    key: 'payment', name: 'Payment gateway', nameAr: 'بوابة الدفع', counterpart: 'Government payment gateway',
    reference: 'RFP §5.3 revenue · TAD 11.11', baseUrlEnv: 'PAYMENT_URL', defaultBaseUrl: 'https://stub.local/pay', protocol: 'rest',
    operations: [
      { key: 'createIntent', summary: 'Open a payment intent for an invoice', method: 'POST', path: '/v1/intents', required: ['invoiceNo', 'amountMinor', 'currency'], idempotent: true },
      { key: 'settlement', summary: 'Settlement record for a completed payment', method: 'GET', path: '/v1/intents/{reference}', required: ['reference'], idempotent: false },
      { key: 'refund', summary: 'Refund against a settled payment', method: 'POST', path: '/v1/refunds', required: ['reference', 'amountMinor'], idempotent: true },
    ],
  },
  {
    key: 'classification', name: 'Classification societies', nameAr: 'هيئات التصنيف', counterpart: 'Emirates-recognised classification entities',
    reference: 'RFP §5.4 R-X-02 · TAD 4.11', baseUrlEnv: 'CLASS_URL', defaultBaseUrl: 'https://stub.local/class', protocol: 'rest',
    operations: [
      { key: 'vesselStatus', summary: 'Class status, surveys due and outstanding conditions', method: 'GET', path: '/v1/vessels/{imo}', required: ['imo'], idempotent: false },
      { key: 'certificates', summary: 'Statutory certificates the society holds on delegation', method: 'GET', path: '/v1/vessels/{imo}/certificates', required: ['imo'], idempotent: false },
    ],
  },
  {
    key: 'messaging', name: 'SMS and email', nameAr: 'الرسائل والبريد', counterpart: 'Government SMS gateway and SMTP relay',
    reference: 'RFP §5.8 notifications · TAD 12.11', baseUrlEnv: 'MESSAGING_URL', defaultBaseUrl: 'https://stub.local/msg', protocol: 'rest',
    operations: [
      { key: 'sendSms', summary: 'Send an SMS or a one-time password', method: 'POST', path: '/v1/sms', required: ['to', 'body'], idempotent: true },
      { key: 'sendEmail', summary: 'Send a bilingual templated email', method: 'POST', path: '/v1/email', required: ['to', 'subject', 'body'], idempotent: true },
    ],
  },
];

export const adapterByKey = (key: string): AdapterDefinition | undefined => ADAPTERS.find((a) => a.key === key);
export const operationOf = (adapter: AdapterDefinition, key: string) => adapter.operations.find((o) => o.key === key);
export const TOTAL_OPERATIONS = ADAPTERS.reduce((n, a) => n + a.operations.length, 0);
