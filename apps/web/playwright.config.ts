import { defineConfig, devices } from '@playwright/test';

/* Functional drives run against the Vite dev server proxied to the local gateway (services started with infra/local/services.sh). */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:5300', trace: 'retain-on-failure', screenshot: 'only-on-failure', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } }],
  webServer: process.env.E2E_NO_SERVER ? undefined : { command: 'pnpm dev', url: 'http://127.0.0.1:5300', reuseExistingServer: true, timeout: 60_000 },
});
