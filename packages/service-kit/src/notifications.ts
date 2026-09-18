import * as z from 'zod';

export const NOTIFICATION_AUDIENCES = ['user', 'staff'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

const CATEGORY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export interface NotificationCategoryDefinition {
  description: string;
  disableable?: boolean;
  audience?: NotificationAudience;
}

export interface DeclaredNotification {
  name: string;
  description: string;
  disableable: boolean;
  audience: NotificationAudience;
}

export type NotificationRegistry = Readonly<Record<string, DeclaredNotification>>;

export class NotificationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationDefinitionError';
  }
}

export function isNotificationCategory(name: string): boolean {
  return CATEGORY.test(name);
}

export function defineNotificationCategories<const P extends string>(
  categories: Record<P, NotificationCategoryDefinition>,
): Readonly<Record<P, DeclaredNotification>> {
  const declared: Record<string, DeclaredNotification> = {};
  for (const [name, definition] of Object.entries<NotificationCategoryDefinition>(categories)) {
    if (!isNotificationCategory(name)) {
      throw new NotificationDefinitionError(
        `Notification ${name} must be dotted lowercase words, like support.ticket_updates`,
      );
    }
    if (definition.description.trim() === '') {
      throw new NotificationDefinitionError(`Notification ${name} needs a description`);
    }
    declared[name] = {
      name,
      description: definition.description,
      disableable: definition.disableable ?? true,
      audience: definition.audience ?? 'user',
    };
  }
  return Object.freeze(declared);
}

export const declaredNotificationSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  disableable: z.boolean(),
  audience: z.enum(NOTIFICATION_AUDIENCES),
});

export const NOTIFICATION_ALLOWED_SERVICE = 'identity';
export const NOTIFICATION_ALLOWED_METHOD = 'notification_allowed';

export const notificationAllowedRequestSchema = z.strictObject({
  user_id: z.uuid(),
  category: z.string().min(1),
});

export const notificationAllowedResponseSchema = z.strictObject({
  allowed: z.boolean(),
});

export type NotificationAllowedRequest = z.output<typeof notificationAllowedRequestSchema>;
export type NotificationAllowedResponse = z.output<typeof notificationAllowedResponseSchema>;
