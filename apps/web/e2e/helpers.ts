import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function login(page: Page, role: 'super-admin' | 'harbour-master' | 'marine-surveyor' | 'finance-officer' | 'shipping-agent' = 'super-admin') {
  await page.goto('/login');
  await page.getByTestId(`login-${role}`).click();
  await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
}
/** WCAG 2.2 AA sweep with axe-core; fails on serious and critical violations. */
export async function expectAccessible(page: Page, context?: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious, `${context || page.url()}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(', ')}`).toEqual([]);
}
