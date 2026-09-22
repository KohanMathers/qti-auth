import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  defineEmailTemplates,
  EMAIL_TEMPLATES,
  EmailTemplateDefinitionError,
  templateVariables,
} from './templates.ts';

const base = { description: 'Test', category: 'auth', priority: 'normal' } as const;

describe('defineEmailTemplates', () => {
  it('lists every variable a template can use, including nested ones', () => {
    const templates = defineEmailTemplates({
      new_device: {
        ...base,
        variables: z.object({
          device: z.object({ browser: z.string(), os: z.string() }),
          signed_in_at: z.iso.datetime(),
          approximate: z.boolean(),
        }),
      },
    });
    expect(templateVariables('new_device', templates.new_device)).toEqual([
      'approximate',
      'device.browser',
      'device.os',
      'signed_in_at',
    ]);
  });

  it('refuses variables that could be missing when an email is sent', () => {
    expect(() =>
      defineEmailTemplates({
        reset: { ...base, variables: z.object({ link: z.string().optional() }) },
      }),
    ).toThrow(
      new EmailTemplateDefinitionError(
        'Template reset variable link must be a required string, number or boolean, not optional',
      ),
    );
    expect(() =>
      defineEmailTemplates({
        reset: { ...base, variables: z.object({ links: z.array(z.url()) }) },
      }),
    ).toThrow(EmailTemplateDefinitionError);
  });

  it('refuses bad names and brand variables', () => {
    expect(() =>
      defineEmailTemplates({ 'Reset-Password': { ...base, variables: z.object({}) } }),
    ).toThrow(EmailTemplateDefinitionError);
    expect(() =>
      defineEmailTemplates({ reset: { ...base, variables: z.object({ Link: z.string() }) } }),
    ).toThrow(EmailTemplateDefinitionError);
    expect(() =>
      defineEmailTemplates({
        reset: { ...base, variables: z.object({ brand: z.object({ name: z.string() }) }) },
      }),
    ).toThrow("Template reset can't declare a brand variable. brand.* comes from config");
  });

  it('sends sign-in emails first', () => {
    expect(EMAIL_TEMPLATES.magic_link).toMatchObject({ category: 'auth', priority: 'high' });
    expect(EMAIL_TEMPLATES.email_verification).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.password_reset).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.email_change).toMatchObject({ category: 'auth', priority: 'high' });
    expect(EMAIL_TEMPLATES.email_change_notice).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.new_device).toMatchObject({ category: 'security', priority: 'high' });
    expect(EMAIL_TEMPLATES.security_alert).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.legal_update).toMatchObject({
      category: 'security',
      priority: 'normal',
    });
    expect(EMAIL_TEMPLATES.data_export).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.data_export_attachment).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.webhook_disabled).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.parental_consent).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.family_access).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_new_app).toMatchObject({
      category: 'security',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_app_approval).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_activity).toMatchObject({
      category: 'auth',
      priority: 'normal',
    });
    expect(EMAIL_TEMPLATES.graduation).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_graduation).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_removal_request).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
    expect(EMAIL_TEMPLATES.guardian_removed).toMatchObject({
      category: 'auth',
      priority: 'high',
    });
  });
});
