import { randomUUID } from 'node:crypto';

import { attachmentObjectKey, type ObjectStore } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import type { Database } from './database.ts';
import { contentDisposition, decodeBase64, sniffAttachment } from './sniff.ts';
import { getTicket } from './tickets.ts';

export interface AttachmentRecord {
  id: string;
  ticket_id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
}

export type AddAttachmentResult =
  | { status: 'ok'; attachment: AttachmentRecord }
  | { status: 'not_found' }
  | { status: 'closed' }
  | { status: 'invalid' };

export function presentedAttachment(row: AttachmentRecord) {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    created_at: row.created_at.toISOString(),
  };
}

export function presentedStaffAttachment(row: AttachmentRecord) {
  return {
    ...presentedAttachment(row),
    warning: !row.content_type.startsWith('image/'),
  };
}

export async function listAttachments(
  db: Kysely<Database>,
  ticketId: string,
): Promise<AttachmentRecord[]> {
  return db
    .selectFrom('ticket_attachments')
    .selectAll()
    .where('ticket_id', '=', ticketId)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function getAttachment(
  db: Kysely<Database>,
  id: string,
): Promise<AttachmentRecord | undefined> {
  return db.selectFrom('ticket_attachments').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function addAttachment(
  db: Kysely<Database>,
  store: ObjectStore,
  options: {
    ticketId: string;
    filename: string;
    content: string;
    maxBytes: number;
    now: Date;
  },
): Promise<AddAttachmentResult> {
  const ticket = await getTicket(db, options.ticketId);
  if (!ticket) return { status: 'not_found' };
  if (ticket.status === 'closed') return { status: 'closed' };
  const bytes = decodeBase64(options.content);
  if (bytes === undefined || bytes.byteLength === 0 || bytes.byteLength > options.maxBytes) {
    return { status: 'invalid' };
  }
  const sniffed = sniffAttachment(bytes);
  if (!sniffed.ok) return { status: 'invalid' };
  const id = randomUUID();
  const key = attachmentObjectKey(ticket.id, id);
  await store.put(key, bytes, sniffed.contentType);
  try {
    const attachment = await db
      .insertInto('ticket_attachments')
      .values({
        id,
        ticket_id: ticket.id,
        object_key: key,
        filename: options.filename,
        content_type: sniffed.contentType,
        size_bytes: bytes.byteLength,
        created_at: options.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { status: 'ok', attachment };
  } catch (error) {
    await store.delete(key);
    throw error;
  }
}

export async function signAttachmentDownload(
  store: ObjectStore,
  attachment: AttachmentRecord,
  ttlMs: number,
  now: Date,
): Promise<{ url: string; expiresAt: Date }> {
  const expiresSeconds = Math.max(1, Math.round(ttlMs / 1000));
  const url = await store.presignGet(attachment.object_key, expiresSeconds, {
    contentType: attachment.content_type,
    contentDisposition: contentDisposition(attachment.filename),
  });
  return { url, expiresAt: new Date(now.getTime() + expiresSeconds * 1000) };
}
