import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { contractSchemas } from './contracts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outputPath = path.join(repositoryRoot, 'docs/server-contract/schemas.json');

const patchSchemas = new Set([
  'UpdateMemoryRequest',
  'UpdateTripRequest',
  'UpdateTravelDayRequest',
  'UpdatePlaceVisitRequest',
]);

const definitions = Object.fromEntries(
  Object.entries(contractSchemas).map(([name, schema]) => {
    const jsonSchema = z.toJSONSchema(schema, {
      cycles: 'throw',
      reused: 'inline',
      target: 'draft-2020-12',
    });

    if (patchSchemas.has(name)) {
      Object.assign(jsonSchema, { minProperties: 1 });
    }

    return [name, jsonSchema];
  }),
);

const output = `${JSON.stringify(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/poodlelab/ngrx-offline/blob/main/docs/server-contract/schemas.json',
    title: 'NgRx Offline reference API schemas',
    $defs: definitions,
  },
  null,
  2,
)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '');

  if (current !== output) {
    console.error('Generated contract schemas are stale. Run `pnpm contract:generate`.');
    process.exit(1);
  }
} else {
  await writeFile(outputPath, output);
}
