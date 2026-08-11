import { spawn, spawnSync } from 'node:child_process';

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const migration = spawnSync(command, ['api:migrate:local'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const worker = spawn(
  command,
  [
    'exec',
    'wrangler',
    'dev',
    '--config',
    'apps/demo-api/wrangler.jsonc',
    '--ip',
    '127.0.0.1',
    '--port',
    '8787',
    '--var',
    'SECRET_HASH_KEY:e2e-only-not-a-production-secret',
    '--show-interactive-dev-session',
    'false',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => worker.kill(signal));
}
worker.on('exit', (code) => process.exit(code ?? 0));
