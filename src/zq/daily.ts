import type { DurableMap } from "../persistence/durable-map.ts";
import type { WorkView } from "./rules.ts";

const WINDOW_MS = 20 * 3_600_000;

export interface ZqDailyEntry {
  id: string;
  mmUserId: string;
  day: string;
  askedAt: number;
  reply?: string;
  repliedAt?: number;
  matched: number[];
  answers: Record<string, "done" | "open">;
}

export interface ZqDaily {
  ask(mmUserId: string, day: string): Promise<boolean>;
  openFor(mmUserId: string): Promise<ZqDailyEntry | undefined>;
  record(id: string, reply: string, matched: number[]): Promise<void>;
  answer(id: string, orderId: number, done: boolean): Promise<ZqDailyEntry | undefined>;
  get(id: string): Promise<ZqDailyEntry | undefined>;
}

export function createZqDaily(opts: { map: DurableMap<ZqDailyEntry>; now?: () => number }): ZqDaily {
  const now = opts.now ?? (() => Date.now());
  return {
    async ask(mmUserId, day) {
      const id = `${mmUserId}:${day}`;
      return opts.map.insertIfAbsent(id, { id, mmUserId, day, askedAt: now(), matched: [], answers: {} });
    },
    async openFor(mmUserId) {
      return (await opts.map.all())
        .filter((e) => e.mmUserId === mmUserId && e.reply === undefined && now() - e.askedAt <= WINDOW_MS)
        .sort((a, b) => b.askedAt - a.askedAt)[0];
    },
    async record(id, reply, matched) {
      await opts.map.merge(id, { reply, repliedAt: now(), matched });
    },
    async answer(id, orderId, done) {
      const entry = await opts.map.get(id);
      if (!entry || !entry.matched.includes(orderId)) return undefined;
      return (
        (await opts.map.merge(id, { answers: { ...entry.answers, [String(orderId)]: done ? "done" : "open" } })) ??
        undefined
      );
    },
    async get(id) {
      return (await opts.map.get(id)) ?? undefined;
    },
  };
}

export function matchOrders(text: string, orders: readonly WorkView[]): WorkView[] {
  const ids = new Set([...text.matchAll(/(?:#|OP\s*)(\d+)/gi)].map((m) => Number(m[1])));
  return orders.filter((w) => ids.has(w.id) || (w.subject.trim().length >= 3 && text.includes(w.subject.trim())));
}

export const DAILY_ASK = "下班前确认一下:你今天做了什么?直接回复这条私信就行,我会对照你名下的单子。";
