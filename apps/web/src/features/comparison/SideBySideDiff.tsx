import type { DiffLine } from '../changes/diff-lines';

export interface AlignedDiffRow { left?: DiffLine; right?: DiffLine; leftNotes?: string[]; rightNotes?: string[]; wide?: DiffLine }
const eofMarker = (line: DiffLine) => !line.oldLine && !line.newLine && line.text === '\\ No newline at end of file';
/** Pair replacement runs even when Git attaches an EOF marker to either side. */
export function alignDiffLines(lines: DiffLine[]): AlignedDiffRow[] {
  const rows: AlignedDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.type === 'removed' || line.type === 'added') {
      const left: { line: DiffLine; notes: string[] }[] = []; const right: { line: DiffLine; notes: string[] }[] = [];
      let last: { line: DiffLine; notes: string[] } | undefined;
      while (index < lines.length) {
        const change = lines[index]!;
        if (change.type === 'removed' || change.type === 'added') {
          last = { line: change, notes: [] }; (change.type === 'removed' ? left : right).push(last); index++;
        } else if (eofMarker(change) && last) { last.notes.push(change.text); index++; }
        else break;
      }
      for (let row = 0; row < Math.max(left.length, right.length); row++) rows.push({ left: left[row]?.line, right: right[row]?.line, leftNotes: left[row]?.notes, rightNotes: right[row]?.notes });
    } else {
      index++;
      const previous = rows.at(-1);
      if (eofMarker(line) && previous && (previous.left || previous.right)) {
        if (previous.left) previous.leftNotes = [...(previous.leftNotes || []), line.text];
        if (previous.right) previous.rightNotes = [...(previous.rightNotes || []), line.text];
      } else if (line.type === 'context' && (line.oldLine || line.newLine)) rows.push({ left: line.oldLine ? line : undefined, right: line.newLine ? line : undefined });
      else rows.push({ wide: line });
    }
  }
  return rows;
}
export function SideBySideDiff({ rows, beforeLabel, afterLabel }: { rows: AlignedDiffRow[]; beforeLabel: string; afterLabel: string }) {
  return <div className="split-code-table"><div className="split-labels"><span>{beforeLabel}</span><span>{afterLabel}</span></div>{rows.map((row, index) => row.wide ? <div key={index} className={`code-line split-meta ${row.wide.type}`}><code>{row.wide.text || ' '}</code></div> : <div key={index} className="split-row">{(['left', 'right'] as const).map(side => {
    const line = row[side]; const notes = side === 'left' ? row.leftNotes : row.rightNotes;
    return <div key={side} className={`code-line split-cell ${line?.type || 'gap'}`}><span className="line-number" aria-hidden="true">{side === 'left' ? line?.oldLine : line?.newLine}</span><div className="split-content"><code>{line?.text || ' '}</code>{notes?.map((note, noteIndex) => <code className="split-note" key={noteIndex}>{note}</code>)}</div></div>;
  })}</div>)}</div>;
}
