/**
 * kobo-396 — shared escape-first markdown→HTML renderer. Extracted VERBATIM from
 * src/views/company.ts (where it lived inline in the served client script) so
 * src/views/room.ts can reuse the SAME renderer instead of a second copy
 * (2-live-path lesson: kobo-376/381/384). Both views embed these into their
 * client-side `<script>` via `${fnName.toString()}` — single source, no drift.
 *
 * `mdToHtml` escapes HTML FIRST (`escapeHtml(src)`), then applies formatting on
 * top of the escaped text — raw user HTML/`<script>` can never surface as markup.
 * Do not weaken this ordering.
 */
export function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
export function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
export function mdToHtml(src) {
  const lines = escapeHtml(src).split(/\r?\n/);
  const out = [];
  let i = 0, inCode = false, codeLang = '', listType = null;
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
  while (i < lines.length) {
    const line = lines[i];
    // kobo-398: capture the fence info-string (```mermaid vs ```js) — previously
    // discarded entirely. `mermaid` gets a render-TARGET div whose visible TEXT
    // CONTENT is the escaped source (not an empty div+data-attr) — this is SHARED
    // with company.ts (the board), which has no mermaid loader: the board degrades
    // to showing the source as text instead of a blank/broken div, and it's also
    // room's parse-failure fallback for free (already the div's text). Any other
    // lang (or none) renders as a normal <pre><code> block, unchanged.
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (!inCode) {
        closeList();
        codeLang = fence[1] || '';
        out.push(codeLang === 'mermaid' ? '<pre class="mermaid-src">' : '<pre><code>');
        inCode = true;
      } else {
        out.push(codeLang === 'mermaid' ? '</pre>' : '</code></pre>');
        inCode = false; codeLang = '';
      }
      i++; continue;
    }
    if (inCode) { out.push(line); i++; continue; }
    if (/^\s*$/.test(line)) { closeList(); i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); const lv = m[1].length; out.push('<h' + lv + '>' + inlineMd(m[2]) + '</h' + lv + '>'); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); out.push('<hr/>'); i++; continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { closeList(); out.push('<blockquote>' + inlineMd(m[1]) + '</blockquote>'); i++; continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; } const cb = m[1].match(/^\[([ xX])\]\s+(.*)$/); if (cb) { const done = cb[1] !== ' '; out.push('<li class="chk"><input type="checkbox" disabled' + (done ? ' checked' : '') + '/>' + (done ? '<span class="done">' + inlineMd(cb[2]) + '</span>' : inlineMd(cb[2])) + '</li>'); } else { out.push('<li>' + inlineMd(m[1]) + '</li>'); } i++; continue; }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; } out.push('<li>' + inlineMd(m[1]) + '</li>'); i++; continue; }
    closeList(); out.push('<p>' + inlineMd(line) + '</p>'); i++;
  }
  if (inCode) out.push(codeLang === 'mermaid' ? '</pre>' : '</code></pre>');
  closeList();
  return out.join('\n');
}

/**
 * kobo-397 — extracted VERBATIM from company.ts (kobo-116, where it lived inline
 * in the served client script as `renderNoteBody`), so room.ts can reuse the SAME
 * markdown+image renderer for message bodies (2-live-path lesson, same as the 396
 * extract above). Name kept for minimal diff at company.ts's 3 call sites — the
 * behavior is generic (any escape-first markdown body + maw:// image refs), not
 * note-specific.
 *
 * mdToHtml first (escape-first, XSS-safe), then swap `maw://<node>/<file>.<ext>`
 * refs for an `<img>` WE build ourselves from regex-captured, charset+ext
 * allowlisted groups — the src is NEVER attacker-controlled: it's always our own
 * `/api/files/<matched-filename>` string, so a disguised `javascript:`/`data:`/
 * arbitrary-URL ref can never reach a live `src` (it isn't a maw:// match at all,
 * so it stays inert escaped text from mdToHtml). Local-node scope only (MVP);
 * cross-node data-URI resolution is a separate concern (maw_inline_images).
 */
export const NOTE_IMG_EXT = /^(png|jpe?g|gif|webp)$/i;
export function renderNoteBody(txt) {
  return mdToHtml(txt || '').replace(
    /maw:\/\/[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+\.([A-Za-z0-9]+))/g,
    function (ref, file, ext) {
      if (!NOTE_IMG_EXT.test(ext)) return ref;
      const url = '/api/files/' + encodeURIComponent(file);
      // anchor → native click-to-open (full-size, new tab); no JS handler needed.
      return '<a class="note-img-link" href="' + url + '" target="_blank" rel="noopener">' +
        '<img class="note-img" loading="lazy" src="' + url + '" alt="' + escapeHtml(file) + '"></a>';
    },
  );
}
