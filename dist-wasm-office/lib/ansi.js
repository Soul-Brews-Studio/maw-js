// ANSI escape code → HTML renderer (Catppuccin Mocha palette)

const AC = [
  "#0a0a0f","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#cdd6f4",
  "#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#ffffff",
];

function a256(n) {
  if (n < 16) return AC[n];
  if (n < 232) {
    n -= 16;
    return `rgb(${Math.floor(n / 36) * 51},${(Math.floor(n / 6) % 6) * 51},${(n % 6) * 51})`;
  }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ansiToHtml(text) {
  let h = "", fg = null, bg = null;
  let b = 0, d = 0, i = 0, u = 0, s = 0, open = 0;

  for (const p of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { h += esc(p); continue; }
    if (open) { h += "</span>"; open = 0; }
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (!c) { fg = bg = null; b = d = i = u = s = 0; }
      else if (c === 1) b = 1; else if (c === 2) d = 1; else if (c === 3) i = 1;
      else if (c === 4) u = 1; else if (c === 9) s = 1;
      else if (c === 22) b = d = 0; else if (c === 23) i = 0;
      else if (c === 24) u = 0; else if (c === 29) s = 0;
      else if (c >= 30 && c <= 37) fg = AC[c - 30];
      else if (c === 38 && codes[j + 1] === 5) { fg = a256(codes[j + 2]); j += 2; }
      else if (c === 38 && codes[j + 1] === 2) { fg = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = AC[c - 40];
      else if (c === 48 && codes[j + 1] === 5) { bg = a256(codes[j + 2]); j += 2; }
      else if (c === 48 && codes[j + 1] === 2) { bg = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`; j += 4; }
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = AC[c - 82];
      else if (c >= 100 && c <= 107) bg = AC[c - 92];
    }
    const st = [];
    if (fg) st.push("color:" + fg);
    if (bg) st.push("background:" + bg);
    if (b) st.push("font-weight:bold");
    if (d) st.push("opacity:0.6");
    if (i) st.push("font-style:italic");
    if (u || s) st.push("text-decoration:" + (u ? "underline" : "") + (u && s ? " " : "") + (s ? "line-through" : ""));
    if (st.length) { h += `<span style="${st.join(";")}">`; open = 1; }
  }
  if (open) h += "</span>";
  return h;
}
