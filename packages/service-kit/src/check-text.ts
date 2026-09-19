import * as z from 'zod';

export const CHECK_TEXT_SERVICE = 'identity';
export const CHECK_TEXT_METHOD = 'check_text';

export const checkTextRequestSchema = z.strictObject({
  text: z.string().min(1).max(2000),
  context: z.string().min(1).max(64),
});

export const checkTextResponseSchema = z.strictObject({
  decision: z.enum(['allow', 'block']),
});

export type CheckTextRequest = z.output<typeof checkTextRequestSchema>;
export type CheckTextResponse = z.output<typeof checkTextResponseSchema>;
