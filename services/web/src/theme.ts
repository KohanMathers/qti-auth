import type { QtiauthConfig } from '@qtiauth/config';

const CSS_COLOR = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?$/;

export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

export type ThemeInput = Pick<QtiauthConfig, 'branding'>;

function assertColor(name: string, value: string): void {
  if (!CSS_COLOR.test(value)) {
    throw new ThemeError(`branding.colors.${name} ${value} is not a valid CSS color`);
  }
}

function colorLines(colors: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(colors)) {
    assertColor(name, value);
    const slug = name.replaceAll('_', '-');
    lines.push(`  --qt-color-${slug}: ${value};`);
    if (name === 'primary') lines.push(`  --qtiauth-color-primary: ${value};`);
  }
  return lines;
}

function backgroundLines(backgrounds: Record<string, string | null> | undefined): string[] {
  if (backgrounds === undefined) return [];
  const lines: string[] = [];
  for (const [name, value] of Object.entries(backgrounds)) {
    const slug = name.replaceAll('_', '-');
    lines.push(
      value === null
        ? `  --qt-bg-${slug}: none;`
        : `  --qt-bg-${slug}: url(${JSON.stringify(value)});`,
    );
  }
  return lines;
}

export function themeCss(config: ThemeInput): string {
  const branding = config.branding as unknown as {
    colors: Record<string, string>;
    backgrounds?: Record<string, string | null>;
  };
  const lines = [
    ':root {',
    ...colorLines(branding.colors),
    ...backgroundLines(branding.backgrounds),
    '  --qtiauth-color-bg: #ffffff;',
    '  --qtiauth-color-fg: #1a1a1a;',
    '  --qtiauth-color-muted: #5a5a5a;',
    '  --qtiauth-color-surface: #f5f5f5;',
    '  --qtiauth-color-border: #d4d4d4;',
    '  --qtiauth-color-danger: #b42318;',
    '  --qtiauth-color-focus: var(--qtiauth-color-primary);',
    '}',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    '    --qtiauth-color-bg: #0e0e10;',
    '    --qtiauth-color-fg: #f0f0f0;',
    '    --qtiauth-color-muted: #a3a3a3;',
    '    --qtiauth-color-surface: #1a1a1c;',
    '    --qtiauth-color-border: #333336;',
    '    --qtiauth-color-danger: #ff6b6b;',
    '  }',
    '}',
    '[data-theme="dark"] {',
    '  color-scheme: dark;',
    '  --qtiauth-color-bg: #0e0e10;',
    '  --qtiauth-color-fg: #f0f0f0;',
    '  --qtiauth-color-muted: #a3a3a3;',
    '  --qtiauth-color-surface: #1a1a1c;',
    '  --qtiauth-color-border: #333336;',
    '  --qtiauth-color-danger: #ff6b6b;',
    '}',
    '[data-theme="light"] {',
    '  color-scheme: light;',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

export function themeResponse(config: ThemeInput): Response {
  return new Response(themeCss(config), {
    status: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=300, must-revalidate',
    },
  });
}
