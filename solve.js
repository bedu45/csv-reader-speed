// Fast drop-in for csv-reader 1.0.0 (v8).
// Single pass, left to right, no regex, no split, one flat function.
//  - quote-free records: indexOf(',') loop (as v3b);
//  - in quoted records, runs of unquoted fields are taken in bulk: a run
//    ends at the next ',"' or the line end, found with one indexOf, and its
//    fields are cut with the same indexOf(',') loop as the fast path;
//  - quoted fields: indexOf('"') jumps; escapes are tracked during the
//    scan, and line breaks inside the value are converted/counted once,
//    after the field closes;
//  - stray CRs are rare: a line known to hold one falls back to a
//    per-field read (readUnquoted) for that line only.
// No cache between calls, no state kept.
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

  // Rare path only: read one unquoted field (stray CR, quote junk,
  // unterminated quote). Returns [value, ended, added]:
  // ended 0 = comma, 1 = line break, 2 = end of text.
  function readUnquoted(val, added) {
    while (pos < len) {
      const comma = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      const cr = text.indexOf('\r', pos);
      let end = len, kind = 2;
      if (comma !== -1 && comma < end) { end = comma; kind = 0; }
      if (nl !== -1 && nl < end) { end = nl; kind = 1; }
      if (cr !== -1 && cr < end) { end = cr; kind = 3; }
      if (end > pos) { val += text.slice(pos, end); added += end - pos; pos = end; }
      if (kind === 2) return [val, 2, added];
      if (kind === 0) { pos += 1; return [val, 0, added]; }
      if (kind === 1) { pos += 1; line += 1; return [val, 1, added]; }
      if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; return [val, 1, added]; }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos += 1;
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

    // ---- record end + fast-path checks ----
    let lf = text.indexOf('\n', pos);
    const hasLf = lf !== -1;
    if (!hasLf) lf = len;
    const contentEnd = (hasLf && lf > pos && text.charCodeAt(lf - 1) === 13) ? lf - 1 : lf;
    const qpos = text.indexOf('"', pos);
    // Bounded stray-CR check: only the record's own span can hold one.
    // (An unbounded indexOf('\r', pos) would scan far past the record
    // into later records whenever this record holds no CR.)
    const hasStrayCR = text.slice(pos, contentEnd).indexOf('\r') !== -1;
    let fast = false;
    if ((qpos === -1 || qpos >= lf) && !hasStrayCR) fast = true;

    if (fast) {
      let start = pos;
      while (true) {
        const comma = text.indexOf(',', start);
        if (comma === -1 || comma >= contentEnd) { fields.push(text.slice(start, contentEnd)); break; }
        fields.push(text.slice(start, comma));
        start = comma + 1;
      }
      pos = hasLf ? lf + 1 : len;
      if (hasLf) line += 1;
      quoted = false;
    } else {
      // ---- slow path ----
      let lineEnd = lf;              // next LF at/after the current line
      let lineContentEnd = contentEnd;
      let lineStray = hasStrayCR;
      let ended = 2;
      while (true) {
        let value;
        if (pos < len && text.charCodeAt(pos) === 34) {
          // Quoted field.
          quoted = true;
          const open = pos;
          const openLine = line;
          let start = pos + 1;
          let val = '';
          let parts = null;
          let closed = false;
          while (true) {
            const q = text.indexOf('"', start);
            if (q === -1) break;
            if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
              const seg = text.slice(start, q);
              if (parts === null) parts = [seg, '"'];
              else { parts.push(seg); parts.push('"'); }
              start = q + 2;
              continue;
            }
            const seg = text.slice(start, q);
            if (parts === null) val = seg;
            else { parts.push(seg); val = parts.join(''); }
            pos = q + 1;
            closed = true;
            break;
          }
          if (!closed) {
            pos = open + 1; line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            const r = readUnquoted('"', 0);
            value = r[0]; ended = r[1];
          } else {
            // Line breaks inside the value become LF; count them.
            const hasNL = val.indexOf('\n') !== -1;
            const hasCR = val.indexOf('\r') !== -1;
            if (hasNL || hasCR) {
              if (!hasCR) {
                let cnt = 0, idx = -1;
                while ((idx = val.indexOf('\n', idx + 1)) !== -1) cnt++;
                line += cnt;
              } else {
                const conv = val.replace(/\r\n?/g, '\n');
                let cnt = 0, idx = -1;
                while ((idx = conv.indexOf('\n', idx + 1)) !== -1) cnt++;
                line += cnt;
                val = conv;
              }
            }
            if (pos >= len) { value = val; ended = 2; }
            else {
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
          }
        } else {
          // Unquoted field(s).
          quoted = false;
          if (pos >= lineEnd) {
            lineEnd = text.indexOf('\n', pos);
            if (lineEnd === -1) lineEnd = len;
            lineContentEnd = (lineEnd < len && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) ? lineEnd - 1 : lineEnd;
            const cr = text.indexOf('\r', pos);
            lineStray = cr !== -1 && cr < lineContentEnd;
          }
          if (lineStray) {
            const r = readUnquoted('', 0);
            value = r[0]; ended = r[1];
          } else {
            // Bulk run: cut fields with the comma loop; a comma followed
            // by '"' ends the run (the next field is quoted). No separate
            // search for ',"' is needed.
            let start = pos;
            let hitQuote = false;
            while (true) {
              const comma = text.indexOf(',', start);
              if (comma === -1 || comma >= lineContentEnd) { value = text.slice(start, lineContentEnd); break; }
              if (text.charCodeAt(comma + 1) === 34) { value = text.slice(start, comma); pos = comma + 1; ended = 0; hitQuote = true; break; }
              fields.push(text.slice(start, comma));
              start = comma + 1;
            }
            if (!hitQuote) {
              if (lineEnd >= len) { pos = len; ended = 2; }
              else { pos = lineEnd + 1; line += 1; ended = 1; }
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
