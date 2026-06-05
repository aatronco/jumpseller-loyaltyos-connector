import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { DATABASE_URL: 'file:./test.db' },
    globalSetup: './tests/setup/global-setup.ts',
  },
})
