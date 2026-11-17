export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(max: number): Limiter {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    async run(fn) {
      if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      else running++;
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    },
  };
}
