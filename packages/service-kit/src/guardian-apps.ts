import * as z from 'zod';

export const GUARDIAN_APPS_SERVICE = 'oidc';
export const PENDING_APP_APPROVALS_METHOD = 'pending_app_approvals';
export const DECIDE_APP_APPROVAL_METHOD = 'decide_app_approval';
export const CONNECTED_APPS_METHOD = 'connected_apps';

export const pendingAppApprovalsRequestSchema = z.strictObject({
  user_id: z.uuid(),
});

export const pendingAppApprovalSchema = z.strictObject({
  id: z.uuid(),
  client_id: z.string().min(1),
  name: z.string().min(1),
  scopes: z.array(z.string().min(1)),
  created_at: z.iso.datetime(),
});

export const pendingAppApprovalsResponseSchema = z.strictObject({
  items: z.array(pendingAppApprovalSchema),
});

export const decideAppApprovalRequestSchema = z.strictObject({
  user_id: z.uuid(),
  request_id: z.uuid(),
  approve: z.boolean(),
});

export const decideAppApprovalResponseSchema = z.strictObject({
  status: z.enum(['approved', 'declined', 'not_found']),
});

export const connectedAppsRequestSchema = z.strictObject({
  user_id: z.uuid(),
  since: z.iso.datetime(),
  until: z.iso.datetime(),
});

export const connectedAppSchema = z.strictObject({
  client_id: z.string().min(1),
  name: z.string().min(1),
  granted_at: z.iso.datetime(),
});

export const connectedAppsResponseSchema = z.strictObject({
  items: z.array(connectedAppSchema),
});

export type PendingAppApprovalsRequest = z.output<typeof pendingAppApprovalsRequestSchema>;
export type PendingAppApproval = z.output<typeof pendingAppApprovalSchema>;
export type PendingAppApprovalsResponse = z.output<typeof pendingAppApprovalsResponseSchema>;
export type DecideAppApprovalRequest = z.output<typeof decideAppApprovalRequestSchema>;
export type DecideAppApprovalResponse = z.output<typeof decideAppApprovalResponseSchema>;
export type ConnectedAppsRequest = z.output<typeof connectedAppsRequestSchema>;
export type ConnectedApp = z.output<typeof connectedAppSchema>;
export type ConnectedAppsResponse = z.output<typeof connectedAppsResponseSchema>;
