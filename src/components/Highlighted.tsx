/** Text with the characters at `positions` marked (fuzzy match results). */
export function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  const parts: React.ReactNode[] = [];
  let run = '';
  let marked = false;
  const flush = (key: number) => {
    if (run) parts.push(marked ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  // Positions index UTF-16 code units (as String.prototype.indexOf does).
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== marked) {
      flush(i);
      marked = m;
    }
    run += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}
