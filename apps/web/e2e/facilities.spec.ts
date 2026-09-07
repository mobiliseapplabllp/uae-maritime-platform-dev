import { test, expect } from '@playwright/test';
import { login, expectAccessible } from './helpers';

/**
 * The port-facility register and the federal security review: the desk submits a facility to the authority through
 * the ICP exchange, reads the reference back at once, asks for the outcome and sees it on the record, in the history
 * and on the register. The facility is chosen through the API, so the drive runs again and again against the same world.
 */
test.describe('port facilities — the federal security review', () => {
  test('the security desk submits a facility for review and reads the outcome back', async ({ page }) => {
    await login(page);
    const token = (JSON.parse(await page.evaluate(() => localStorage.getItem('maritime-session') ?? '{}')) as { token?: string }).token ?? '';
    const headers = { authorization: `Bearer ${token}` };
    const pick = async (review: string) => ((await (await page.request.get(`/api/facilities/port-facilities?review=${review}&limit=1&sort=code`, { headers })).json()).data as { id: string; code: string; name: string }[])[0];
    // a facility with no review on it, or one whose last review is closed — never one still with the authority
    const facility = (await pick('none')) ?? (await pick('CLEARED'));
    expect(facility).toBeTruthy();

    await page.goto('/port-facilities');
    await expect(page.getByRole('heading', { name: 'Port facilities' })).toBeVisible();
    await expect(page.getByRole('row').nth(1)).toBeVisible();
    await expect(page.getByText('Reviews with the authority')).toBeVisible();
    await expectAccessible(page, '/port-facilities');

    await page.goto(`/port-facilities/${facility.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(facility.name);
    await expect(page.getByTestId('security-review')).toBeVisible();
    await expectAccessible(page, `/port-facilities/${facility.code}`);
    await page.getByTestId('submit-review').click();
    await page.getByLabel(/Reason for the review/).fill('Annual verification of the facility security plan (browser drive)');
    await page.getByTestId('submit-review-confirm').click();
    await expect(page.getByTestId('review-status')).toContainText('Submitted');
    await expect(page.getByTestId('security-review')).toContainText('ICP-REV-');
    // the answer names where it came from: the recorded contract, or — with the sandbox counterpart running
    // (./run-local.sh sandbox icp) — the authority reached live, as SOAP over the network
    const sandbox = !!process.env.E2E_ICP_SANDBOX;
    await expect(page.getByTestId('review-status')).toContainText(sandbox ? 'From the authority' : 'Recorded contract');
    // the outcome: the recorded contract clears at once when asked; the sandbox decides in its own time and pushes the
    // decision to the platform, so it is either on the record already or there to be asked for
    if (sandbox) {
      await expect(async () => {
        await page.reload();
        await expect(page.getByTestId('security-review')).toBeVisible();
        if (await page.getByTestId('check-review').isVisible()) await page.getByTestId('check-review').click();
        await expect(page.getByTestId('review-status')).toContainText(/Cleared|Rejected/, { timeout: 2000 });
      }).toPass({ timeout: 120_000, intervals: [4000] });
    } else {
      await page.getByTestId('check-review').click();
      await expect(page.getByTestId('review-status')).toContainText('Cleared');
    }
    const rejected = (await page.getByTestId('review-status').innerText()).includes('Rejected');
    const outcome = rejected ? 'REJECTED' : 'CLEARED'; const label = rejected ? 'Rejected' : 'Cleared';
    await expect(page.getByTestId('review-history').getByRole('row').filter({ hasText: 'ICP-REV-' }).first()).toContainText(label);
    await expect(page.getByTestId('submit-review')).toBeVisible();
    // and the register shows the same standing
    await page.goto(`/port-facilities?review=${outcome}`);
    await expect(page.getByRole('row').filter({ hasText: facility.code }).first()).toContainText(label);
  });
});
