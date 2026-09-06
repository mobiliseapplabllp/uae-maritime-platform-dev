/* The service desk as the workflow service answers it: the published catalogue, an application as lodged and assessed,
 * and the definitions the Service Studio governs through their environments. */
export interface CatalogueService {
  id: string; key: string; code: string; name: string; nameAr: string | null; label: string; description: string; descriptionAr: string | null; subjectKind: string; domain: number; ownerModule: string;
  issuesInstrument: string | null; instrumentType: string | null; autoApprovable: boolean; version: number;
  fee: { amount: number; currency: string; ruleSetKey: string | null; taxRatePct: number }; slaDays: number; fields: number; documents: number; requiredDocuments: number;
}
export interface Catalogue { total: number; autoApprovable: number; environment: string; currency: string; categories: { category: string; categoryAr: string | null; label: string; count: number; services: CatalogueService[] }[] }
export interface FormField { key: string; label: string; labelAr?: string | null; type: string; required?: boolean; options?: { value: string; label: string; labelAr?: string | null }[]; optionsFrom?: string; help?: string }
export interface ServiceDetail extends Omit<CatalogueService, 'documents' | 'fields' | 'label'> {
  category: string; categoryAr?: string | null; label?: string; environment?: string;
  form: { fields: FormField[] }; documents: { code: string; label: string; labelAr?: string | null; required: boolean }[];
  fees: { lines: { code: string; description: string; amount: number; taxable?: boolean }[]; currency: string; ruleSetKey?: string | null } | null; sla: { days: number; ruleSetKey?: string | null } | null;
  outputs?: { instrumentType?: string | null }; workflow?: { states: { key: string; label: string; labelAr?: string | null; status?: string }[] };
}
export interface TimelineEntry { from: string; to: string; action?: string; at: string; by?: { id?: string | null; name?: string } | string; note?: string }
export interface RequestRow {
  id: string; number: string; definitionId: string; definitionKey: string; definitionName: string; definitionNameAr?: string | null; definitionVersion: number; environment: string; category: string; domain: number;
  subjectKind: string; subjectId: string | null; subjectName: string | null; applicant: { userId?: string | null; name: string; email?: string; phone?: string; organisation?: string; organisationCode?: string };
  status: string; currentState: string; fees: { lines: { code: string; description: string; amount: number }[]; total: number; currency: string } | null; payment: { status: string; amount: number; currency: string; paidAt: string | null; reference: string } | null;
  assignee: { userId?: string | null; name?: string } | null; slaDueAt: string | null; slaBreached: boolean; slaBreachedAt: string | null; submittedAt: string | null; decidedAt: string | null; closedAt: string | null;
  issuedInstrument: { id?: string; number?: string; licenseNo?: string } | null; createdAt: string; updatedAt: string; documentCount?: number;
}
export interface RequestDetail extends RequestRow {
  formData: Record<string, unknown>; documents: { code: string; name?: string; documentId?: string | null; verified?: boolean; notes?: string }[]; checks: { key?: string; label?: string; passed?: boolean; note?: string }[];
  timeline: TimelineEntry[]; availableActions: { key: string; label: string; labelAr?: string | null; to?: string; requiresNote?: boolean }[]; stateLabel: string; stateLabelAr: string | null;
  definition: { key: string; name: string; nameAr: string | null; version: number; form: { fields: FormField[] }; documents: { code: string; label: string; required: boolean }[]; sla: { days: number } | null; outputs: { instrumentType?: string | null } };
}
export interface Definition { id: string; key: string; code: string; name: string; nameAr: string | null; category: string; subjectKind: string; ownerModule: string; issuesInstrument: string | null; autoApprovable: boolean; currentVersion: number; status: string; updatedAt?: string }
export interface DefinitionVersion { id?: string; version: number; environment: 'DEV' | 'UAT' | 'PROD'; status: string; publishedAt?: string | null; retiredAt?: string | null; createdBy?: string | null; approvedBy?: string | null; publishedBy?: string | null; promotedFrom?: string | null }
export const REQUEST_STATUS_META: Record<string, { label: string; color: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' }> = {
  DRAFT: { label: 'Draft', color: 'default' }, SUBMITTED: { label: 'Submitted', color: 'info' }, UNDER_ASSESSMENT: { label: 'Under assessment', color: 'primary' }, INFO_REQUESTED: { label: 'Information requested', color: 'warning' },
  APPROVED: { label: 'Approved', color: 'success' }, REJECTED: { label: 'Rejected', color: 'error' }, ISSUED: { label: 'Issued', color: 'success' }, WITHDRAWN: { label: 'Withdrawn', color: 'default' },
};
