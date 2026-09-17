import { blockSet, type WordLists } from './lists.ts';

export interface AuditHit {
  word: string;
  matched: string;
}

export function auditLists(lists: WordLists): AuditHit[] {
  const blocked = [...blockSet(lists)].toSorted(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const hits: AuditHit[] = [];
  for (const word of [...lists.dictionary].toSorted((a, b) => a.localeCompare(b))) {
    for (const matched of blocked) {
      if (matched !== '' && word.includes(matched) && word !== matched) {
        hits.push({ word, matched });
        break;
      }
    }
  }
  return hits;
}
