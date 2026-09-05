import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/**
 * Smart Inspection end to end: the programme KPIs on the dashboard, a facility inspection planned under a regime from the
 * master, and a survey's dossier, prediction, report, notice and recommendation panels. Runs against the seeded world.
 */
test.describe('inspections — the Smart Inspection programme', () => {
  test.describe.configure({ mode: 'serial' });

  test('the dashboard shows the six KPIs measured from the desk\'s events', async ({ page }) => {
    await login(page);
    await page.goto('/inspections/overview');
    await expect(page.getByRole('heading', { name: /Smart Inspection programme/ })).toBeVisible();
    for (const key of ['dossierCoverage', 'aiReports', 'noticeSpeed', 'predictionCorrelation', 'reportTurnaround', 'restrictionRouting']) {
      await expect(page.getByTestId(`kpi-${key}`)).toBeVisible();
      await expect(page.getByTestId(`kpi-${key}`)).toContainText(/Met|On track|Behind|Not captured/);
    }
    await expect(page.getByText(/Month \d+ of 18/)).toBeVisible();
    await expectAccessible(page, '/inspections/overview');
    // the same figures reach the command centre through reporting's projection of the events
    const stats = await page.request.get('/api/stats/inspectionKpis', { headers: { authorization: `Bearer ${(JSON.parse(await page.evaluate(() => localStorage.getItem('maritime-session') ?? '{}')) as { token?: string }).token ?? ''}` } });
    expect(stats.ok()).toBeTruthy();
    const cards = (await stats.json()).data.cards as { label: string }[];
    expect(cards.map((c) => c.label)).toContain('Restrictions routed within the hour');
  });

  test('a facility inspection is planned under a regime from the master, with its dossier and prediction made at once', async ({ page }) => {
    await login(page);
    await page.goto('/inspections');
    await page.getByRole('button', { name: 'New inspection' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Regime/).click();
    await page.getByRole('option', { name: 'HSE inspection' }).click();
    await expect(dialog.getByText('This regime applies to a Port facility')).toBeVisible();
    await dialog.getByLabel(/Port facility/).click();
    await page.getByRole('option').first().click();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/inspections\/[0-9a-f-]+$/);
    await expect(page.getByTestId('dossier-card')).toContainText(/Prepared/);
    await expect(page.getByTestId('prediction-card')).toContainText(/risk/i);
    await expect(page.getByTestId('timeline-card')).toContainText('dossier prepared');
    await expectAccessible(page, 'facility inspection');
  });

  test('a survey closed with many open deficiencies gets a restriction recommended by the rules, and the officer decides', async ({ page }) => {
    await login(page);
    const token = (JSON.parse(await page.evaluate(() => localStorage.getItem('maritime-session') ?? '{}')) as { token?: string }).token ?? '';
    const api = (path: string, body?: unknown) => page.request.post(`/api${path}`, { headers: { authorization: `Bearer ${token}` }, data: body ?? {} });
    // a ship with nothing open against her, so the drive never trips over another survey
    const ships = await page.request.get('/api/inspections/subjects?kind=VESSEL&limit=100', { headers: { authorization: `Bearer ${token}` } });
    const vessel = ((await ships.json()).data as { id: string }[])[0];
    const planned = await api('/inspections', { vesselId: vessel.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Playwright drive' });
    expect(planned.ok()).toBeTruthy();
    const id = (await planned.json()).data.id as string;
    for (const code of ['01101', '04103', '07105', '10111', '13101']) expect((await api(`/inspections/${id}/findings`, { deficiencyCode: code, description: `${code} observed (e2e)`, actionCode: '17' })).ok()).toBeTruthy();
    expect((await api(`/inspections/${id}/close`, { result: 'DEFICIENCIES' })).ok()).toBeTruthy();
    await page.goto(`/inspections/${id}`);
    await expect(page.getByTestId('recommendation-card')).toContainText('Awaiting decision');
    await expect(page.getByTestId('recommendation-card')).toContainText('Operational restriction');
    await expect(page.getByTestId('prediction-card')).toContainText(/Prediction (matched|did not match) the findings/);
    await page.getByTestId('recommendation-card').getByRole('button', { name: 'Decide' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Decision/).click();
    await page.getByRole('option', { name: 'Deferred' }).click();
    await dialog.getByLabel('Note').fill('Deferred pending the rectification plan (e2e).');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('recommendation-card')).toContainText('Deferred');
    await expect(page.getByTestId('timeline-card')).toContainText('restriction decided');
  });
});
