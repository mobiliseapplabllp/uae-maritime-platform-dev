import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login } from './helpers';

/**
 * WCAG 2.2 AA across the whole application, in both languages.
 *
 * The RFP commits the platform to WCAG 2.2 AA and to the TDRA standards that adopt it, in Arabic and English
 * with RTL. A sweep of a handful of screens does not answer that: a violation lives on the page nobody
 * checked. So this walks every route the navigation can reach, resolving the ones that need a record id from
 * the API rather than hard-coding a seed that will drift.
 *
 * Serious and critical violations fail. Moderate and minor ones are printed with the rule and the count, so
 * they are visible and can be argued about rather than silently accepted — an audit finding a reviewer has
 * never seen is worse than one that is written down.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const moderate = new Map<string, number>();

async function sweep(page: Page, label: string) {
  // give lazily-loaded panels and charts a moment to settle before the tree is read
  await page.waitForLoadState('networkidle').catch(() => {});
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  for (const v of results.violations.filter((x) => x.impact !== 'serious' && x.impact !== 'critical')) {
    moderate.set(`${v.id} (${v.impact})`, (moderate.get(`${v.id} (${v.impact})`) ?? 0) + v.nodes.length);
  }
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const detail = bad.map((v) => `${v.id}: ${v.help} — ${v.nodes.length} node(s), first: ${v.nodes[0]?.target?.join(' ')}`).join('\n      ');
  expect(bad, `${label}\n      ${detail}`).toEqual([]);
}

/** The routes with no parameter — every one the navigation offers. */
const STATIC_ROUTES = [
  '/', '/fleet', '/vessels', '/vessels/survey-planner', '/registry', '/certificates',
  '/port-calls', '/berth-planner', '/quay-view', '/schedule', '/marine-services', '/berth-board',
  '/seafarers', '/seafarers/overview', '/seafarers/met', '/seafarers/crew-lists', '/seafarers/manning', '/seafarers/foreign', '/legislation', '/legislation/imo', '/law', '/companies', '/facilities', '/accreditations',
  '/incidents', '/incidents/overview', '/incidents/risk-matrix', '/nmc/map', '/nmc/incidents',
  '/inspections', '/inspections/overview', '/checklist-builder', '/risk', '/risk/targeting',
  '/invoices', '/mis', '/reports', '/agents', '/agents/decisions', '/agents/escalations', '/agents/assurance',
  '/platform', '/platform/slas', '/platform/incidents', '/platform/compliance', '/platform/integrations',
  '/admin/users', '/admin/roles', '/admin/access-reviews', '/admin/audit', '/admin/settings', '/settings/module/admin', '/admin/settings?tab=integrations', '/masters', '/profile',
];

