export {
  createEmailJob,
  EMAIL_SERVICE,
  type EmailJob,
  emailJobSchema,
  emailQueue,
  EmailRequestError,
  queueEmail,
  type QueueEmailRequest,
} from './queue.ts';
export { escapeHtml } from './html.ts';
export { canonicalLocale, isCanonicalLocale } from './locale.ts';
export {
  BRAND_VARIABLES,
  defineEmailTemplates,
  EMAIL_CATEGORIES,
  EMAIL_PRIORITIES,
  EMAIL_TEMPLATES,
  type EmailCategory,
  type EmailPriority,
  type EmailTemplateDefinition,
  EmailTemplateDefinitionError,
  type EmailTemplateName,
  type EmailTemplates,
  type EmailVariables,
  templateVariables,
} from './templates.ts';
