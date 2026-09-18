import { describe, expect, it } from 'vitest';

import { AUDIT_GENESIS_HASH, type AuditRecord, auditRowHash, verifyAuditRows } from './audit.ts';

function record(seq: number, prev_hash: string, action = 'role.updated'): AuditRecord {
  const occurred_at = new Date('2026-01-02T03:04:05.000Z');
  const fields = {
    seq,
    event_id: `event-${String(seq)}`,
    occurred_at,
    actor_type: 'user' as const,
    actor_id: '11111111-1111-4111-8111-111111111111',
    action,
    target_type: 'role',
    target_id: '22222222-2222-4222-8222-222222222222',
    prev_hash,
  };
  return { ...fields, row_hash: auditRowHash(fields) };
}

describe('auditRowHash', () => {
  it('is stable for the same row', () => {
    const first = record(1, AUDIT_GENESIS_HASH);
    expect(auditRowHash(first)).toBe(first.row_hash);
    expect(first.row_hash).toHaveLength(64);
  });

  it('changes when a field changes', () => {
    const row = record(1, AUDIT_GENESIS_HASH);
    expect(auditRowHash({ ...row, action: 'role.deleted' })).not.toBe(row.row_hash);
  });
});

describe('verifyAuditRows', () => {
  it('accepts an empty chain and a linked chain', () => {
    expect(verifyAuditRows([])).toEqual({ ok: true, count: 0 });
    const first = record(1, AUDIT_GENESIS_HASH);
    const second = record(2, first.row_hash, 'role.deleted');
    expect(verifyAuditRows([first, second])).toEqual({ ok: true, count: 2 });
  });

  it('names the first edited row', () => {
    const first = record(1, AUDIT_GENESIS_HASH);
    const second = record(2, first.row_hash);
    const edited = { ...second, action: 'tampered' };
    expect(verifyAuditRows([first, edited])).toEqual({
      ok: false,
      seq: 2,
      event_id: 'event-2',
    });
  });

  it('still verifies after the oldest rows are gone', () => {
    const first = record(1, AUDIT_GENESIS_HASH);
    const second = record(2, first.row_hash);
    const third = record(3, second.row_hash);
    expect(verifyAuditRows([second, third])).toEqual({ ok: true, count: 2 });
  });
});
