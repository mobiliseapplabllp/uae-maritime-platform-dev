import { describe, expect, it } from 'vitest';
import { composeDefinition, type Template } from '../src/definition-drafts';

/* The definition composer is pure: the same words always give the same proposal, and every value it infers names
 * the words it read it from. These tests pin what an officer's plain-language description turns into. */

const CHANDLER = 'Approval for a ship chandler to supply provisions alongside at Khalifa Port; needs a trade licence, an insurance certificate and a list of vehicles; fee AED 1,500; decision within 7 working days; valid 1 year.';
const ARABIC = /[؀-ۿ]/;

describe('ai-assistant — composing a service definition', () => {
  it('reads the applicant, the instrument, the documents, the fee, the service level and the validity from the description', () => {
    const d = composeDefinition({ description: CHANDLER });
    expect(d.name).toBe('Approval for a ship chandler to supply provisions alongside at Khalifa Port');
    expect(d.key).toBe('company.approval-ship-chandler-supply'); expect(d.code).toBe('APPROVAL-SHIP-CHANDLER-SUPPLY');
    expect(d).toMatchObject({ subjectKind: 'COMPANY', issuesInstrument: 'SHIP_CHANDLER', category: 'Licensing', categoryAr: 'الترخيص', domain: 7, autoApprovable: false, basedOn: null, engine: 'platform composer', descriptionAr: null });
    expect(d.content.documents.map((x) => x.code)).toEqual(['TRADE_LICENCE', 'INSURANCE', 'VEHICLE_LIST']);
    expect(d.content.documents.every((x) => x.required && ARABIC.test(x.labelAr))).toBe(true);
    expect(d.content.fees).toEqual({ lines: [{ code: 'APP', description: 'Application fee', descriptionAr: 'رسم الطلب', amount: 1500, taxable: true }], currency: 'AED' });
    expect(d.content.sla.days).toBe(7);
    expect(d.content.outputs).toMatchObject({ instrumentType: 'SHIP_CHANDLER', instrumentClass: 'LICENCE', validityMonths: 12 });
    expect(d.content.form.fields.map((f) => f.key)).toEqual(['port', 'vehicleCount', 'remarks']);
    expect(d.content.form.fields.at(-1)).toMatchObject({ key: 'remarks', required: false, multiline: true, labelAr: 'ملاحظات' });
    expect(d.nameAr.startsWith('اعتماد')).toBe(true); expect(d.nameAr).toContain('مورّد السفن');
    expect(d.inferred.map((i) => i.field)).toEqual(expect.arrayContaining(['name', 'subjectKind', 'instrumentType', 'category', 'document', 'fee', 'sla', 'validity', 'field']));
    expect(d.inferred.find((i) => i.field === 'subjectKind')).toEqual({ field: 'subjectKind', value: 'COMPANY', evidence: 'ship chandler' });
    expect(d.inferred.find((i) => i.field === 'sla')).toEqual({ field: 'sla', value: '7 days', evidence: 'within 7 working days' });
    const gaps = d.gaps.map((g) => g.en);
    expect(gaps).toEqual(expect.arrayContaining([expect.stringContaining('Arabic name'), expect.stringContaining('Arabic description'), expect.stringContaining('standard workflow')]));
    expect(gaps.some((g) => g.startsWith('No '))).toBe(false);
    expect(d.gaps.every((g) => ARABIC.test(g.ar))).toBe(true);
    expect(d.citations).toEqual([]);
  });

  it('knows a seafarer from the applicant phrase, and a passport photo from a passport', () => {
    const d = composeDefinition({ description: 'Renewal of a certificate of competency for a deck officer; needs the previous certificate, a medical certificate and a passport photo; fee AED 300; decided within 5 working days; valid for 5 years' });
    expect(d).toMatchObject({ subjectKind: 'SEAFARER', issuesInstrument: 'CERTIFICATE_OF_COMPETENCY', category: 'Seafarers', domain: 2, key: 'seafarer.renewal-certificate-competency-deck' });
    expect(d.inferred.find((i) => i.field === 'subjectKind')).toMatchObject({ evidence: 'deck officer' });
    expect(d.content.documents.map((x) => x.code)).toEqual(['PREVIOUS_INSTRUMENT', 'MEDICAL', 'PHOTO']);
    expect(d.content.sla.days).toBe(5); expect(d.content.outputs.validityMonths).toBe(60);
    expect(d.content.fees.lines).toEqual([expect.objectContaining({ code: 'APP', amount: 300 })]);
  });

  it('names its gaps and falls back to the defaults when the description is silent', () => {
    const d = composeDefinition({ description: 'Registration of a pleasure yacht under the national flag.' });
    expect(d).toMatchObject({ subjectKind: 'VESSEL', category: 'Registration', domain: 1, issuesInstrument: null, key: 'vessel.registration-pleasure-yacht-under' });
    expect(d.content.documents).toEqual([]); expect(d.content.fees.lines).toEqual([]); expect(d.content.sla.days).toBe(10);
    expect(d.content.outputs).toMatchObject({ instrumentType: null, instrumentClass: null, validityMonths: null });
    expect(d.gaps.map((g) => g.en)).toEqual(expect.arrayContaining([expect.stringContaining('No document is named'), expect.stringContaining('No fee is stated'), expect.stringContaining('No decision time')]));
    expect(d.content.form.fields.map((f) => f.key)).toEqual(['remarks']);
  });

  it('takes the template where the description is silent and the description where it speaks', () => {
    const template: Template = {
      id: 't1', key: 'fac.pest-control', name: 'Pest control accreditation — application', nameAr: 'اعتماد مكافحة الآفات — طلب', category: 'Licensing', domain: 7, subjectKind: 'COMPANY', issuesInstrument: 'PEST_CONTROL',
      content: {
        form: { fields: [{ key: 'premises', label: 'Premises address', labelAr: 'عنوان المقر', type: 'text', required: true, options: [], section: 'Application', help: '', multiline: false }], sections: [] },
        documents: [{ code: 'doc1', label: 'Trade licence', labelAr: 'الرخصة التجارية', required: true, docType: 'PDF', acceptedFormats: 'PDF' }],
        fees: { lines: [{ code: 'APP', description: 'Application fee', descriptionAr: 'رسم الطلب', amount: 3600, taxable: true }], currency: 'AED' },
        sla: { days: 15 }, outputs: { instrumentType: 'PEST_CONTROL', instrumentClass: 'ACCREDITATION', validityMonths: 24, notifications: [], templates: [] },
      },
    };
    const silent = composeDefinition({ description: 'Renewal of the approval for pest control on ships.' }, template);
    expect(silent).toMatchObject({ subjectKind: 'COMPANY', issuesInstrument: 'PEST_CONTROL', category: 'Accreditation', domain: 7, basedOn: { id: 't1', key: 'fac.pest-control', name: template.name } });
    expect(silent.content.documents.map((x) => x.code)).toEqual(['doc1']);
    expect(silent.content.fees.lines[0].amount).toBe(3600); expect(silent.content.sla.days).toBe(15); expect(silent.content.outputs.validityMonths).toBe(24);
    expect(silent.content.form.fields.map((f) => f.key)).toEqual(['premises', 'remarks']);
    expect(silent.inferred.filter((i) => i.evidence === 'template fac.pest-control').map((i) => i.field)).toEqual(['fees', 'sla', 'validity']);
    expect(silent.citations).toEqual([expect.objectContaining({ id: 't1', kind: 'serviceDefinition', ref: 'fac.pest-control', link: '/services/studio' })]);
    const spoken = composeDefinition({ description: 'Renewal of the approval for pest control on ships; needs an insurance certificate; fee AED 900; decided within 3 days; valid 1 year' }, template);
    expect(spoken.content.documents.map((x) => x.code)).toEqual(['INSURANCE', 'doc1']);
    expect(spoken.content.fees.lines).toEqual([expect.objectContaining({ code: 'APP', amount: 900 })]);
    expect(spoken.content.sla.days).toBe(3); expect(spoken.content.outputs.validityMonths).toBe(12);
  });

  it('honours a stated name, subject kind and category, marks an optional document, and says when the instrument matches no type', () => {
    const d = composeDefinition({
      description: 'Permission to carry out underwater hull cleaning in port waters; needs a trade licence and an insurance certificate (optional); AED 750 application fee and AED 250 issue fee; within 10 days',
      name: 'Hull cleaning permit', subjectKind: 'company', category: 'Port services',
    });
    expect(d).toMatchObject({ name: 'Hull cleaning permit', key: 'company.hull-cleaning-permit', code: 'HULL-CLEANING-PERMIT', subjectKind: 'COMPANY', category: 'Port services', domain: 6, issuesInstrument: null });
    expect(d.content.outputs.instrumentClass).toBe('PERMIT');
    expect(d.content.documents.map((x) => [x.code, x.required])).toEqual([['TRADE_LICENCE', true], ['INSURANCE', false]]);
    expect(d.content.fees.lines.map((l) => [l.code, l.amount])).toEqual([['APP', 750], ['ISS', 250]]);
    expect(d.content.sla.days).toBe(10);
    expect(d.inferred.some((i) => i.field === 'subjectKind' || i.field === 'category' || i.field === 'name')).toBe(false);
    expect(d.gaps.map((g) => g.en)).toEqual(expect.arrayContaining([expect.stringContaining('matches no type in the register'), expect.stringContaining('could not translate')]));
    expect(d.nameAr.startsWith('تصريح')).toBe(true); expect(d.nameAr).toContain('hull');
  });
});
