import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/* The AI-native surfaces, against the running platform: insights on a module dashboard with an action that runs
 * through the tool gateway, the assistant dock following the screen, the desk drafting a letter, Settings → AI
 * carrying the in-country slot, and the gateway's governance page under Agent Operations. */

test.describe('AI-native modules', () => {
  test('a module dashboard carries insights from its own figures, and a read action answers through the gateway', async ({ page }) => {
    await login(page);
    await page.goto('/invoices/overview');
    const panel = page.getByTestId('ai-insights-finance');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator('[data-testid^="insight-"], [data-testid="ai-insights-clear"]').first()).toBeVisible({ timeout: 20_000 });
    const overdue = page.getByTestId('insight-action-finance.overdue');
    if (await overdue.count()) {
      await overdue.click();
      const dialog = page.getByTestId('insight-result');
      await expect(dialog).toBeVisible({ timeout: 20_000 });
      await expect(dialog.getByRole('table')).toBeVisible({ timeout: 20_000 });
      await page.keyboard.press('Escape');
    }
    await expectAccessible(page, 'revenue dashboard with insights');
  });

  test('the assistant dock follows the screen it is opened on', async ({ page }) => {
    await login(page);
    await page.goto('/invoices/overview');
    await expect(page.getByTestId('revenue-dashboard')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open the port assistant' }).click();
    await expect(page.getByTestId('ai-dock-intro')).toContainText('Revenue', { timeout: 15_000 });
    await expect(page.getByTestId('ai-dock-status')).toContainText('platform composer');
    await page.getByRole('button', { name: 'Which invoices are overdue?' }).click();
    await expect(page.getByText(/Receivables:|overdue/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test('the desk drafts a decision letter from the application, in Arabic on request', async ({ page }) => {
    await login(page);
    await page.goto('/services/requests');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('row').nth(1).click();
    await expect(page.getByTestId('application-detail')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('draft-decision').click();
    await expect(page.getByTestId('draft-dialog')).toBeVisible();
    await page.getByTestId('draft-lang-ar').click();
    await page.getByTestId('draft-prepare').click();
    await expect(page.getByTestId('draft-body')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('draft-body').locator('pre')).toHaveAttribute('dir', 'rtl');
    await expectAccessible(page, 'application with a draft');
  });

  test('Settings → AI carries the in-country slot and the residency rules', async ({ page }) => {
    await login(page);
    await page.goto('/admin/settings/ai');
    await expect(page.getByTestId('ai-provider')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ai-uae-endpoint')).toBeVisible();
    await expect(page.getByLabel('Residency required', { exact: false })).toBeVisible();
    await expectAccessible(page, 'settings ai');
  });

  test('the tool gateway page shows the calls the assistant and the agents made', async ({ page }) => {
    await login(page);
    await page.goto('/agents/gateway');
    await expect(page.getByTestId('gateway-page')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('yard-calls')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('tab-calls').click();
    const table = page.getByTestId('calls-table');
    await expect(table).toBeVisible({ timeout: 20_000 });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await page.getByTestId('tab-callers').click();
    await expect(page.getByTestId('callers-table')).toContainText('assistant');
    await expectAccessible(page, 'tool gateway');
  });
  test('the Studio drafts a definition with the assistant and creates it as a DEV draft for review', async ({ page }) => {
    await login(page);
    await page.goto('/services/studio');
    await expect(page.getByTestId('studio-table')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('studio-ai-draft').click();
    const stamp = Date.now().toString(36);
    await page.getByTestId('dd-description').fill('Approval for a ship chandler to supply provisions alongside at Khalifa Port; needs a trade licence, an insurance certificate and a list of vehicles; fee AED 1,500; decision within 7 working days; valid 1 year.');
    await page.getByTestId('dd-name').fill(`Ship chandler approval ${stamp}`);
    await page.getByTestId('dd-compose').click();
    const preview = page.getByTestId('dd-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText('TRADE_LICENCE');
    await expect(preview).toContainText('AED 1,500');
    await expect(preview).toContainText('7 days');
    await expect(page.getByTestId('dd-gaps')).toBeVisible();
    await expectAccessible(page, 'studio draft proposal');
    await page.getByTestId('dd-create').click();
    await expect(page.getByTestId(`def-company.ship-chandler-approval-${stamp}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`ver-company.ship-chandler-approval-${stamp}-DEV-1`)).toBeVisible();
  });
});
