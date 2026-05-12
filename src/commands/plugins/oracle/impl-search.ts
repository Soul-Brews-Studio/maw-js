import { buildEnrichedEntries, formatRow, type EnrichedEntry } from "./impl-list";

export interface OracleSearchOpts {
  json?: boolean;
  awake?: boolean;
  org?: string;
}

export async function cmdOracleSearch(query: string, opts: OracleSearchOpts = {}) {
  const all = await buildEnrichedEntries();
  const q = query.toLowerCase();

  let matched = all.filter((x) => {
    const e = x.entry;
    const haystack = [
      e.name,
      e.org,
      e.repo,
      e.budded_from ?? "",
      (e as Record<string, unknown>).nickname as string ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });

  if (opts.awake) matched = matched.filter((x) => x.awake);
  if (opts.org) matched = matched.filter((x) => x.entry.org === opts.org);

  matched.sort((a, b) => {
    const aExact = a.entry.name.toLowerCase() === q ? 0 : 1;
    const bExact = b.entry.name.toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.awake !== b.awake) return a.awake ? -1 : 1;
    return a.entry.name.localeCompare(b.entry.name);
  });

  if (opts.json) {
    console.log(JSON.stringify({
      query,
      total: matched.length,
      oracles: matched.map((x) => ({
        ...x.entry,
        awake: x.awake,
        session: x.session,
        lineage: x.lineage,
      })),
    }, null, 2));
    return;
  }

  if (matched.length === 0) {
    console.log(`\n  No oracles matching \x1b[36m${query}\x1b[0m\n`);
    return;
  }

  console.log(`\n  \x1b[36m${matched.length} oracle${matched.length === 1 ? "" : "s"} matching "${query}"\x1b[0m\n`);
  for (const x of matched) {
    console.log(formatRow(x, { showPath: false }));
  }
  console.log();
}
