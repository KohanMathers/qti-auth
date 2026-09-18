import { randomUUIDv7 } from 'node:crypto';

import type { AgeAssuranceTrigger } from '@qtiauth/config';
import type { Kysely } from 'kysely';

import type { AgeAssuranceStrength, Database } from './database.ts';

export const SELF_DECLARED_PROVIDER = 'self_declared';

export class AgeAssuranceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgeAssuranceError';
  }
}

export interface AgeAssuranceUser {
  id: string;
}

export interface AgeAssuranceContext {
  now: Date;
}

export interface AgeAssuranceResult {
  provider: string;
  strength: AgeAssuranceStrength;
  vendor_reference: string | null;
  completed_at: Date;
}

export type BeginAgeAssurance =
  { status: 'redirect'; url: string } | { status: 'completed'; result: AgeAssuranceResult };

export interface AgeAssuranceProvider {
  id: string;
  strength: AgeAssuranceStrength;
  begin: (user: AgeAssuranceUser, ctx: AgeAssuranceContext) => Promise<BeginAgeAssurance>;
  complete: (
    user: AgeAssuranceUser,
    callbackPayload: unknown,
    ctx: AgeAssuranceContext,
  ) => Promise<AgeAssuranceResult>;
}

export function selfDeclaredProvider(): AgeAssuranceProvider {
  const result = (ctx: AgeAssuranceContext): AgeAssuranceResult => ({
    provider: SELF_DECLARED_PROVIDER,
    strength: 'self_declared',
    vendor_reference: null,
    completed_at: ctx.now,
  });
  return {
    id: SELF_DECLARED_PROVIDER,
    strength: 'self_declared',
    begin: (_user, ctx) => Promise.resolve({ status: 'completed', result: result(ctx) }),
    complete: (_user, _payload, ctx) => Promise.resolve(result(ctx)),
  };
}

export function ageAssuranceProvider(id: string): AgeAssuranceProvider {
  if (id === SELF_DECLARED_PROVIDER) return selfDeclaredProvider();
  throw new AgeAssuranceError(`Unknown age assurance provider: ${id}`);
}

export function assuranceRequiredFor(
  trigger: AgeAssuranceTrigger,
  requiredFor: readonly string[],
): boolean {
  return requiredFor.includes(trigger);
}

export async function recordAgeAssurance(
  db: Kysely<Database>,
  options: {
    userId: string;
    result: AgeAssuranceResult;
    trigger: string;
    now: Date;
  },
): Promise<void> {
  await db
    .insertInto('age_assurance_results')
    .values({
      id: randomUUIDv7(),
      user_id: options.userId,
      provider: options.result.provider,
      strength: options.result.strength,
      trigger: options.trigger,
      vendor_reference: options.result.vendor_reference,
      created_at: options.now,
    })
    .execute();
}

export async function completeAgeAssurance(
  db: Kysely<Database>,
  options: {
    userId: string;
    provider: AgeAssuranceProvider;
    trigger: string;
    now: Date;
  },
): Promise<AgeAssuranceResult> {
  const begun = await options.provider.begin({ id: options.userId }, { now: options.now });
  if (begun.status !== 'completed') {
    throw new AgeAssuranceError(`Age assurance provider ${options.provider.id} did not complete`);
  }
  await recordAgeAssurance(db, {
    userId: options.userId,
    result: begun.result,
    trigger: options.trigger,
    now: options.now,
  });
  return begun.result;
}

export async function recordSignupAgeAssurance(
  db: Kysely<Database>,
  options: {
    userId: string;
    adult: boolean;
    defaultProvider: string;
    requiredFor: readonly string[];
    now: Date;
  },
): Promise<void> {
  await completeAgeAssurance(db, {
    userId: options.userId,
    provider: selfDeclaredProvider(),
    trigger: 'signup',
    now: options.now,
  });
  if (options.adult && assuranceRequiredFor('claim_adult_band', options.requiredFor)) {
    await completeAgeAssurance(db, {
      userId: options.userId,
      provider: ageAssuranceProvider(options.defaultProvider),
      trigger: 'claim_adult_band',
      now: options.now,
    });
  }
}
