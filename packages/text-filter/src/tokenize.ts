function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function tokenize(raw: string): string[] {
  if (raw === '') return [];
  const camel = raw
    .replace(/([a-z\d])([A-Z])/g, '$1\0$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1\0$2');
  const tokens: string[] = [];
  for (const part of camel.split('\0')) {
    let i = 0;
    while (i < part.length) {
      const char = part[i];
      if (char === undefined) break;
      if (char === '_') {
        i += 1;
        continue;
      }
      if (isDigit(char)) {
        let j = i + 1;
        while (j < part.length && isDigit(part[j] ?? '')) j += 1;
        tokens.push(part.slice(i, j));
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < part.length) {
        const next = part[j];
        if (next === undefined || next === '_' || isDigit(next)) break;
        j += 1;
      }
      tokens.push(part.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

export function collapseSingletons(tokens: readonly string[]): string[] {
  const collapsed: string[] = [];
  let run = '';
  const flush = () => {
    if (run !== '') {
      collapsed.push(run);
      run = '';
    }
  };
  for (const token of tokens) {
    if (token.length === 1) {
      run += token;
      continue;
    }
    flush();
    collapsed.push(token);
  }
  flush();
  return collapsed;
}
