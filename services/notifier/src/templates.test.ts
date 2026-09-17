import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineEmailTemplates, EMAIL_TEMPLATES } from '@qtiauth/email';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  type Brand,
  DEFAULT_TEMPLATES_DIR,
  escapeHtml,
  loadTemplates,
  TemplateError,
} from './templates.ts';

const brand: Brand = {
  product_name: 'Example & Co Account',
  company_name: 'Example Ltd',
  support_email: 'support@example.com',
  primary_color: '#3b82f6',
};

const definitions = defineEmailTemplates({
  welcome: {
    description: 'Welcome',
    category: 'auth',
    priority: 'normal',
    variables: z.object({ name: z.string(), link: z.url() }),
  },
});

const MJML = `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello {{ name }}, welcome to {{ brand.product_name }}</mj-text>
        <mj-button href="{{ link }}" background-color="{{ brand.primary_color }}">Start</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qtiauth-templates-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(root: string, locale: string, files: Record<string, string>) {
  await mkdir(join(root, locale), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(root, locale, name), source);
  }
}

function welcome(overrides: Record<string, string> = {}) {
  return {
    'welcome.subject.txt': 'Welcome to {{ brand.product_name }}, {{ name }}\n',
    'welcome.txt': 'Hello {{ name }}\n\n{{ link }}\n\n{{ brand.company_name }}\n',
    'welcome.mjml': MJML,
    ...overrides,
  };
}

async function load(dirs: string[] = [join(dir, 'defaults'), join(dir, 'overrides')]) {
  return loadTemplates({ definitions, dirs, defaultLocale: 'en-GB', brand });
}

async function issues(dirs?: string[]): Promise<readonly string[]> {
  const error = await load(dirs).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TemplateError);
  return (error as TemplateError).issues;
}

describe('loadTemplates', () => {
  it('renders every part with brand and message variables, escaped for HTML', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    const templates = await load();

    const email = templates.render('welcome', 'en-GB', {
      name: 'Sam <Admin>',
      link: 'https://me.example.com/start?a=1&b=2',
    });

    expect(email.locale).toBe('en-GB');
    expect(email.subject).toBe('Welcome to Example & Co Account, Sam <Admin>');
    expect(email.text).toBe(
      'Hello Sam <Admin>\n\nhttps://me.example.com/start?a=1&b=2\n\nExample Ltd\n',
    );
    expect(email.html).toContain('Hello Sam &lt;Admin&gt;, welcome to Example &amp; Co Account');
    expect(email.html).toContain('href="https://me.example.com/start?a=1&amp;b=2"');
    expect(email.html).toContain('#3b82f6');
    expect(email.html).not.toContain('{{');
  });

  it('keeps variables from starting new header lines in the subject', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    const templates = await load();
    const email = templates.render('welcome', 'en-GB', {
      name: 'Sam\r\nBcc: someone@example.com',
      link: 'https://me.example.com',
    });
    expect(email.subject).toBe('Welcome to Example & Co Account, Sam Bcc: someone@example.com');
  });

  it('lets a file in the overrides replace the built-in file of the same name', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    await write(join(dir, 'overrides'), 'en-GB', { 'welcome.subject.txt': 'Hi {{ name }}' });

    const email = (await load()).render('welcome', 'en-GB', {
      name: 'Sam',
      link: 'https://me.example.com',
    });

    expect(email.subject).toBe('Hi Sam');
    expect(email.text).toContain('Hello Sam');
  });

  it('falls back to the language, then the default locale', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    await write(join(dir, 'overrides'), 'fr', welcome({ 'welcome.subject.txt': 'Bienvenue' }));
    const templates = await load();

    expect(templates.resolveLocale('welcome', 'fr-CA')).toBe('fr');
    expect(templates.resolveLocale('welcome', 'de-DE')).toBe('en-GB');
    expect(templates.locales).toEqual(['en-GB', 'fr']);
    expect(templates.templates).toEqual([{ name: 'welcome', locales: ['en-GB', 'fr'] }]);
  });

  it('refuses a template that uses a variable it is not given', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    await write(join(dir, 'overrides'), 'en-GB', {
      'welcome.txt': 'Hello {{ name }}\n\nYour code is {{ code }}\n',
    });

    expect(await issues()).toEqual([
      `${join(dir, 'overrides', 'en-GB', 'welcome.txt')}:3: {{ code }} isn't a variable of welcome. It can use brand.company_name, brand.primary_color, brand.product_name, brand.support_email, link, name`,
    ]);
  });

  it('refuses malformed placeholders and multi-line subjects', async () => {
    await write(
      join(dir, 'defaults'),
      'en-GB',
      welcome({
        'welcome.subject.txt': 'Welcome\nto {{ Name }}',
        'welcome.txt': 'Hello {{ name }\n',
      }),
    );
    const subject = join(dir, 'defaults', 'en-GB', 'welcome.subject.txt');
    const text = join(dir, 'defaults', 'en-GB', 'welcome.txt');

    expect(await issues()).toEqual([
      `${subject}:2: {{ Name }} isn't a variable reference like {{ link }}`,
      `${text}:1: {{ isn't closed with }}`,
      `${subject}: the subject must be one line`,
    ]);
  });

  it('refuses invalid MJML', async () => {
    await write(
      join(dir, 'defaults'),
      'en-GB',
      welcome({
        'welcome.mjml': '<mjml>\n  <mj-body>\n    <mj-banner />\n  </mj-body>\n</mjml>\n',
      }),
    );
    const found = await issues();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/welcome\.mjml:3: .*mj-banner/);
  });

  it('refuses missing files, unknown templates and stray entries', async () => {
    await write(join(dir, 'defaults'), 'en-GB', welcome());
    await write(join(dir, 'overrides'), 'fr', { 'welcome.txt': 'Bonjour {{ name }}' });
    await write(join(dir, 'overrides'), 'en-GB', {
      'goodbye.txt': 'Bye',
      'welcome.html': '<p>Hi</p>',
    });
    await writeFile(join(dir, 'overrides', 'README.md'), 'Overrides');
    await mkdir(join(dir, 'overrides', 'en_GB'));

    expect(await issues()).toEqual([
      `${join(dir, 'overrides', 'README.md')}: must be a directory named after a locale, like en-GB`,
      `${join(dir, 'overrides', 'en_GB')}: must be a directory named after a locale, like en-GB`,
      `${join(dir, 'overrides', 'en-GB', 'goodbye.txt')}: there's no template named goodbye. Templates: welcome`,
      `${join(dir, 'overrides', 'en-GB', 'welcome.html')}: must be named <template>.mjml, <template>.txt or <template>.subject.txt`,
      'Template welcome in fr is missing welcome.subject.txt, welcome.mjml',
    ]);
  });

  it('needs every template in the default locale', async () => {
    await write(join(dir, 'defaults'), 'fr', welcome());
    expect(await issues()).toEqual(['There are no templates for email.default_locale en-GB']);
  });
});

describe('built-in templates', () => {
  it('has every template in en-GB and they all compile', async () => {
    const templates = await loadTemplates({
      definitions: EMAIL_TEMPLATES,
      dirs: [DEFAULT_TEMPLATES_DIR],
      defaultLocale: 'en-GB',
      brand,
    });
    expect(templates.templates).toEqual(
      Object.keys(EMAIL_TEMPLATES).map((name) => ({ name, locales: ['en-GB'] })),
    );

    const link = 'https://me.example.com/magic-link?token=abc&state=xyz';
    const email = templates.render('magic_link', 'en-GB', { link, expires_in_minutes: 15 });
    expect(email.subject).toBe('Your sign-in link for Example & Co Account');
    expect(email.text).toContain(link);
    expect(email.text).toContain('expires in 15 minutes');
    expect(email.html).toContain(`href="${escapeHtml(link)}"`);
  });
});