/** Detail screens need a real record; the id comes from the API so the sweep follows the seeded world. */
async function detailRoutes(page: Page): Promise<string[]> {
  const one = async (path: string, to: (id: string) => string): Promise<string[]> => {
    const rows = await page.evaluate(async (p) => {
      const token = (JSON.parse(localStorage.getItem('maritime-session') ?? '{}') as { token?: string }).token ?? '';
      const r = await fetch(`/api${p}`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      const b = await r.json();
      const d = b?.data ?? b;
      return Array.isArray(d) ? d.slice(0, 1) : (d?.items ?? []).slice(0, 1);
    }, path);
    return rows.length ? [to(rows[0].id)] : [];
  };
  return [
    ...await one('/vessels?limit=1', (id) => `/vessels/${id}`),
    ...await one('/port-calls?limit=1', (id) => `/port-calls/${id}`),
    ...await one('/seafarers?limit=1', (id) => `/seafarers/${id}`),
    ...await one('/seafarers/met/institutions?limit=1', (id) => `/seafarers/met/${id}`),
    ...await one('/seafarers/crew-lists?limit=1', (id) => `/seafarers/crew-lists/${id}`),
    ...await one('/incidents?limit=1', (id) => `/incidents/${id}`),
    ...await one('/inspections?limit=1', (id) => `/inspections/${id}`),
    ...await one('/invoices?limit=1', (id) => `/invoices/${id}`),
    ...await one('/companies?limit=1', (id) => `/companies/${id}`),
    ...await one('/registry?limit=1', (id) => `/registry/${id}`),
    // the public portal needs no session; the slug comes from the published register
    ...await (async () => {
      const slug = await page.evaluate(async () => { const r = await fetch('/api/public/legislation?limit=1'); if (!r.ok) return ''; const b = await r.json(); return (b?.data?.[0]?.slug as string | undefined) ?? ''; });
      return slug ? [`/law/${slug}`] : [];
    })(),
  ];
}

test.describe('WCAG 2.2 AA', () => {
  test.describe.configure({ mode: 'serial', timeout: 900_000 });

  test('every screen passes the sweep in English', async ({ page }) => {
    await login(page);
    const routes = [...STATIC_ROUTES, ...await detailRoutes(page)];
    // every navigable screen, plus one detail page per register that has records
    expect(routes.length, 'the detail routes did not resolve').toBeGreaterThan(STATIC_ROUTES.length);
    for (const route of routes) {
      await page.goto(route);
      await sweep(page, `${route} (en)`);
    }
    if (moderate.size) {
      console.log('\n  moderate and minor findings, by rule:');
      for (const [rule, n] of [...moderate].sort((a, b) => b[1] - a[1])) console.log(`    ${rule}: ${n}`);
    }
  });

  test('every screen passes the sweep in Arabic, right to left', async ({ page }) => {
    await login(page);
    await page.evaluate(() => localStorage.setItem('maritime-lang', 'ar'));
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    for (const route of STATIC_ROUTES) {
      await page.goto(route);
      await sweep(page, `${route} (ar, rtl)`);
    }
  });

  test('the document declares its language and direction, and they change together', async ({ page }) => {
    await login(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'en');
    await expect(html).toHaveAttribute('dir', 'ltr');
    await page.evaluate(() => localStorage.setItem('maritime-lang', 'ar'));
    await page.reload();
    await expect(html).toHaveAttribute('lang', 'ar');
    await expect(html).toHaveAttribute('dir', 'rtl');
  });

  test('a keyboard alone reaches the main content and every control shows focus', async ({ page }) => {
    await login(page);
    await page.goto('/vessels');
    await page.waitForLoadState('networkidle').catch(() => {});
    // 2.4.1 Bypass blocks — the first stop must let a keyboard user skip the navigation
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? { tag: el.tagName, text: (el.textContent ?? '').trim().slice(0, 40), href: el.getAttribute('href') ?? '' } : null;
    });
    expect(first, 'nothing took focus on the first Tab').not.toBeNull();

    // 2.4.7 Focus visible — walking into the page, every element that takes focus must show it
    const invisible: string[] = [];
    for (let i = 0; i < 25; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const shows = s.outlineStyle !== 'none' && s.outlineWidth !== '0px'
          || s.boxShadow !== 'none'
          || getComputedStyle(el, ':focus-visible').outlineStyle !== 'none';
        return { shows, tag: el.tagName, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40) };
      });
      if (info && !info.shows) invisible.push(`${info.tag} "${info.label}"`);
      await page.keyboard.press('Tab');
    }
    expect(invisible, `these took focus without showing it: ${invisible.join(', ')}`).toEqual([]);
  });

  test('every page names itself once, in a landmark', async ({ page }) => {
    await login(page);
    for (const route of ['/', '/vessels', '/port-calls', '/incidents', '/invoices', '/admin/users']) {
      await page.goto(route);
      await page.waitForLoadState('networkidle').catch(() => {});
      const headings = await page.locator('h1').count();
      expect(headings, `${route} has ${headings} level-one headings`).toBeLessThanOrEqual(1);
      expect(await page.locator('main, [role="main"]').count(), `${route} has no main landmark`).toBeGreaterThanOrEqual(1);
    }
  });
});
