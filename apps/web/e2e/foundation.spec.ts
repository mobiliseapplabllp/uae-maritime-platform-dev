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
  test('administration pages load', async ({ page }) => {
    await login(page);
    for (const [path, heading] of [['/admin/users', 'Users'], ['/admin/roles', 'Roles & permissions'], ['/admin/audit', 'Audit log'], ['/admin/settings', 'Platform settings'], ['/masters', 'Data Studio'], ['/profile', 'My profile']] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });
  test('a role without admin rights is refused', async ({ page }) => {
    await login(page, 'shipping-agent');
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible();
  });
});
