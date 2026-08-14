/**
 * The lexical ground the source-invariant censuses stand on.
 *
 * Both `query-write-loop-census.test.ts` and
 * `reply-inside-transaction-census.test.ts` scan the server's own source
 * by counting braces, and brace counting only works over text whose
 * comments and string literals have been blanked first: the SQL these
 * files carry is full of braces (`'{}'::jsonb`, `${array}`), and counting
 * those loses the nesting. The function was born inline in the write-loop
 * census; it moved here verbatim when the second census needed it, so the
 * two scans cannot drift apart on what "code" means.
 */

/**
 * The source with every comment and string literal blanked to spaces,
 * line structure intact. Template literals are blanked whole, expressions
 * included, which keeps the braces balanced.
 */
export function blankNonCode(source: string): string {
  let out = '';
  let index = 0;
  // Each open template literal, and the `${` depth inside it.
  const templates: number[] = [];
  while (index < source.length) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (templates.length === 0 && character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (templates.length === 0 && character === '/' && next === '*') {
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += '  ';
      index += 2;
      continue;
    }
    if (templates.length === 0 && (character === "'" || character === '"')) {
      const quote = character;
      out += ' ';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          out += ' ';
          index += 1;
        }
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += ' ';
      index += 1;
      continue;
    }
    if (character === '`') {
      if (templates.length > 0 && templates[templates.length - 1] === 0)
        templates.pop();
      else templates.push(0);
      out += ' ';
      index += 1;
      continue;
    }
    if (templates.length > 0) {
      const depth = templates[templates.length - 1] ?? 0;
      if (character === '$' && next === '{') {
        templates[templates.length - 1] = depth + 1;
        out += '  ';
        index += 2;
        continue;
      }
      if (character === '}' && depth > 0) {
        templates[templates.length - 1] = depth - 1;
      }
      out += character === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}
