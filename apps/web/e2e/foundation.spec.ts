import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

test.describe('foundation screens', () => {
  test('login page renders and is accessible', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
    await expectAccessible(page, 'login');
  });
  test('super admin lands on the command centre and can open the launcher', async ({ page }) => {
    await login(page);
    await expect(page.getByText('Vessels at berth', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'All applications' }).first().click();
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expectAccessible(page, 'dashboard');
  });
  test('administration and data studio pages load and pass the accessibility sweep', async ({ page }) => {
    await login(page);
    for (const [path, heading] of [['/admin/users', 'Users'], ['/admin/roles', 'Roles & permissions'], ['/admin/audit', 'Audit log'], ['/admin/settings', 'Platform settings'], ['/masters', 'Data Studio'], ['/masters/berths', 'Berths & terminals'], ['/masters/m/port', 'Ports (UN/LOCODE)'], ['/berth-board', 'Berth board'], ['/settings/module/ops', 'Harbour Operations — settings'], ['/profile', 'My profile']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await page.waitForTimeout(600);
      await expectAccessible(page, path);
    }
  });
  test('command palette opens with the keyboard and searches the registers', async ({ page }) => {
    await login(page);
    await page.keyboard.press('Control+k');
    const box = page.getByRole('textbox', { name: 'Search everything' });
    await expect(box).toBeVisible();
    await box.fill('Maersk');
    await expect(page.getByText('Vessels', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  });
  test('settings and roles round-trip through the API', async ({ page }) => {
    await login(page);
    await page.goto('/admin/settings');
    await page.getByRole('tab', { name: 'Operations' }).click();
    const field = page.getByLabel('Anchorage wait alert (hours)');
    await field.fill('26');
    await page.getByRole('button', { name: /Save Operations/ }).click();
    await expect(page.getByText('Operations settings saved')).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'Operations' }).click();
    await expect(page.getByLabel('Anchorage wait alert (hours)')).toHaveValue('26');
    await page.getByLabel('Anchorage wait alert (hours)').fill('24');
    await page.getByRole('button', { name: /Save Operations/ }).click();
    await expect(page.getByText('Operations settings saved')).toBeVisible();
  });
  test('a role without admin rights is refused', async ({ page }) => {
    await login(page, 'shipping-agent');
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
  });
});

test.describe('exports', () => {
  /*
   * The Excel writer changed: SheetJS is unmaintained on npm and carries two open high advisories, both in
   * the parser this app never used. Swapping the engine is only safe if the file it produces is still a file
   * Excel will open, so this drives the real menu and looks inside what comes out.
   */
  test('the register exports a workbook Excel will open', async ({ page }) => {
    await login(page);
    await page.goto('/invoices');
    await expect(page.getByRole('button', { name: 'Export' }).first()).toBeVisible({ timeout: 20_000 });
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Export' }).first().click();
    await page.getByRole('menuitem', { name: /Excel/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await file.path();
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(path);
    // an .xlsx is a zip: it starts PK, and it has to carry the parts Excel looks for
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(1000);
    const text = bytes.toString('latin1');
    for (const part of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      expect(text, `the workbook has no ${part}`).toContain(part);
    }
  });
});
