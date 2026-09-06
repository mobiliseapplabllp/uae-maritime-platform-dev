import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import ServiceStudio from '../src/pages/services/ServiceStudio';
import type { CreatedDefinition, DefinitionDraft } from '../src/components/ai/DefinitionDraftDialog';

/* The Service Studio drafting a definition with the assistant: the proposal is composed from a description, says
 * what it read and what is missing, and becomes a DEV draft only when the person creates it — through the Studio's
 * own create path, after which the usual review applies. Every service, key and person here is fictional. */

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Studio Designer', email: 'designer@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const reader = { ...session, user: { ...session.user, name: 'Desk Reader', role: { id: 'r2', name: 'Reader', permissions: ['services.view'] }, perms: ['services.view'] } };
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const DESCRIPTION = 'Approval for a ship chandler to supply provisions alongside; needs a trade licence and an insurance certificate (optional); fee AED 1,500; decision within 7 working days; valid 1 year';
const DRAFT: DefinitionDraft = {
  key: 'company.approval-ship-chandler-supply', code: 'APPROVAL-SHIP-CHANDLER-SUPPLY', name: 'Approval for a ship chandler to supply provisions alongside', nameAr: 'اعتماد مورّد السفن لتوريد المؤن',
  category: 'Licensing', categoryAr: 'الترخيص', domain: 7, subjectKind: 'COMPANY', description: DESCRIPTION, descriptionAr: null, issuesInstrument: 'SHIP_CHANDLER', autoApprovable: false,
  changeNote: 'Drafted with the assistant from a plain-language description; not yet reviewed',
  content: {
    form: { fields: [{ key: 'port', label: 'Port', labelAr: 'الميناء', type: 'text', required: true }, { key: 'remarks', label: 'Remarks', labelAr: 'ملاحظات', type: 'text', required: false }], sections: [] },
    documents: [{ code: 'TRADE_LICENCE', label: 'Trade licence', labelAr: 'الرخصة التجارية', required: true }, { code: 'INSURANCE', label: 'Insurance certificate', labelAr: 'شهادة التأمين', required: false }],
    fees: { lines: [{ code: 'APP', description: 'Application fee', descriptionAr: 'رسم الطلب', amount: 1500 }], currency: 'AED' }, sla: { days: 7 },
    outputs: { instrumentType: 'SHIP_CHANDLER', instrumentClass: 'LICENCE', validityMonths: 12 },
  },
  basedOn: { id: 'def1', key: 'fac.pest-control', name: 'Pest control accreditation' },
  inferred: [{ field: 'subjectKind', value: 'COMPANY', evidence: 'ship chandler' }, { field: 'sla', value: '7 days', evidence: 'within 7 working days' }],
  gaps: [{ en: 'The Arabic name is a suggestion; confirm the wording.', ar: 'الاسم العربي اقتراح؛ أكّد الصياغة.' }, { en: 'Write the Arabic description; it is empty.', ar: 'اكتب الوصف العربي؛ فهو فارغ.' }],
  engine: 'platform composer', citations: [{ id: 'def1', label: 'Pest control accreditation', kind: 'serviceDefinition', ref: 'fac.pest-control', link: '/services/studio' }],
};
const CREATED: CreatedDefinition = { id: 'd9', key: DRAFT.key, code: DRAFT.code, name: DRAFT.name, nameAr: DRAFT.nameAr, category: 'Licensing', subjectKind: 'COMPANY', ownerModule: 'facilities', issuesInstrument: 'SHIP_CHANDLER', autoApprovable: false, currentVersion: 1, status: 'DRAFT', versions: [{ version: 1, environment: 'DEV', status: 'DRAFT', changeNote: DRAFT.changeNote, updatedAt: '2026-09-06T10:00:00Z' }] };
const VERSION = { id: 'v9', version: 1, environment: 'DEV', status: 'DRAFT', form: DRAFT.content.form, documents: DRAFT.content.documents, fees: DRAFT.content.fees, sla: DRAFT.content.sla, workflow: { states: [], transitions: [] }, outputs: DRAFT.content.outputs, changeNote: DRAFT.changeNote };

