import * as z from 'zod';

import { type SectionName, sections } from './sections.ts';

export const qtiauthConfigSchema = z
  .strictObject(sections)
  .describe('QTIAuth configuration (qtiauth.yaml).');

export type QtiauthConfig = z.output<typeof qtiauthConfigSchema>;

export function serviceConfigSchema<const K extends SectionName>(names: readonly K[]) {
  const shape = Object.fromEntries(names.map((name) => [name, sections[name]]));
  return z.object(shape as Pick<typeof sections, K>);
}

export type ServiceConfig<K extends SectionName> = Pick<QtiauthConfig, K>;

export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(qtiauthConfigSchema, { io: 'input', target: 'draft-2020-12' });
}
