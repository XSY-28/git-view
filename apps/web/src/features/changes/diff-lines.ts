export interface DiffLine { text: string; type: 'context' | 'hunk' | 'meta' | 'note' | 'added' | 'removed'; oldLine: string; newLine: string }

/** A hunk's leading +/- is content syntax even when the source also begins with ++/--. */
export function parseDiffLines(text: string, format: 'diff' | 'text' | 'unavailable'): DiffLine[] {
  if (!text || format === 'unavailable') return [];
  let old = 0; let next = 0; let inHunk = false;
  // A final newline terminates the preceding line; it is not an extra source line.
  const values = text.split('\n');
  if (values.at(-1) === '') values.pop();
  return values.map((value, index) => {
    let type: DiffLine['type'] = 'context'; let oldLine = ''; let newLine = '';
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(value);
    if (format === 'text') newLine = String(index + 1);
    else if (value.startsWith('diff --git ')) { inHunk = false; type = 'meta'; }
    else if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; type = 'hunk'; }
    else if (!inHunk) type = 'meta';
    else if (value === '\\ No newline at end of file') type = 'note';
    else if (inHunk && value.startsWith('+')) { type = 'added'; newLine = String(next++); }
    else if (inHunk && value.startsWith('-')) { type = 'removed'; oldLine = String(old++); }
    else if (inHunk && value.startsWith(' ')) { oldLine = String(old++); newLine = String(next++); }
    return { text: value, type, oldLine, newLine };
  });
}
