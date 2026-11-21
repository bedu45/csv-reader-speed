// Fast drop-in for csv-reader 1.0.0 (v2).
// Same semantics as vendor/csv-reader/index.js, but:
//  - whole records with no quotes and no stray CR are split with indexOf
//    for ',' only (the common case in the generator: most records are plain);
//  - other fields use indexOf jumps + slice instead of char-by-char concat;
//  - readUnquoted is kept only for the rare stray-CR / quote-junk /
//    unterminated-quote paths.
// Single pass, left to right. No cache between calls, no state kept.
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;
  const delimRe = /[,\n\r]/g;
  const breakRe = /[\n\r]/g;

  function normQuoted(start, end) {
    // Fast: no LF/CR in [start,end) -> slice, line unchanged (one regex search).
    breakRe.lastIndex = start;
    const m = breakRe.exec(text);
    if (m === null || m.index >= end) return text.slice(start, end);
    // Segment holds a line break: fall back to the exact counting/conversion.
    const cr = text.indexOf('\r', start);
    if (cr === -1 || cr >= end) {
      let n = 0;
      let i = m.index;
      while (i !== -1 && i < end) { n++; i = text.indexOf('\n', i + 1); }
      line += n;
      return text.slice(start, end);
    }
    const str = text.slice(start, end).replace(/\r\n?/g, '\n');
    let n = 0;
    let i = str.indexOf('\n');
    while (i !== -1) { n++; i = str.indexOf('\n', i + 1); }
    line += n;
    return str;
  }

  // Rare path only: unquoted field with stray CRs, quote junk, or
  // unterminated-quote re-read. Returns [value, ended, added].
  function readUnquoted(val, added) {
    while (pos < len) {
      delimRe.lastIndex = pos;
      const m = delimRe.exec(text);
      if (m === null) {
        if (pos < len) { val += text.slice(pos); added += len - pos; }
        pos = len;
        return [val, 2, added];
      }
      const end = m.index;
      const ch = m[0];
      if (ch === '\r') {
        if (end + 1 < len && text.charCodeAt(end + 1) === 10) {
          if (end > pos) { val += text.slice(pos, end); added += end - pos; }
          pos = end + 2; line += 1;
          return [val, 1, added];
        }
        if (end > pos) { val += text.slice(pos, end); added += end - pos; }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos = end + 1;
        continue;
      }
      if (ch === ',') {
        if (end > pos) { val += text.slice(pos, end); added += end - pos; }
        pos = end + 1;
        return [val, 0, added];
      }
      // LF
      if (end > pos) { val += text.slice(pos, end); added += end - pos; }
      pos = end + 1; line += 1;
      return [val, 1, added];
    }
    return [val, 2, added];
  }

  while (true) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;

    // ---- fast record path: no '"' and no stray CR up to the next LF ----
    let lf = text.indexOf('\n', pos);
    const hasLf = lf !== -1;
    if (!hasLf) lf = len;
    const contentEnd = (hasLf && lf > pos && text.charCodeAt(lf - 1) === 13) ? lf - 1 : lf;
    const qpos = text.indexOf('"', pos);
    let fast = false;
    if ((qpos === -1 || qpos >= lf)) {
      const crp = text.indexOf('\r', pos);
      if (crp === -1 || crp >= contentEnd) fast = true;
    }
    if (fast) {
      let start = pos;
      while (true) {
        const comma = text.indexOf(',', start);
        if (comma === -1 || comma >= contentEnd) {
          fields.push(text.slice(start, contentEnd));
          break;
        }
        fields.push(text.slice(start, comma));
        start = comma + 1;
      }
      pos = hasLf ? lf + 1 : len;
      if (hasLf) line += 1;
      quoted = false;
    } else {
      // ---- slow path: field by field ----
      let ended = 2;
      while (true) {
        let value;
        if (pos < len && text.charCodeAt(pos) === 34) {
          quoted = true;
          const open = pos;
          const openLine = line;
          let start = pos + 1;
          let val = '';
          let parts = null;
          let closed = false;
          let unterminated = false;
          while (true) {
            const q = text.indexOf('"', start);
            if (q === -1) { unterminated = true; break; }
            if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
              const seg = normQuoted(start, q);
              if (parts === null) parts = [seg, '"'];
              else { parts.push(seg); parts.push('"'); }
              start = q + 2;
              continue;
            }
            const seg = normQuoted(start, q);
            if (parts === null) val = seg;
            else { parts.push(seg); val = parts.join(''); }
            pos = q + 1;
            closed = true;
            break;
          }
          if (unterminated) {
            pos = open + 1; line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const r = readUnquoted('"', 0);
            value = r[0]; ended = r[1];
          } else if (!closed) {
            value = val; ended = 2;
          } else if (pos >= len) {
            value = val; ended = 2;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) { pos += 1; value = val; ended = 0; }
            else if (c === 10) { pos += 1; line += 1; value = val; ended = 1; }
            else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; value = val; ended = 1; }
            else {
              const r = readUnquoted(val, 0);
              if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r[0]; ended = r[1];
            }
          }
        } else {
          quoted = false;
          // Inline plain unquoted field via one regex search for the next delimiter.
          delimRe.lastIndex = pos;
          const m = delimRe.exec(text);
          if (m === null) {
            value = text.slice(pos); pos = len; ended = 2;
          } else {
            const end = m.index;
            const ch = m[0];
            if (ch === ',') {
              value = text.slice(pos, end); pos = end + 1; ended = 0;
            } else if (ch === '\n') {
              value = text.slice(pos, end); pos = end + 1; line += 1; ended = 1;
            } else if (end + 1 < len && text.charCodeAt(end + 1) === 10) {
              value = text.slice(pos, end); pos = end + 2; line += 1; ended = 1;
            } else {
              const r = readUnquoted('', 0);
              value = r[0]; ended = r[1];
            }
          }
        }
        fields.push(value);
        if (ended !== 0) break;
      }
    }

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
