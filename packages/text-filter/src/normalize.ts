import { mapConfusables } from './confusables.ts';

const MARKS = /\p{M}+/gu;

function stripZwAndBidi(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (
      code === 0x00ad ||
      code === 0x034f ||
      code === 0x061c ||
      code === 0x180e ||
      code === 0xfeff ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      continue;
    }
    out += char;
  }
  return out;
}

const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

function applyLeet(value: string): string {
  let mapped = '';
  for (const char of value) mapped += LEET[char] ?? char;
  return mapped;
}

export function normalize(raw: string): string {
  const nfkc = stripZwAndBidi(raw.normalize('NFKC'));
  const skeleton = mapConfusables(nfkc.normalize('NFD').replace(MARKS, '')).normalize('NFC');
  return applyLeet(skeleton.toLowerCase());
}
