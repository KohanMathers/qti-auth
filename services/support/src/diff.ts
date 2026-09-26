const LCS_LINE_LIMIT = 400;

function lineDiff(before: readonly string[], after: readonly string[]): string[] {
  if (before.length > LCS_LINE_LIMIT || after.length > LCS_LINE_LIMIT) {
    return [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
  }
  const width = after.length + 1;
  const scores = new Uint32Array((before.length + 1) * width);
  const at = (row: number, column: number) => row * width + column;
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      scores[at(row, column)] =
        before[row] === after[column]
          ? (scores[at(row + 1, column + 1)] ?? 0) + 1
          : Math.max(scores[at(row + 1, column)] ?? 0, scores[at(row, column + 1)] ?? 0);
    }
  }
  const lines: string[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      lines.push(` ${before[row] ?? ''}`);
      row += 1;
      column += 1;
    } else if ((scores[at(row + 1, column)] ?? 0) >= (scores[at(row, column + 1)] ?? 0)) {
      lines.push(`-${before[row] ?? ''}`);
      row += 1;
    } else {
      lines.push(`+${after[column] ?? ''}`);
      column += 1;
    }
  }
  while (row < before.length) {
    lines.push(`-${before[row] ?? ''}`);
    row += 1;
  }
  while (column < after.length) {
    lines.push(`+${after[column] ?? ''}`);
    column += 1;
  }
  return lines;
}

export function unifiedDiff(before: string, after: string): string {
  return lineDiff(before.split('\n'), after.split('\n')).join('\n');
}

export function revisionDocument(revision: {
  title: string;
  slug: string;
  status: string;
  category_id: string;
  tags: readonly string[];
  body: string;
}): string {
  return [
    `title: ${revision.title}`,
    `slug: ${revision.slug}`,
    `status: ${revision.status}`,
    `category: ${revision.category_id}`,
    `tags: ${revision.tags.join(' ')}`,
    '',
    revision.body,
  ].join('\n');
}