describe('Service Studio — drafting a definition with the assistant', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); store.dispatch(setSession(session as never)); });

  it('composes a proposal from a description, shows what was read and what is missing, and creates it as a DEV draft the person then reviews', async () => {
    const rows: unknown[] = [];
    vi.spyOn(api, 'get').mockImplementation(((url: string) => {
      if (url === '/services/definitions') return Promise.resolve(ok(rows));
      if (url === '/services/definitions/d9/versions/1') return Promise.resolve(ok(VERSION));
      return Promise.reject(new Error(`Unmocked GET ${url}`));
    }) as never);
    const post = vi.spyOn(api, 'post').mockImplementation(((url: string) => {
      if (url === '/ai/definitions/draft') return Promise.resolve(ok(DRAFT));
      if (url === '/services/definitions') { rows.push({ ...CREATED }); return Promise.resolve(ok(CREATED)); }
      return Promise.reject(new Error(`Unmocked POST ${url}`));
    }) as never);
    wrap(<ServiceStudio />);
    await screen.findByTestId('studio-table');
    fireEvent.click(screen.getByTestId('studio-ai-draft'));
    const description = (await screen.findByTestId('dd-description')) as HTMLTextAreaElement;
    expect((screen.getByTestId('dd-compose') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(description, { target: { value: DESCRIPTION } });
    fireEvent.change(screen.getByTestId('dd-based-on'), { target: { value: 'fac.pest-control' } });
    expect((screen.getByTestId('dd-compose') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('dd-compose'));
    const preview = await screen.findByTestId('dd-preview');
    expect(post).toHaveBeenCalledWith('/ai/definitions/draft', { description: DESCRIPTION, basedOn: 'fac.pest-control', language: 'en' });
    expect(within(preview).getByText('Approval for a ship chandler to supply provisions alongside')).toBeTruthy();
    for (const text of ['company.approval-ship-chandler-supply', 'APPROVAL-SHIP-CHANDLER-SUPPLY', 'Applicant: company', 'Category: Licensing', 'Issues: ship chandler', 'Based on: Pest control accreditation', 'TRADE_LICENCE', 'Trade licence · required', 'Insurance certificate · optional', 'Application fee · AED 1,500', 'Service level: 7 days', 'Validity: 12 months', 'port · Port · text · required', 'Composed by: platform composer']) {
      expect(preview.textContent).toContain(text);
    }
    expect(screen.getByTestId('dd-inferred').textContent).toContain('subjectKind: COMPANY ← "ship chandler"');
    expect(screen.getByTestId('dd-gaps').textContent).toContain('The Arabic name is a suggestion');
    expect(screen.getByTestId('dd-gaps').textContent).toContain('Write the Arabic description');
    expect(screen.getByText('Compose again')).toBeTruthy();
    fireEvent.click(screen.getByTestId('dd-create'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/services/definitions', {
      key: DRAFT.key, code: DRAFT.code, name: DRAFT.name, nameAr: DRAFT.nameAr, category: 'Licensing', categoryAr: 'الترخيص', domain: 7, subjectKind: 'COMPANY',
      description: DESCRIPTION, descriptionAr: null, issuesInstrument: 'SHIP_CHANDLER', autoApprovable: false, content: DRAFT.content, changeNote: DRAFT.changeNote,
    }));
    // the table reloads with the new definition, and its DEV draft opens for review, editable
    await screen.findByTestId('def-company.approval-ship-chandler-supply');
    const json = (await screen.findByTestId('studio-json')) as HTMLTextAreaElement;
    expect(json.value).toBe(JSON.stringify(VERSION.form, null, 2));
    expect(screen.getByTestId('studio-save')).toBeTruthy();
    expect(screen.queryByTestId('dd-preview')).toBeNull();
  });

  it('says why when the assistant cannot compose, and offers no drafting to a reader who may not manage services', async () => {
    vi.spyOn(api, 'get').mockImplementation(((url: string) => (url === '/services/definitions' ? Promise.resolve(ok([])) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
    vi.spyOn(api, 'post').mockImplementation((() => Promise.reject(new Error('The assistant is switched off in Settings → AI assistant'))) as never);
    wrap(<ServiceStudio />);
    await screen.findByTestId('studio-table');
    fireEvent.click(screen.getByTestId('studio-ai-draft'));
    fireEvent.change(await screen.findByTestId('dd-description'), { target: { value: DESCRIPTION } });
    fireEvent.click(screen.getByTestId('dd-compose'));
    expect((await screen.findByTestId('dd-error')).textContent).toContain('switched off');
    expect(screen.queryByTestId('dd-preview')).toBeNull();
    expect(screen.queryByTestId('dd-create')).toBeNull();

    cleanup();
    store.dispatch(setSession(reader as never));
    wrap(<ServiceStudio />);
    await screen.findByTestId('studio-table');
    expect(screen.queryByTestId('studio-ai-draft')).toBeNull();
    expect(screen.queryByTestId('dd-description')).toBeNull();
  });
});
