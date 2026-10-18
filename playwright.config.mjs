import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/web',
  timeout: 180_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: 'http://127.0.0.1:8765/8D/', acceptDownloads: true },
  webServer: { command: 'node tests/serve.mjs', url: 'http://127.0.0.1:8765/8D/', reuseExistingServer: !process.env.CI },
});
