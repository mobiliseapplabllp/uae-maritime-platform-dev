import { test, expect } from '@playwright/test';
import { expectAccessible, login } from './helpers';

/*
 * Settings → Integrations, driven as an administrator would: point a declared adapter at its counterpart with a
 * credential, test it against its recorded contract, run an operation from the console, add a counterpart nobody
 * declared and take it through the same motions, then remove it. The stack answers from stubs throughout.
 */
test.describe('integrations — adapters as configuration', () => {
  test('a declared adapter is configured, tested and exercised from the console', async ({ page }) => {
    await login(page);
    await page.goto('/admin/settings?tab=integrations');
    await expect(page.getByTestId('integrations-panel')).toBeVisible();
    await expect(page.getByTestId('adapter-card-mohre')).toBeVisible();
    await expectAccessible(page, 'settings — integrations');
    await page.getByTestId('adapter-card-mohre').click();
    const drawer = page.getByTestId('adapter-drawer');
    await expect(drawer).toContainText('Ministry of Human Resources');
    await expectAccessible(page, 'adapter drawer');
    // credentials are written, never read back
    await drawer.getByTestId('adapter-auth-type').locator('..').click();
    await page.getByRole('option', { name: 'API key header' }).click();
    await drawer.getByTestId('adapter-secret-apiKey').fill('drive-key-1');
    await drawer.getByTestId('adapter-save').click();
    await expect(page.locator('.MuiSnackbar-root').first()).toContainText('MOHRE saved');
    await expect(drawer.getByTestId('adapter-secret-apiKey')).toHaveValue('');
    await expect(drawer.getByTestId('adapter-secret-apiKey')).toHaveAttribute('placeholder', /Set — leave blank/);
    // the contract answers in stub mode
    await drawer.getByRole('tab', { name: /Activity/ }).click();
    await drawer.getByTestId('adapter-test').click();
    await expect(drawer.getByTestId('adapter-test-result')).toContainText(/2 of 2 operations recorded/);
    await drawer.getByTestId('adapter-invoke-payload').fill('{"emiratesId": "784-1990-0000000-1"}');
    await drawer.getByTestId('adapter-invoke').click();
    await expect(drawer.getByTestId('adapter-invoke-result')).toContainText('"employed": true');
    await expect(drawer.getByTestId('adapter-calls')).toContainText('console:');
    await expectAccessible(page, 'adapter activity');
  });

  test('a counterpart nobody declared is added, answers from its sample, and is removed', async ({ page }) => {
    await login(page);
    await page.goto('/admin/settings?tab=integrations');
    // a run that stopped part-way may have left it behind
    const token = (await (await page.request.post('/api/auth/login', { data: { email: 'admin@maritime.example', password: process.env.E2E_PASSWORD ?? 'Demo@2026' } })).json()).data.token as string;
    await page.request.delete('/api/integrations/drive-pcs', { headers: { authorization: `Bearer ${token}` } });
    await page.getByTestId('add-integration').click();
    await expectAccessible(page, 'add integration dialog');
    await page.getByTestId('new-adapter-key').fill('drive-pcs');
    await page.getByTestId('new-adapter-name').fill('Port community system (drive)');
    await page.getByTestId('new-adapter-counterpart').fill('Port community platform');
    await page.getByTestId('new-op-key-0').fill('manifest');
    await page.getByTestId('new-op-path-0').fill('/v2/calls/{vcn}/manifest');
    await page.getByTestId('new-op-required-0').fill('vcn');
    await page.getByRole('button', { name: 'Record an answer' }).click();
    await page.getByLabel('Body (JSON)').fill('{"vcn": "{vcn}", "lines": 3}');
    await page.getByRole('button', { name: 'Keep' }).click();
    await page.getByTestId('add-integration-save').click();
    const drawer = page.getByTestId('adapter-drawer');
    await expect(drawer).toContainText('Port community system (drive)');
    await expect(drawer.getByTestId('adapter-mode')).toHaveText('Stub');
    await drawer.getByRole('tab', { name: /Activity/ }).click();
    await drawer.getByTestId('adapter-invoke-payload').fill('{"vcn": "VCN-DRIVE-1"}');
    await drawer.getByTestId('adapter-invoke').click();
    await expect(drawer.getByTestId('adapter-invoke-result')).toContainText('VCN-DRIVE-1');
    await drawer.getByRole('tab', { name: 'Configuration' }).click();
    await drawer.getByTestId('adapter-delete').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('adapter-card-drive-pcs')).toHaveCount(0);
  });

  test('the registers reach their counterparts from their own screens', async ({ page }) => {
    await login(page);
    const token = (await (await page.request.post('/api/auth/login', { data: { email: 'admin@maritime.example', password: process.env.E2E_PASSWORD ?? 'Demo@2026' } })).json()).data.token as string;
    const h = { authorization: `Bearer ${token}` };
    // a seafarer's employment, with the labour ministry
    const seafarer = (await (await page.request.get('/api/seafarers?limit=1', { headers: h })).json()).data[0];
    await page.goto(`/seafarers/${seafarer.id}`);
    await page.getByTestId('verify-employment').click();
    await expect(page.getByTestId('employment-check')).toContainText('Employed');
    // a ship's class standing, with the society
    const vessel = (await (await page.request.get('/api/vessels?limit=1', { headers: h })).json()).data[0];
    await page.goto(`/vessels/${vessel.id}`);
    await page.getByTestId('refresh-class').click();
    await expect(page.getByTestId('class-status')).toContainText(/in class/);
    // an account offered for online payment, and settled by the gateway
    const issued = (await (await page.request.get('/api/invoices?status=ISSUED&limit=5', { headers: h })).json()).data.find((i: { paymentIntent?: unknown; balance?: number }) => !i.paymentIntent && (i.balance ?? 1) > 0);
    if (issued) {
      await page.goto(`/invoices/${issued.id}`);
      await page.getByTestId('pay-online').click();
      await expect(page.getByTestId('payment-intent')).toContainText(/pending/);
      await page.getByTestId('check-settlement').click();
      await expect(page.getByTestId('payment-intent')).toContainText(/settled/);
    }
    // the feed the traffic picture is drawn from
    await page.goto('/nmc/map');
    await expect(page.getByTestId('feed-status')).toBeVisible();
    await page.getByTestId('feed-read').click();
    await expect(page.locator('.MuiSnackbar-root').first()).toContainText(/Feed read/);
    await expect(page.getByTestId('feed-status')).toContainText(/ok/);
  });
});
