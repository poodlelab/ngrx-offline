import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = path.join(repositoryRoot, 'dist', 'ngrx-offline');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
}

function capture(command, args, cwd) {
  return run(command, args, cwd, { stdio: ['ignore', 'pipe', 'pipe'] });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

run(pnpm, ['exec', 'publint', packageDirectory, '--strict'], repositoryRoot);
// Angular Package Format is ESM-only; CommonJS and legacy Node 10 resolution
// are intentionally outside the supported package contract.
run(
  pnpm,
  [
    'exec',
    'attw',
    '--pack',
    packageDirectory,
    '--profile',
    'esm-only',
    '--ignore-rules',
    'internal-resolution-error',
  ],
  repositoryRoot,
);

const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'ngrx-offline-package-'));
const consumerDirectories = [];

try {
  run(pnpm, ['pack', '--pack-destination', artifactDirectory], packageDirectory);
  const artifacts = await readdir(artifactDirectory);
  const archive = artifacts.find((file) => file.endsWith('.tgz'));
  assert(archive !== undefined, 'The package build did not produce an npm tarball.');
  const archivePath = path.join(artifactDirectory, archive);

  const archiveFiles = capture('tar', ['-tzf', archivePath], repositoryRoot)
    .trim()
    .split('\n')
    .filter(Boolean);
  const permittedArtifact =
    /^package\/(?:LICENSE|README\.md|package\.json|fesm2022\/[^/]+\.mjs(?:\.map)?|types\/[^/]+\.d\.ts)$/;
  const unexpected = archiveFiles.filter((file) => !permittedArtifact.test(file));
  assert(unexpected.length === 0, `Unexpected files in the npm artifact: ${unexpected.join(', ')}`);
  assert(
    archiveFiles.every(
      (file) =>
        !/(?:^|\/)(?:e2e|fixtures?|tests?|__tests__)(?:\/|$)|\.spec\.|\.dev\.vars/.test(file),
    ),
    'The npm artifact contains a fixture, test, or development-secret file.',
  );

  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  assert(manifest.sideEffects === false, 'The package must declare sideEffects: false.');
  const expectedExports = ['.', './core', './indexeddb', './testing', './worker'];
  for (const entryPoint of expectedExports) {
    assert(manifest.exports?.[entryPoint]?.types, `Missing type export for ${entryPoint}.`);
    assert(manifest.exports?.[entryPoint]?.default, `Missing ESM export for ${entryPoint}.`);
  }

  const primaryBundle = await readFile(
    path.join(packageDirectory, 'fesm2022', 'poodlelab-ngrx-offline.mjs'),
    'utf8',
  );
  assert(
    primaryBundle.includes('ɵɵngDeclareInjectable'),
    'The Angular entry point is not partially compiled.',
  );
  for (const entryPoint of ['core', 'worker']) {
    const bundle = await readFile(
      path.join(packageDirectory, 'fesm2022', `poodlelab-ngrx-offline-${entryPoint}.mjs`),
      'utf8',
    );
    assert(
      !bundle.includes('@angular/') && !bundle.includes('@ngrx/'),
      `The ${entryPoint} bundle unexpectedly contains Angular or NgRx imports.`,
    );
  }

  run('tar', ['-xzf', archivePath, '-C', artifactDirectory], repositoryRoot);
  const textualFiles = archiveFiles.filter((file) => /\.(?:mjs|map|d\.ts|md|json)$/.test(file));
  for (const file of textualFiles) {
    const contents = await readFile(path.join(artifactDirectory, file), 'utf8');
    assert(
      !contents.includes('e2e-only-not-a-production-secret') &&
        !contents.includes('SECRET_HASH_KEY'),
      `A development secret marker leaked into ${file}.`,
    );
  }
  const compatibilityTargets = [
    {
      name: 'minimum',
      angular: '21.0.0',
      ngrx: '21.0.0',
    },
    {
      name: 'current',
      angular: '21.2.19',
      ngrx: '21.1.1',
    },
  ];

  for (const target of compatibilityTargets) {
    const consumerDirectory = await mkdtemp(
      path.join(tmpdir(), `ngrx-offline-consumer-${target.name}-`),
    );
    consumerDirectories.push(consumerDirectory);
    await createConsumer(consumerDirectory, archivePath, target);
    run(
      pnpm,
      ['install', '--ignore-workspace', '--frozen-lockfile=false', '--reporter=silent'],
      consumerDirectory,
    );
    run(pnpm, ['exec', 'tsc'], consumerDirectory);

    const bundlePath = path.join(consumerDirectory, 'tree-shaken.mjs');
    const metafilePath = path.join(consumerDirectory, 'tree-shaken-meta.json');
    run(
      pnpm,
      [
        'exec',
        'esbuild',
        path.join(consumerDirectory, 'tree-shake.ts'),
        '--bundle',
        '--format=esm',
        '--platform=browser',
        '--target=es2022',
        `--outfile=${bundlePath}`,
        `--metafile=${metafilePath}`,
      ],
      repositoryRoot,
    );
    const bundle = await readFile(bundlePath, 'utf8');
    const meta = JSON.parse(await readFile(metafilePath, 'utf8'));
    const bundledInputs = Object.keys(meta.inputs ?? {});
    assert(
      !bundledInputs.some((input) => input.includes('/@angular/') || input.includes('/@ngrx/')),
      `The ${target.name} core-only consumer pulled Angular or NgRx into its bundle.`,
    );
    assert(
      Buffer.byteLength(bundle) < 20_000,
      `The ${target.name} core-only bundle exceeded the 20 kB release-candidate budget.`,
    );
  }
} finally {
  await Promise.all([
    rm(artifactDirectory, { force: true, recursive: true }),
    ...consumerDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
  ]);
}

