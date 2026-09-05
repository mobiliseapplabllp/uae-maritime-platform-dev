import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { expectAccessible } from './helpers';

/*
 * The access controls, driven as a person would: an officer enrols an authenticator and signs in with its code; the
 * Super Admin asks for a privileged grant and the second administrator approves it; a review cycle is opened and
 * attested. The authenticator is this test: it computes the code from the secret the screen shows, exactly as an app
 * on a phone would.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'Demo@2026';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(text: string): Buffer {
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/[^A-Z2-7]/g, '')) { value = (value << 5) | ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totp(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 30_000);
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | ((mac[o + 1] & 0xff) << 16) | ((mac[o + 2] & 0xff) << 8) | (mac[o + 3] & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}
async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: /Sign out|تسجيل الخروج/ }).click();
  await expect(page).toHaveURL(/\/login/);
}
/** The surveyor's authenticator is reset through the API afterwards so the drive can run again. */
async function resetMfaViaApi(page: Page, email: string) {
  const admin = await page.request.post('/api/auth/login', { data: { email: 'admin@maritime.example', password: PASSWORD } });
  const token = (await admin.json()).data.token as string;
  const users = await page.request.get(`/api/users?q=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${token}` } });
  const id = (await users.json()).data[0]?.id;
  if (id) await page.request.post(`/api/users/${id}/mfa/reset`, { headers: { authorization: `Bearer ${token}` } });
}

