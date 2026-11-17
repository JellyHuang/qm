import type { DurableMap } from "../../src/persistence/durable-map.ts";

export function memoryMap<T>(rows: Map<string, T> = new Map()): DurableMap<T> {
  const map = {
    async all() {
      return [...rows.values()];
    },
    async entries() {
      return [...rows.entries()];
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async put(id: string, value: T) {
      rows.set(id, value);
    },
    async putIfAbsent(id: string, value: T) {
      if (!rows.has(id)) rows.set(id, value);
      return rows.get(id)!;
    },
    async insertIfAbsent(id: string, value: T) {
      if (rows.has(id)) return false;
      rows.set(id, value);
      return true;
    },
    async update(id: string, fn: (value: T) => T) {
      const current = rows.get(id);
      if (!current) return null;
      const next = fn(current);
      rows.set(id, next);
      return next;
    },
    async delete(id: string) {
      rows.delete(id);
    },
  };
  return map as unknown as DurableMap<T>;
}
