import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/* The module dashboards: every module opens on one, each draws its yardsticks and charts from live data, and the
 * Command Centre's side menu lists each of them. */
const DASHBOARDS: { path: string; testId: string; yardstick: string; chart: string }[] = [
  { path: '/ops/overview', testId: 'harbour-dashboard', yardstick: 'yard-waiting', chart: 'chart-months' },
  { path: '/invoices/overview', testId: 'revenue-dashboard', yardstick: 'yard-dso', chart: 'chart-months' },
  { path: '/admin/overview', testId: 'admin-dashboard', yardstick: 'yard-mfa', chart: 'chart-audit' },
  { path: '/masters/overview', testId: 'studio-dashboard', yardstick: 'yard-bilingual', chart: 'chart-masters' },
  { path: '/legislation/overview', testId: 'notices-dashboard', yardstick: 'yard-ack', chart: 'chart-months' },
  { path: '/companies/overview', testId: 'companies-dashboard', yardstick: 'yard-renewal', chart: 'chart-classes' },
  { path: '/services/overview', testId: 'desk-dashboard', yardstick: 'yard-sla', chart: 'chart-months' },
];

test.describe('module dashboards', () => {
  test('the Command Centre\'s side menu lists every module dashboard, and each link opens it', async ({ page }) => {
    await login(page);
    const nav = page.getByRole('navigation').first();
    await expect(nav.getByText('Module dashboards')).toBeVisible({ timeout: 15_000 });
    for (const name of ['Harbour Operations', 'Incident Desk', 'Revenue & Billing', 'Administration']) await expect(nav.getByRole('link', { name })).toBeVisible();
    await nav.getByRole('link', { name: 'Harbour Operations' }).click();
    await expect(page).toHaveURL(/\/ops\/overview$/);
    await expect(page.getByTestId('harbour-dashboard')).toBeVisible({ timeout: 20_000 });
  });

  // every dashboard carries the insights band once its figures are in: a band, not a column, so it never stretches the tiles beside it
  const BANDS: { path: string; module: string }[] = [
    { path: '/', module: 'mis' }, { path: '/ops/overview', module: 'ops' }, { path: '/fleet', module: 'ships' }, { path: '/seafarers/overview', module: 'crew' },
    { path: '/legislation/overview', module: 'legis' }, { path: '/incidents/overview', module: 'incidents' }, { path: '/inspections/overview', module: 'inspect' },
    { path: '/companies/overview', module: 'facil' }, { path: '/services/overview', module: 'services' }, { path: '/invoices/overview', module: 'finance' },
    { path: '/masters/overview', module: 'masters' }, { path: '/admin/overview', module: 'admin' }, { path: '/platform', module: 'platform' },
  ];
  test('every module dashboard carries its insights band, laid out wide and short', async ({ page }) => {
    test.setTimeout(240_000);
    await login(page);
    for (const b of BANDS) {
      await page.goto(b.path);
      const band = page.getByTestId(`ai-insights-${b.module}`);
      await expect(band).toBeVisible({ timeout: 20_000 });
      await expect(band.locator('[data-testid^="insight-"], [data-testid="ai-insights-clear"], [data-testid="ai-insights-refused"]').first()).toBeVisible({ timeout: 30_000 });
      const box = (await band.boundingBox())!;
      expect(box.width, `${b.path}: the band spans the page`).toBeGreaterThan(700);
      expect(box.height, `${b.path}: the band stays short`).toBeLessThan(box.width / 2);
    }
  });

  for (const d of DASHBOARDS) {
    test(`${d.path} draws its yardsticks and charts from live data and passes the accessibility sweep`, async ({ page }) => {
      await login(page);
      await page.goto(d.path);
      await expect(page.getByTestId(d.testId)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(d.yardstick)).toBeVisible();
      // the chart is drawn at size: a wrapper with no height once swallowed every chart on the home page
      const chart = page.getByTestId(d.chart).locator('.recharts-wrapper');
      await expect(chart).toHaveCount(1, { timeout: 15_000 });
      expect((await chart.boundingBox())?.height ?? 0).toBeGreaterThan(150);
      await expectAccessible(page, d.path);
    });
  }

  test('the service desk has a catalogue, a register and a studio, and an application can be opened from the register', async ({ page }) => {
    await login(page);
    await page.goto('/services');
    await expect(page.getByTestId('catalogue-search')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="service-"]').first()).toBeVisible();
    await page.getByTestId('catalogue-search').fill('registration');
    await expect(page.locator('[data-testid^="service-"]').first()).toBeVisible();
    await page.goto('/services/requests');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('row').nth(1).click();
    await expect(page.getByTestId('application-detail')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('application-timeline')).toBeVisible();
    await page.goto('/services/studio');
    await expect(page.getByTestId('studio-table')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="ver-"]').first()).toBeVisible();
    await expectAccessible(page, 'service studio');
  });
});
