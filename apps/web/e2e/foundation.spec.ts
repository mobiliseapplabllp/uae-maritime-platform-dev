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
    test.setTimeout(150_000); // seven screens, each read at rest and swept with axe — the default minute is too tight when two workers share the machine
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
  test('settings round-trip through the API: a card opens its section, a save is read back', async ({ page }) => {
    await login(page);
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: 'Platform settings' })).toBeVisible();
    // the landing shows every platform section and every module's settings as a card, with the values that matter
    await expect(page.getByTestId('settings-card-notifications')).toContainText('Escalate after');
    await expect(page.getByTestId('settings-card-module-ops')).toContainText('Channel limit');
    await page.getByTestId('settings-card-notifications').click();
    await expect(page.getByRole('heading', { name: 'Notifications — settings' })).toBeVisible();
    const field = page.getByLabel('Escalate unread critical alerts after (hours)');
    await field.fill('5');
    await page.getByRole('button', { name: /Save Notifications/ }).click();
    await expect(page.getByText('Notifications settings saved')).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Escalate unread critical alerts after (hours)')).toHaveValue('5');
    await expect(page.getByTestId('escalation-panel')).toContainText('sent on after 5 h');
    await page.getByLabel('Escalate unread critical alerts after (hours)').fill('4');
    await page.getByRole('button', { name: /Save Notifications/ }).click();
    await expect(page.getByText('Notifications settings saved')).toBeVisible();
    // a module's settings reach the module: the surveillance thresholds are what Live Traffic judges alerts against
    await page.goto('/admin/settings');
    await page.getByTestId('settings-card-module-ops').click();
    await expect(page.getByRole('heading', { name: 'Harbour Operations — settings' })).toBeVisible();
    await expect(page.getByTestId('module-settings-used-by')).toContainText('Live Traffic');
    // the old tabbed address still lands on the right page
    await page.goto('/admin/settings?tab=integrations');
    await expect(page.getByTestId('integrations-panel')).toBeVisible();
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
