import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const local = process.argv.includes('--local');
const entryPoints = ['primary', 'core', 'indexeddb', 'worker', 'testing'];

for (const entryPoint of entryPoints) {
  const args = [
    'exec',
    'api-extractor',
    'run',
    '--config',
    `config/api-extractor/${entryPoint}.json`,
  ];

  if (local) {
    args.push('--local');
  }

  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
