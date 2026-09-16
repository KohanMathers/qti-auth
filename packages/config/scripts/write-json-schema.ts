import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configJsonSchema } from '../src/schema.ts';

export const JSON_SCHEMA_PATH = join(import.meta.dirname, '../../../config/qtiauth.schema.json');

export function renderJsonSchema(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}

if (import.meta.main) {
  writeFileSync(JSON_SCHEMA_PATH, renderJsonSchema());
  process.stdout.write(`Wrote ${JSON_SCHEMA_PATH}\n`);
}
