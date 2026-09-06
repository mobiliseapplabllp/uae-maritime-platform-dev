import { expect, test } from '@playwright/test';
import { expectAccessible, login } from './helpers';

/* The live traffic picture, driven as the watch would: search a ship, open her card, follow her, draw her track;
 * the legend hides a class; the quay twin goes full screen. The map tiles come from the internet and may be blocked
 * where the drive runs — the picture, its layers and its cards do not depend on them. */
test.describe('live traffic', () => {
  test('a ship is found by name, her card opens, she joins the fleet and her track is drawn', async ({ page }) => {
    await login(page);
    await page.goto('/nmc/map');
    await expect(page.getByRole('heading', { name: 'Live traffic picture' })).toBeVisible();
    await expect(page.getByTestId('traffic-legend')).toContainText('VESSEL TYPES');
    await expect(page.getByTestId('feed-status')).toBeVisible();
    // the register's own fleet is on the picture: search one of its ships
    const search = page.getByTestId('traffic-search').locator('input');
    await search.fill('MV');
    const results = page.getByTestId('traffic-search-results');
    await expect(results).toBeVisible();
    const first = results.getByRole('button').first();
    const name = (await first.locator('.MuiListItemText-primary').textContent())?.replace(/^\S+\s/, '').trim() ?? '';
    await first.click();
    const card = page.getByTestId('vessel-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(name.toUpperCase().slice(0, 12));
    await expect(card).toContainText('Received:');
    // follow her: the fleet tab lists her
    await page.getByTestId('card-follow').click();
    await expect(page.getByTestId('card-follow')).toContainText('In my fleet');
    await page.getByRole('tab', { name: /My fleet/ }).click();
    await expect(page.getByTestId('my-fleet')).toContainText(name.slice(0, 10));
    // her track over the day
    await page.getByTestId('card-track').click();
    await expect(page.getByTestId('card-track')).toContainText('Hide track');
    await expect(page.getByTestId('track-summary')).toContainText('fixes');
    await expectAccessible(page, 'live traffic — card open');
    // let her go, and hide a class from the picture
    await page.getByTestId('card-follow').click();
    await expect(page.getByTestId('card-follow')).toContainText('Add to fleet');
    await page.getByTestId('traffic-legend').getByRole('button', { name: 'Tanker' }).click();
    await expect(page.getByTestId('traffic-legend').getByRole('button', { name: 'Tanker' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(card).toBeHidden();
  });
  test('the quay twin and the picture go full screen', async ({ page }) => {
    await login(page);
    await page.goto('/quay-view');
    await expect(page.getByRole('heading', { name: /Quay view/ })).toBeVisible();
    await page.getByTestId('quay-fullscreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null), { timeout: 5000 }).toBe('quay-stage');
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await page.goto('/nmc/map');
    await page.getByTestId('map-fullscreen').click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null), { timeout: 5000 }).toBe('traffic-stage');
    await page.getByRole('button', { name: 'Exit full screen' }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  });
});
