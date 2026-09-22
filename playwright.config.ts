import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  projects: [
    { name: 'upgrade', testMatch: /upgrade\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:5183' } },
    { name: 'pending', testMatch: /pending\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:5184' } },
    {
      name: 'dashboard',
      testMatch: /dashboard\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5185' },
    },
  ],
  webServer: [
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-upgrade RUNCOACH_PORT=3110 VITE_API_TARGET=http://127.0.0.1:3110 VITE_WEB_PORT=5183 pnpm dev:e2e',
      url: 'http://127.0.0.1:5183/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-pending RUNCOACH_PORT=3111 VITE_API_TARGET=http://127.0.0.1:3111 VITE_WEB_PORT=5184 pnpm dev:e2e',
      url: 'http://127.0.0.1:5184/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-dashboard RUNCOACH_PORT=3112 VITE_API_TARGET=http://127.0.0.1:3112 VITE_WEB_PORT=5185 pnpm dev:e2e',
      url: 'http://127.0.0.1:5185/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: { trace: 'retain-on-failure' },
});
