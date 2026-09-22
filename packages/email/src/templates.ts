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

const linkVariables = z.object({
  link: z.url({ protocol: /^https?$/ }),
  expires_in_minutes: z.int().min(1),
});

export const EMAIL_TEMPLATES = defineEmailTemplates({
  magic_link: {
    description: 'A magic link to sign in or finish signing up',
    category: 'auth',
    priority: 'high',
    variables: linkVariables,
  },
  email_verification: {
    description: 'Confirm an email address after signing up with a password',
    category: 'auth',
    priority: 'high',
    variables: linkVariables,
  },
  password_reset: {
    description: 'A link to choose a new password',
    category: 'security',
    priority: 'high',
    variables: linkVariables,
  },
  email_change: {
    description: 'Confirm a new email address',
    category: 'auth',
    priority: 'high',
    variables: linkVariables,
  },
  email_change_notice: {
    description: 'A notice to the previous address after an email change, with a revert link',
    category: 'security',
    priority: 'high',
    variables: z.object({
      link: z.url({ protocol: /^https?$/ }),
      expires_in_days: z.int().min(1),
    }),
  },
  new_device: {
    description: 'A notice that the account signed in from a new browser or OS',
    category: 'security',
    priority: 'high',
    variables: z.object({
      browser: z.string().min(1),
      os: z.string().min(1),
      place: z.string().min(1),
    }),
  },
  security_alert: {
    description: 'A rate-limited alert that session security saw something unusual',
    category: 'security',
    priority: 'high',
    variables: z.object({
      summary: z.string().min(1),
      place: z.string().min(1),
    }),
  },
  legal_update: {
    description: 'A notice that a non-material legal document version has taken effect',
    category: 'security',
    priority: 'normal',
    variables: z.object({
      document_id: z.string().min(1),
      version: z.string().min(1),
      summary: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  data_export: {
    description: 'A download link for a requested account data export',
    category: 'security',
    priority: 'high',
    variables: z.object({
      link: z.url({ protocol: /^https?$/ }),
      expires_in_days: z.int().min(1),
    }),
  },
  data_export_attachment: {
    description: 'An account data export sent as an email attachment when object storage is off',
    category: 'security',
    priority: 'high',
    variables: z.object({
      filename: z.string().min(1),
    }),
  },
  webhook_disabled: {
    description: 'An outbound webhook endpoint was disabled after consecutive failures',
    category: 'security',
    priority: 'high',
    variables: z.object({
      description: z.string().min(1),
      host: z.string().min(1),
      failures: z.int().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  parental_consent: {
    description: 'Ask a parent or guardian to approve a child account',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      approve_link: z.url({ protocol: /^https?$/ }),
      decline_link: z.url({ protocol: /^https?$/ }),
      children_summary_link: z.url({ protocol: /^https?$/ }),
      expires_in_days: z.int().min(1),
    }),
  },
  family_access: {
    description: 'Magic link to the family dashboard, with or without a full account',
    category: 'auth',
    priority: 'high',
    variables: linkVariables,
  },
  family_invite: {
    description: 'Invite another parent or guardian to a child account',
    category: 'auth',
    priority: 'high',
    variables: linkVariables,
  },
  guardian_new_device: {
    description: 'Tell a parent or guardian about a new-device sign-in on a child account',
    category: 'security',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
      browser: z.string().min(1),
      os: z.string().min(1),
      place: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_new_app: {
    description: 'Tell a parent or guardian that a child connected a new app',
    category: 'security',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
      app_name: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_legal_update: {
    description: 'Tell a parent or guardian that a legal document for a child account changed',
    category: 'security',
    priority: 'high',
    variables: z.object({
      document_id: z.string().min(1),
      version: z.string().min(1),
      summary: z.string().min(1),
      material: z.boolean(),
      link: z.url({ protocol: /^https?$/ }),
      family_link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_username_change: {
    description: 'Ask a parent or guardian to approve a child’s username change',
    category: 'auth',
    priority: 'normal',
    variables: z.object({
      username: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_app_approval: {
    description: 'Ask a parent or guardian to approve a child connecting an app',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
      app_name: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_activity: {
    description: 'Weekly activity summary for a parent or guardian',
    category: 'auth',
    priority: 'normal',
    variables: z.object({
      username: z.string().min(1),
      sign_ins: z.int().min(0),
      connected_apps: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  graduation: {
    description: 'Tell a young person they have reached the parental-consent age',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      grace_days: z.int().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_graduation: {
    description: 'Tell a parent or guardian that a child has reached the parental-consent age',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
      grace_days: z.int().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_removal_request: {
    description: 'Ask a parent or guardian to approve removing their link to a young person',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
      link: z.url({ protocol: /^https?$/ }),
    }),
  },
  guardian_removed: {
    description: 'Tell a parent or guardian that their link to a young person has ended',
    category: 'auth',
    priority: 'high',
    variables: z.object({
      username: z.string().min(1),
    }),
  },
  safety_report_received: {
    description: 'Confirm to a reporter that a safety report was received',
    category: 'support',
    priority: 'normal',
    variables: z.object({
      reference: z.string().min(1),
      type: z.string().min(1),
      product_name: z.string().min(1),
      support_email: z.string().min(1),
    }),
  },
  safety_report_outcome: {
    description: 'Tell a reporter the outcome of a safety report',
    category: 'support',
    priority: 'normal',
    variables: z.object({
      reference: z.string().min(1),
      outcome: z.string().min(1),
      product_name: z.string().min(1),
      support_email: z.string().min(1),
    }),
  },
});

export type EmailTemplates = typeof EMAIL_TEMPLATES;
export type EmailTemplateName = keyof EmailTemplates;
export type EmailVariables<T extends EmailTemplateName> = z.input<EmailTemplates[T]['variables']>;
