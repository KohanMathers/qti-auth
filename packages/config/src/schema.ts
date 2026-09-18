import * as z from 'zod';

import { type SectionName, sections } from './sections.ts';

interface StorageAware {
  storage?: { enabled: boolean };
  features?: {
    games: { cloud_saves: { enabled: boolean } };
    support: { attachments: { enabled: boolean } };
  };
  backups?: { destination: 'directory' | 'storage' };
}

function refineStorageDependencies(value: StorageAware, ctx: z.RefinementCtx): void {
  const storageEnabled = value.storage?.enabled === true;
  if (value.features?.games.cloud_saves.enabled === true && !storageEnabled) {
    ctx.addIssue({
      code: 'custom',
      message: 'Needs storage.enabled',
      path: ['features', 'games', 'cloud_saves', 'enabled'],
    });
  }
  if (value.features?.support.attachments.enabled === true && !storageEnabled) {
    ctx.addIssue({
      code: 'custom',
      message: 'Needs storage.enabled',
      path: ['features', 'support', 'attachments', 'enabled'],
    });
  }
  if (value.backups?.destination === 'storage' && !storageEnabled) {
    ctx.addIssue({
      code: 'custom',
      message: 'Needs storage.enabled',
      path: ['backups', 'destination'],
    });
  }
}

export const qtiauthConfigSchema = z
  .strictObject(sections)
  .superRefine(refineStorageDependencies)
  .describe('QTIAuth configuration (qtiauth.yaml).');

export type QtiauthConfig = z.output<typeof qtiauthConfigSchema>;

export function serviceConfigSchema<const K extends SectionName>(names: readonly K[]) {
  const shape = Object.fromEntries(names.map((name) => [name, sections[name]]));
  return z.object(shape as Pick<typeof sections, K>).superRefine(refineStorageDependencies);
}

export type ServiceConfig<K extends SectionName> = Pick<QtiauthConfig, K>;

export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(qtiauthConfigSchema, { io: 'input', target: 'draft-2020-12' });
}
