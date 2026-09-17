import { domainToASCII } from 'node:url';

import type { QtiauthConfig } from '@qtiauth/config';

export type EmailNormalization = QtiauthConfig['accounts']['email_normalization'];

export function emailNormalizer(rules: EmailNormalization): (address: string) => string {
  const byDomain = new Map(
    Object.entries(rules).map(([domain, rule]) => [domain.toLowerCase(), rule]),
  );
  return (address) => {
    const trimmed = address.trim().normalize('NFC');
    const at = trimmed.lastIndexOf('@');
    let local = trimmed.slice(0, at).toLowerCase();
    const rawDomain = trimmed
      .slice(at + 1)
      .replace(/\.$/, '')
      .toLowerCase();
    let domain = domainToASCII(rawDomain) || rawDomain;

    const rule = byDomain.get(domain);
    if (rule) {
      if (rule.subaddress_separator !== null) {
        const index = local.indexOf(rule.subaddress_separator);
        if (index > 0) local = local.slice(0, index);
      }
      if (rule.remove_dots) local = local.replaceAll('.', '');
      if (rule.domain !== null) domain = rule.domain.toLowerCase();
    }
    return `${local}@${domain}`;
  };
}