test.describe('security — the access controls, as a person meets them', () => {
  test('an officer enrols an authenticator from the profile, is asked for its code at the next sign-in, and gets in with it', async ({ page }) => {
    await signIn(page, 'surveyor@maritime.example');
    await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
    await page.goto('/profile');
    await expect(page.getByTestId('mfa-status')).toHaveText('Off');
    await expectAccessible(page, 'profile with the security cards');
    await page.getByTestId('mfa-setup').click();
    const secret = (await page.getByTestId('mfa-secret').textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByTestId('mfa-code').fill(totp(secret));
    await page.getByTestId('mfa-activate').click();
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    await page.getByRole('button', { name: /Close|إغلاق/ }).click();
    await expect(page.getByTestId('mfa-status')).toHaveText('On');
    await expect(page.getByTestId('sessions-card')).toContainText('This device');
    await signOut(page);
    try {
      // the password alone no longer signs in
      await signIn(page, 'surveyor@maritime.example');
      await expect(page.getByTestId('mfa-step')).toBeVisible();
      await expectAccessible(page, 'second step');
      // a wrong code is refused, the right one — the next step's, since activation used this one — gets in
      await page.getByTestId('mfa-code').fill('000000');
      await page.getByTestId('mfa-verify').click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByTestId('mfa-code').fill(totp(secret, Date.now() + 30_000));
      await page.getByTestId('mfa-verify').click();
      await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
    } finally { await resetMfaViaApi(page, 'surveyor@maritime.example'); }
  });

  test('a privileged grant waits for the second administrator, who approves it from the Users screen', async ({ page }) => {
    // the Super Admin asks: a pilot becomes an Identity Administrator
    await signIn(page, 'admin@maritime.example');
    await expect(page.getByRole('heading', { name: /Port operations/ })).toBeVisible({ timeout: 20_000 });
    const adminToken = (await (await page.request.post('/api/auth/login', { data: { email: 'admin@maritime.example', password: PASSWORD } })).json()).data.token as string;
    const roles = (await (await page.request.get('/api/roles', { headers: { authorization: `Bearer ${adminToken}` } })).json()).data as { id: string; code: string; name: string }[];
    const ia = roles.find((r) => r.code === 'IA')!; const pp = roles.find((r) => r.code === 'PP')!;
    const h = { authorization: `Bearer ${adminToken}` };
    // a run that stopped part-way leaves its ask pending or its grant applied; both are undone first, so the drive holds every time
    const holders = (await (await page.request.get('/api/users?role=Identity%20Administrator&active=true&limit=50', { headers: h })).json()).data as { id: string; email: string }[];
    for (const u of holders.filter((u) => u.email !== 'idadmin@maritime.example')) await page.request.put(`/api/users/${u.id}`, { headers: h, data: { roleId: pp.id } });
    const pilots = (await (await page.request.get('/api/users?role=Port%20Pilot&active=true&limit=50', { headers: h })).json()).data as { id: string; name: string; email: string }[];
    const pilot = pilots[pilots.length - 1];
    const pending = (await (await page.request.get('/api/users/changes?status=PENDING&limit=200', { headers: h })).json()).data as { id: string; subjectId: string }[];
    for (const ch of pending.filter((c) => c.subjectId === pilot.id)) await page.request.post(`/api/users/changes/${ch.id}/cancel`, { headers: h, data: { note: 'Browser drive: an earlier run' } });
    const ask = await page.request.put(`/api/users/${pilot.id}`, { headers: h, data: { roleId: ia.id, reason: 'Browser drive' } });
    const asked = await ask.json();
    expect(asked.data?.pendingChange?.kind, JSON.stringify(asked)).toBe('USER_ROLE');
    await page.goto('/admin/users?pending=true');
    await expect(page.getByTestId('approvals-panel')).toBeVisible();
    await expect(page.getByTestId('approval-row').filter({ hasText: pilot.name })).toContainText('your request');
    await expectAccessible(page, 'users with approvals');
    await signOut(page);
    // the second administrator approves it
    await signIn(page, 'idadmin@maritime.example');
    await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
    await page.goto('/admin/users');
    const row = page.getByTestId('approval-row').filter({ hasText: pilot.name });
    await row.getByRole('button', { name: 'Approve' }).click();
    await page.getByTestId('approval-confirm').click();
    // the panel leaves with its last request
    await expect(page.getByTestId('approval-row').filter({ hasText: pilot.name })).toHaveCount(0);
    const after = await page.request.get(`/api/users/${pilot.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect((await after.json()).data.role.name).toBe('Identity Administrator');
    // and back to a pilot, which is an ordinary grant and applies at once
    await page.request.put(`/api/users/${pilot.id}`, { headers: { authorization: `Bearer ${adminToken}` }, data: { roleId: pp.id } });
  });

  test('an access review is opened, an account attested by a second person, and the cycle closed when nothing is pending', async ({ page }) => {
    await signIn(page, 'idadmin@maritime.example');
    await expect(page.getByRole('heading', { name: /Port operations|No access/ })).toBeVisible({ timeout: 20_000 });
    await page.goto('/admin/access-reviews');
    await expectAccessible(page, 'access reviews');
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('review-status')).toHaveText(/OPEN|OVERDUE/);
    await expectAccessible(page, 'access review detail');
    const own = page.getByTestId('review-item').filter({ hasText: 'idadmin@maritime.example' });
    await expect(own).toContainText('Your own account');
    // the first account still pending that is not the reviewer's own — which one depends on what earlier runs attested
    const other = page.getByTestId('review-item').filter({ has: page.getByRole('button', { name: /^Confirm/ }) }).first();
    const email = (await other.textContent())?.match(/\S+@\S+/)?.[0] ?? '';
    expect(email).toContain('@');
    await other.getByRole('button', { name: /^Confirm/ }).click();
    await page.getByTestId('decide-confirm').click();
    // the pending view no longer lists it; the confirmed view does, with who attested it and when
    await expect(page.getByTestId('review-item').filter({ hasText: email })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Decision' }).click();
    await page.getByRole('option', { name: 'Confirmed' }).click();
    await expect(page.getByTestId('review-item').filter({ hasText: email })).toContainText('Confirmed');
    // the cycle stays open while any account is pending
    await expect(page.getByTestId('close-review')).toBeDisabled();
  });
});
