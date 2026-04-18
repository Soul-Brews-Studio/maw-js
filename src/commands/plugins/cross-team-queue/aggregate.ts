import type { InboxItem, QueueStats } from "./types";

function bumpCount(map: Record<string, number>, key: string | undefined): void {
  if (key === undefined || key === "") return;
  map[key] = (map[key] ?? 0) + 1;
}

export function computeStats(items: InboxItem[]): QueueStats {
  if (items.length === 0) {
    return {
      totalItems: 0,
      byRecipient: {},
      byType: {},
      oldestAgeHours: null,
      newestAgeHours: null,
    };
  }

  const byRecipient: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let oldest = -Infinity;
  let newest = Infinity;

  for (const item of items) {
    bumpCount(byRecipient, item.recipient);
    bumpCount(byType, item.type);
    if (typeof item.ageHours === "number" && Number.isFinite(item.ageHours)) {
      if (item.ageHours > oldest) oldest = item.ageHours;
      if (item.ageHours < newest) newest = item.ageHours;
    }
  }

  return {
    totalItems: items.length,
    byRecipient,
    byType,
    oldestAgeHours: Number.isFinite(oldest) ? oldest : null,
    newestAgeHours: Number.isFinite(newest) ? newest : null,
  };
}
