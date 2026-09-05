import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/**
 * The legislation domain end to end: the public citable portal (no session), the notice library's portal box,
 * and the IMO watch — reading a source now, assessing a document, transposing it to an instrument.
 * Runs against the seeded world; every reference it opens comes from the API rather than a hard-coded seed.
 */
test.describe('legislation — public portal and IMO watch', () => {
  test.describe.configure({ mode: 'serial' });

  test('anyone can read the register, open an instrument at its address and cite it', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/law');
    await expect(page.getByRole('heading', { name: /Legal instruments in force/ })).toBeVisible();
    await expect(page.getByText(/instrument\(s\)/)).toBeVisible();
    await expectAccessible(page, '/law');
    // the facets come from the published register
    await page.getByLabel('Type').click();
    const option = page.getByRole('option').nth(1);
    const label = await option.textContent();
    await option.click();
    await expect(page).toHaveURL(/type=/);
    // open the first instrument
    const first = page.getByRole('listitem').first();
    const ref = await first.locator('span').first().textContent();
    await first.click();
    await expect(page).toHaveURL(/\/law\/[a-z0-9-]+$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('citation-box')).toContainText(ref!.trim());
    await expect(page.getByTestId('standing-banner')).toBeVisible();
    await expectAccessible(page, `/law/${label}`);
    // the machine-readable copy is the same instrument, with an ETag a client can revalidate by
    const url = new URL(page.url());
    const res = await page.request.get(`/api/public/legislation/${url.pathname.split('/').pop()}`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['etag']).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await page.request.get(`/api/public/legislation/${url.pathname.split('/').pop()}`, { headers: { 'if-none-match': res.headers()['etag'] } });
    expect(again.status()).toBe(304);
    // a draft is never there
    const drafts = await page.request.get('/api/public/legislation?history=true&limit=200');
    const body = await drafts.json();
    expect(body.data.every((i: { status: string }) => i.status !== 'DRAFT')).toBeTruthy();
  });

  test('the desk sees the public address and citation of an in-force instrument, and a draft has none', async ({ page }) => {
    await login(page);
    await page.goto('/legislation?status=IN_FORCE');
    await page.getByRole('row').nth(1).click();
    const box = page.getByTestId('portal-box');
    await expect(box).toBeVisible();
    await expect(box.getByRole('link')).toHaveAttribute('href', /\/law\//);
    await expect(box.getByRole('button', { name: 'Open portal page' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/legislation?status=DRAFT');
    const rows = page.getByRole('row');
    if (await rows.count() > 1) {
      await rows.nth(1).click();
      await expect(page.getByTestId('portal-box')).toContainText('A draft is not published');
    }
  });

  test('the IMO watch reads a source now, and the desk assesses and transposes a document', async ({ page }) => {
    await login(page);
    await page.goto('/legislation/imo');
    await expect(page.getByRole('heading', { name: 'IMO Watch' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Sources' })).toBeVisible();
    await expectAccessible(page, '/legislation/imo');
    await page.getByRole('button', { name: 'Read all sources now' }).click();
    await expect(page.getByRole('alert').or(page.locator('.MuiSnackbar-root'))).toContainText(/new document|failed/);
    // assess the first new document
    await page.getByLabel('Status').click();
    await page.getByRole('option', { name: 'New' }).click();
    const rows = page.getByRole('table').last().getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
    await rows.nth(1).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Assessment').fill('A national circular gives effect to this guidance (e2e).');
    await dialog.getByLabel('Due date').fill('2027-03-31');
    await dialog.getByRole('button', { name: 'Record' }).click();
    await expect(page.locator('.MuiSnackbar-root')).toContainText('Recorded as Assessed');
    // transpose it to an instrument on the register
    await page.getByLabel('Status').click();
    await page.getByRole('option', { name: 'Assessed' }).click();
    await page.getByRole('table').last().getByRole('row').nth(1).click();
    await dialog.getByLabel('Decision').click();
    await page.getByRole('option', { name: 'Transposed' }).click();
    await dialog.getByLabel('National instrument').fill('CIRC');
    await page.getByRole('option').first().click();
    await dialog.getByRole('button', { name: 'Record' }).click();
    await expect(page.locator('.MuiSnackbar-root')).toContainText('Recorded as Transposed');
  });
});
