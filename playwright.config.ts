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
    { name: 'trends', testMatch: /trends\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:5186' } },
    {
      name: 'calendar',
      testMatch: /calendar\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5187' },
    },
    {
      name: 'daily-status',
      testMatch: /daily-status\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5188' },
    },
    { name: 'review', testMatch: /review\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:5189' } },
    {
      name: 'review-disabled',
      testMatch: /review-disabled\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:5190' },
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
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-trends RUNCOACH_PORT=3113 VITE_API_TARGET=http://127.0.0.1:3113 VITE_WEB_PORT=5186 pnpm dev:e2e',
      url: 'http://127.0.0.1:5186/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-calendar RUNCOACH_PORT=3114 VITE_API_TARGET=http://127.0.0.1:3114 VITE_WEB_PORT=5187 pnpm dev:e2e',
      url: 'http://127.0.0.1:5187/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-daily-status RUNCOACH_PORT=3115 VITE_API_TARGET=http://127.0.0.1:3115 VITE_WEB_PORT=5188 pnpm dev:e2e',
      url: 'http://127.0.0.1:5188/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Local mock provider (no real key) so the review project exercises the
      // real server adapter, config, fingerprint guards, and UI end to end.
      command: 'node e2e/mock-deepseek.mjs',
      url: 'http://127.0.0.1:3117/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-review RUNCOACH_PORT=3116 VITE_API_TARGET=http://127.0.0.1:3116 VITE_WEB_PORT=5189 RUNCOACH_AI_ENABLED=true RUNCOACH_AI_PROVIDER=deepseek RUNCOACH_DEEPSEEK_API_KEY=e2e-mock-key RUNCOACH_DEEPSEEK_BASE_URL=http://127.0.0.1:3117 RUNCOACH_AI_TIMEOUT_MS=10000 pnpm dev:e2e',
      url: 'http://127.0.0.1:5189/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // The AI env path is pinned off and the provider points at the local
      // mock so the UI-configured-key flow can be tested without any real
      // key or network call.
      command:
        'cross-env RUNCOACH_DATA_DIR=../../.e2e-data-review-disabled RUNCOACH_PORT=3118 VITE_API_TARGET=http://127.0.0.1:3118 VITE_WEB_PORT=5190 RUNCOACH_AI_ENABLED=false RUNCOACH_DEEPSEEK_API_KEY= RUNCOACH_DEEPSEEK_BASE_URL=http://127.0.0.1:3117 pnpm dev:e2e',
      url: 'http://127.0.0.1:5190/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  use: { trace: 'retain-on-failure' },
});
