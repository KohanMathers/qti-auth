import type { UserClaims } from '@qtiauth/service-kit';
import type { Kysely } from 'kysely';

import { findAccount } from './accounts.ts';
import { type AgeBands, ageBand, ageOn } from './age.ts';
import { latestAssuranceStrength } from './age-assurance.ts';
import type { Database } from './database.ts';
import { loadParentalControls } from './family.ts';
import { iso } from './iso.ts';

export async function userClaims(
  db: Kysely<Database>,
  options: { userId: string; bands: AgeBands; now: Date },
): Promise<UserClaims | null> {
  const account = await findAccount(db, options.userId);
  if (!account || account.state === 'deleted') return null;
  const [parental, strength] = await Promise.all([
    loadParentalControls(db, account.id),
    latestAssuranceStrength(db, account.id),
  ]);
  return {
    id: account.id,
    email: account.email,
    email_verified: account.email_verified_at !== null,
    username: account.username,
    username_updated_at: iso(account.username_updated_at),
    account_state: account.state,
    age_band: ageBand(ageOn(account.date_of_birth, options.now), options.bands),
    age_assurance_strength: strength,
    parental_controls: parental,
    restrictions: [],
  };
}
