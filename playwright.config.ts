import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/qa',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /ipad\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /ipad\.spec/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /ipad\.spec/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /ipad\.spec/ },
    { name: 'iphone', use: { ...devices['iPhone 15'] }, testIgnore: /ipad\.spec/ },
    { name: 'ipad', use: { ...devices['iPad (gen 7)'] }, testMatch: /ipad\.spec/ },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    // Shell values beat .env.local, so neither the local key nor a hosted relay
    // can turn the QA server's chat into a billed request.
    env: { OPENROUTER_API_KEY: '', CHAT_RELAY_URL: '' },
  },
})
