import type { QtiauthConfig } from '@qtiauth/config';

const CSS_COLOR = /^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{2})?)?$/;

export class ThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeError';
  }
}

export type ThemeInput = Pick<QtiauthConfig, 'branding'>;

export function themeCss(config: ThemeInput): string {
  const primary = config.branding.colors.primary;
  if (!CSS_COLOR.test(primary)) {
    throw new ThemeError(`branding.colors.primary ${primary} is not a valid CSS color`);
  }
  const lines = [
    ':root {',
    `  --qtiauth-color-primary: ${primary};`,
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