async function createConsumer(directory, archivePath, target) {
  const consumerPackage = {
    name: `ngrx-offline-package-consumer-${target.name}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@angular/common': target.angular,
      '@angular/core': target.angular,
      '@ngrx/effects': target.ngrx,
      '@ngrx/store': target.ngrx,
      '@poodlelab/ngrx-offline': `file:${archivePath}`,
      rxjs: '7.8.2',
      typescript: '5.9.3',
    },
  };
  const tsconfig = {
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      noEmit: true,
      types: [],
    },
    files: ['index.ts'],
  };
  const consumerSource = [
    "import { createOfflineMutation, defineOfflineOperation, provideOfflineOutbox } from '@poodlelab/ngrx-offline';",
    "import { offlineRef } from '@poodlelab/ngrx-offline/core';",
    "import { IndexedDbOperationRepository } from '@poodlelab/ngrx-offline/indexeddb';",
    "import { EngineTestHarness } from '@poodlelab/ngrx-offline/testing';",
    "import { WorkerOutboxExecutor } from '@poodlelab/ngrx-offline/worker';",
    '',
    'const operation = defineOfflineOperation<{ clientId: string }, { id: number }>({',
    "  kind: 'consumer.customer-create',",
    '  version: 1,',
    "  request: (input) => ({ method: 'POST', url: '/customers', body: input }),",
    '  parseResult: (response) => response.body as { id: number },',
    '});',
    "const mutation = createOfflineMutation(operation, { source: 'Consumer' });",
    'const providers = provideOfflineOutbox(() => ({',
    "  databaseName: 'consumer-outbox',",
    '  mutations: [mutation],',
    "  scope: () => 'consumer-pool',",
    '}));',
    "const repository = new IndexedDbOperationRepository({ databaseName: 'consumer-outbox' });",
    "const reference = offlineRef('customer', 'client-customer-1');",
    'void [providers, repository, reference];',
    'void EngineTestHarness;',
    'void WorkerOutboxExecutor;',
    '',
  ].join('\n');
  const treeShakeSource = [
    "import { offlineRef } from '@poodlelab/ngrx-offline/core';",
    "console.log(offlineRef('customer', 'client-customer-1'));",
    '',
  ].join('\n');

  await Promise.all([
    writeFile(
      path.join(directory, 'package.json'),
      `${JSON.stringify(consumerPackage, null, 2)}\n`,
    ),
    writeFile(path.join(directory, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`),
    writeFile(path.join(directory, 'index.ts'), consumerSource),
    writeFile(path.join(directory, 'tree-shake.ts'), treeShakeSource),
  ]);
}
