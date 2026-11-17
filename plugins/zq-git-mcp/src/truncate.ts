export interface Fitted {
  value: Record<string, unknown>;
  truncated: boolean;
  cutItems: number;
  cutChars: number;
}

const size = (value: unknown) => JSON.stringify(value).length;

function biggest(value: Record<string, unknown>): string | undefined {
  let best: string | undefined;
  let bestSize = 0;
  for (const [key, item] of Object.entries(value)) {
    const nonEmpty = (Array.isArray(item) && item.length > 0) || (typeof item === "string" && item.length > 0);
    if (!nonEmpty) continue;
    const itemSize = size(item);
    if (itemSize > bestSize) {
      best = key;
      bestSize = itemSize;
    }
  }
  return best;
}

export function fitToChars(input: Record<string, unknown>, maxChars: number): Fitted {
  const value = { ...input };
  let cutItems = 0;
  let cutChars = 0;
  for (let key = biggest(value); key !== undefined && size(value) > maxChars; key = biggest(value)) {
    const item = value[key];
    if (typeof item === "string") {
      const keep = Math.max(0, item.length - (size(value) - maxChars) - 16);
      value[key] = item.slice(0, keep);
      cutChars += item.length - keep;
      continue;
    }
    const items = item as unknown[];
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size({ ...value, [key]: items.slice(0, mid) }) <= maxChars) lo = mid;
      else hi = mid - 1;
    }
    value[key] = items.slice(0, lo);
    cutItems += items.length - lo;
  }
  return { value, truncated: cutItems > 0 || cutChars > 0, cutItems, cutChars };
}
