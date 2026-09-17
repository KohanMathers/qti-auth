import type { TextFilter } from '@qtiauth/text-filter';

import { contextAttachment } from './attachments.ts';

const attachment = contextAttachment<TextFilter>();

export const attachTextFilter = attachment.attach;
export const textFilterOf = attachment.of;
