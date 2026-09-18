import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CliIo, run } from '@qtiauth/cli';
import { serviceCommands } from '@qtiauth/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { templatesCheck } from './commands.ts';
import { definition, router } from './service.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-notifier-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture() {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    env: {},
  };
  return { io, out };
}

const commands = serviceCommands(definition, router, { 'templates check': templatesCheck });

describe('qtiauth templates check', () => {
  it('is one of the notifier image commands, with migrations', () => {
    expect(Object.keys(commands)).toEqual(
      expect.arrayContaining(['templates check', 'migrate up', 'migrate status']),
    );
  });

  it('prints the templates and locales found next to the config file', async () => {
    const configDir = join(dir, 'valid');
    await mkdir(join(configDir, 'templates/email/fr'), { recursive: true });
    await writeFile(join(configDir, 'qtiauth.yaml'), 'email: { provider: console }\n');
    for (const [file, source] of Object.entries({
      'magic_link.subject.txt': 'Votre lien de connexion',
      'magic_link.txt': '{{ link }}',
      'magic_link.mjml':
        '<mjml><mj-body><mj-section><mj-column><mj-text>{{ link }}</mj-text></mj-column></mj-section></mj-body></mjml>',
    })) {
      await writeFile(join(configDir, 'templates/email/fr', file), source);
    }
    const { io, out } = capture();

    const status = await run(
      ['templates', 'check', '--config', join(configDir, 'qtiauth.yaml')],
      io,
      commands,
    );

    expect(out.stderr).toBe('');
    expect(status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      default_locale: 'en-GB',
      templates: [
        { name: 'magic_link', locales: ['en-GB', 'fr'] },
        { name: 'email_verification', locales: ['en-GB'] },
        { name: 'password_reset', locales: ['en-GB'] },
        { name: 'email_change', locales: ['en-GB'] },
        { name: 'email_change_notice', locales: ['en-GB'] },
        { name: 'new_device', locales: ['en-GB'] },
        { name: 'security_alert', locales: ['en-GB'] },
        { name: 'legal_update', locales: ['en-GB'] },
        { name: 'data_export', locales: ['en-GB'] },
        { name: 'data_export_attachment', locales: ['en-GB'] },
        { name: 'webhook_disabled', locales: ['en-GB'] },
      ],
    });
  });

  it('fails with every problem it finds', async () => {
    const configDir = join(dir, 'invalid');
    await mkdir(join(configDir, 'overrides/en-GB'), { recursive: true });
    await writeFile(
      join(configDir, 'qtiauth.yaml'),
      'email: { provider: console, templates_dir: overrides }\n',
    );
    await writeFile(join(configDir, 'overrides/en-GB/magic_link.txt'), 'Code: {{ code }}\n');
    const { io, out } = capture();

    const status = await run(
      ['templates', 'check', '--config', join(configDir, 'qtiauth.yaml')],
      io,
      commands,
    );

    expect(status).toBe(1);
    expect(out.stderr).toContain(
      `${join(configDir, 'overrides/en-GB/magic_link.txt')}:1: {{ code }} isn't a variable of magic_link`,
    );
  });
});
