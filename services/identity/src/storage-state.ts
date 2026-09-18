import type { ObjectStore } from '@qtiauth/service-kit';

import { contextAttachment } from './attachments.ts';

const attachment = contextAttachment<ObjectStore | null>();
export const attachObjectStore = attachment.attach;
export const objectStoreOf = attachment.of;
