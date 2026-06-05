import { execSync } from 'node:child_process'

export default function setup(): void {
  execSync('pnpm exec prisma db push --skip-generate --force-reset', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
  })
}
