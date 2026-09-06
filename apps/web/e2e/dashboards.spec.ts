import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/* The module dashboards: every module opens on one, each draws its yardsticks and charts from live data, and the
 * Command Centre carries a tile for each with a number and a link. */
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
  test('the Command Centre carries a tile per module, with numbers, and each opens the module dashboard', async ({ page }) => {
    await login(page);
    const strip = page.getByTestId('module-strip');
    await expect(strip).toBeVisible();
    for (const key of ['ops', 'ships', 'crew', 'legis', 'incidents', 'inspect', 'facil', 'services', 'finance', 'mis', 'masters', 'agents', 'platform', 'admin']) await expect(page.getByTestId(`strip-${key}`)).toBeVisible();
    // the harbour tile carries the vessels in port, and opens the harbour dashboard
    await expect(page.getByTestId('strip-ops')).toContainText('In port', { timeout: 15_000 });
    await page.getByTestId('strip-finance').click();
    await expect(page).toHaveURL(/\/invoices\/overview$/);
    await expect(page.getByTestId('revenue-dashboard')).toBeVisible({ timeout: 20_000 });
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
