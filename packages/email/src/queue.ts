import { randomUUID } from 'node:crypto';

import { type Bus, publishWork, workSubject } from '@qtiauth/bus';
import * as z from 'zod';

import {
  EMAIL_TEMPLATES,
  type EmailPriority,
  type EmailTemplateName,
  type EmailVariables,
} from './templates.ts';

export const EMAIL_SERVICE = 'notifier';

export function emailQueue(priority: EmailPriority): string {
  return `email.${priority}`;
}

export const emailJobSchema = z.object({
  delivery_id: z.uuid(),
  template: z.string().min(1),
  locale: z.string().min(1),
  to: z.object({
    address: z.email(),
    name: z.string().min(1).nullable(),
  }),
  user_id: z.uuid().nullable(),
  variables: z.record(z.string(), z.unknown()),
  queued_at: z.iso.datetime(),
});

export type EmailJob = z.output<typeof emailJobSchema>;

export interface QueueEmailRequest<T extends EmailTemplateName> {
  template: T;
  to: { address: string; name?: string | null };
  locale: string;
  userId?: string | null;
  variables: EmailVariables<T>;
}

export class EmailRequestError extends Error {
  readonly issues: readonly string[];

  constructor(template: string, issues: readonly string[]) {
    super(`Invalid ${template} email: ${issues.join(', ')}`);
    this.name = 'EmailRequestError';
    this.issues = issues;
  }
}

function canonicalLocale(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

function describeIssues(error: z.ZodError, prefix: PropertyKey[] = []): string[] {
  return error.issues.map(
    (issue) => `${[...prefix, ...issue.path].map(String).join('.')}: ${issue.message}`,
  );
}

export function createEmailJob<T extends EmailTemplateName>(
  request: QueueEmailRequest<T>,
  now: Date = new Date(),
): EmailJob {
  const definition = EMAIL_TEMPLATES[request.template] as
    (typeof EMAIL_TEMPLATES)[EmailTemplateName] | undefined;
  if (!definition) {
    throw new EmailRequestError(request.template, ['template: Unknown template']);
  }
  const issues: string[] = [];
  const variables = definition.variables.safeParse(request.variables);
  if (!variables.success) issues.push(...describeIssues(variables.error, ['variables']));
  const locale = canonicalLocale(request.locale);
  if (locale === undefined) issues.push('locale: Must be a locale like en-GB');

  const job = emailJobSchema.safeParse({
    delivery_id: randomUUID(),
    template: request.template,
    locale: locale ?? request.locale,
    to: { address: request.to.address, name: request.to.name ?? null },
    user_id: request.userId ?? null,
    variables: variables.success ? variables.data : {},
    queued_at: now.toISOString(),
  });
  if (!job.success) issues.push(...describeIssues(job.error));
  if (issues.length > 0 || !job.success) throw new EmailRequestError(request.template, issues);
  return job.data;
}

export async function queueEmail<T extends EmailTemplateName>(
  bus: Bus,
  request: QueueEmailRequest<T>,
): Promise<EmailJob> {
  const job = createEmailJob(request);
  const { priority } = EMAIL_TEMPLATES[request.template];
  await publishWork(bus.js, workSubject(EMAIL_SERVICE, emailQueue(priority)), job, {
    id: job.delivery_id,
  });
  return job;
}
