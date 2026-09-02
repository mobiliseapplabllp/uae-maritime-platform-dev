// Parity screenshots: drives the reference demo and the new web app through the same routes and writes
// side-by-side PNGs so UI/UX drift is visible. Usage:
//   node e2e/parity.mjs (from apps/web) --ref http://127.0.0.1:5301 --new http://127.0.0.1:5300 --out .local/parity [--routes /,/berth-board]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const REF = arg('--ref', 'http://127.0.0.1:5301'); const NEW = arg('--new', 'http://127.0.0.1:5300'); const OUT = arg('--out', '.local/parity');
const ROUTES = arg('--routes', '/login,/,/berth-board,/admin/users,/admin/roles,/admin/audit,/admin/settings,/masters,/masters/berths,/masters/tariffs,/profile').split(',');
const EXEC = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(OUT, { recursive: true });

async function drive(base, tag, hashRouter) {
  const browser = await chromium.launch({ executablePath: EXEC });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const url = (r) => (hashRouter ? `${base}/#${r}` : `${base}${r}`);
  await page.goto(url('/login'), { waitUntil: 'networkidle' });
  const roleBtn = page.getByText('Super Admin', { exact: true }).first();
  await roleBtn.click();
  await page.waitForTimeout(2500);
  for (const r of ROUTES) {
    if (r === '/login') { const p = await browser.newPage({ viewport: { width: 1440, height: 900 } }); await p.goto(url('/login'), { waitUntil: 'networkidle' }); await p.waitForTimeout(800); await p.screenshot({ path: join(OUT, `${tag}${r.replace(/\//g, '_') || '_home'}.png`), fullPage: true }); await p.close(); continue; }
    await page.goto(url(r), { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: join(OUT, `${tag}${r.replace(/\//g, '_') || '_home'}.png`), fullPage: true });
    console.log(tag, r, 'ok');
  }
  await browser.close();
}
await drive(REF, 'ref', true).catch((e) => console.error('ref failed', e.message));
await drive(NEW, 'new', false).catch((e) => console.error('new failed', e.message));
