import type { InboxItem, QueueFilter } from "./types";

const KNOWN_FILTER_KEYS = new Set<keyof QueueFilter>([
  "recipient",
  "team",
  "type",
  "maxAgeHours",
]);

function eqCI(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.toLowerCase() === b.toLowerCase();
}

export function applyFilter(items: InboxItem[], filter: QueueFilter): InboxItem[] {
  for (const key of Object.keys(filter)) {
    if (!KNOWN_FILTER_KEYS.has(key as keyof QueueFilter)) {
      console.debug(`[ctq.filter] ignoring unknown filter key: ${key}`);
    }
  }

  const { recipient, team, type, maxAgeHours } = filter;
  const hasRecipient = recipient !== undefined && recipient !== "";
  const hasTeam = team !== undefined && team !== "";
  const hasType = type !== undefined && type !== "";
  const hasMaxAge = typeof maxAgeHours === "number" && Number.isFinite(maxAgeHours);

  if (!hasRecipient && !hasTeam && !hasType && !hasMaxAge) {
    return items.slice();
  }

  return items.filter((item) => {
    if (hasRecipient && !eqCI(item.recipient, recipient)) return false;
    if (hasTeam && item.team !== team) return false;
    if (hasType && item.type !== type) return false;
    if (hasMaxAge && !(item.ageHours <= (maxAgeHours as number))) return false;
    return true;
  });
}
