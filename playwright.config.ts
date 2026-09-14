import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5193',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      UV_CACHE_DIR: '/tmp/lod-uv-cache',
      LOD_WEB_PORT: '5193',
      LOD_PORT: '8193',
      LOD_API_URL: 'http://127.0.0.1:8193',
      OPENROUTER_API_KEY: '',
    },
  },
});
