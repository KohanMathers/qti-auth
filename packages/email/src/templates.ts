import * as z from 'zod';

export const EMAIL_CATEGORIES = ['auth', 'security', 'support'] as const;
export type EmailCategory = (typeof EMAIL_CATEGORIES)[number];

export const EMAIL_PRIORITIES = ['high', 'normal'] as const;
export type EmailPriority = (typeof EMAIL_PRIORITIES)[number];

export const BRAND_VARIABLES = [
  'brand.product_name',
  'brand.company_name',
  'brand.support_email',
  'brand.primary_color',
] as const;

export interface EmailTemplateDefinition {
  description: string;
  category: EmailCategory;
  priority: EmailPriority;
  variables: z.ZodObject;
}

export class EmailTemplateDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailTemplateDefinitionError';
  }
}

const TEMPLATE_NAME = /^[a-z][a-z0-9_]*$/;
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const SCALAR_TYPES = new Set(['string', 'number', 'boolean']);

function leafPaths(schema: z.ZodType, prefix: string, template: string): string[] {
  const { def } = schema._zod;
  if (def.type === 'object') {
    return Object.entries((schema as z.ZodObject).shape as Record<string, z.ZodType>).flatMap(
      ([key, child]) => {
        if (!VARIABLE_NAME.test(key)) {
          throw new EmailTemplateDefinitionError(
            `Template ${template} variable ${prefix}${key} must be lowercase letters, digits and _`,
          );
        }
        return leafPaths(child, `${prefix}${key}.`, template);
      },
    );
  }
  if (!SCALAR_TYPES.has(def.type)) {
    throw new EmailTemplateDefinitionError(
      `Template ${template} variable ${prefix.slice(0, -1)} must be a required string, number or boolean, not ${def.type}`,
    );
  }
  return [prefix.slice(0, -1)];
}

export function templateVariables(name: string, definition: EmailTemplateDefinition): string[] {
  return leafPaths(definition.variables, '', name).sort();
}

export function defineEmailTemplates<const T extends Record<string, EmailTemplateDefinition>>(
  templates: T,
): T {
  for (const [name, definition] of Object.entries(templates)) {
    if (!TEMPLATE_NAME.test(name)) {
      throw new EmailTemplateDefinitionError(
        `Template name ${name} must be lowercase letters, digits and _`,
      );
    }
    if ('brand' in definition.variables.shape) {
      throw new EmailTemplateDefinitionError(
        `Template ${name} can't declare a brand variable. brand.* comes from config`,
      );
    }
    templateVariables(name, definition);
  }
  return templates;
}

export const EMAIL_TEMPLATES = defineEmailTemplates({
  magic_link: {
    description: 'A magic link to sign in or finish signing up',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      link: z.url({ protocol: /^https?$/ }),
      expires_in_minutes: z.int().min(1),
    }),
  },
});

export type EmailTemplates = typeof EMAIL_TEMPLATES;
export type EmailTemplateName = keyof EmailTemplates;
export type EmailVariables<T extends EmailTemplateName> = z.input<EmailTemplates[T]['variables']>;
