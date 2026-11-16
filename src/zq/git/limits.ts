export interface GitLimitsConfig {
  callsPerMinute: number;
  globalCallsPerMinute: number;
  dailyBytes: number;
}

export const DEFAULT_GIT_LIMITS: GitLimitsConfig = {
  callsPerMinute: 30,
  globalCallsPerMinute: 120,
  dailyBytes: 20 * 1024 * 1024,
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export class GitRateLimited extends Error {
  constructor(detail: string) {
    super(`rate_limited: ${detail}`);
    this.name = "GitRateLimited";
  }
}

export interface GitLimits {
  admit(principal: string): Promise<void>;
  settle(principal: string, resultBytes: number): Promise<void>;
}

interface Window {
  minute: number;
  count: number;
}

export function createGitLimits(deps: {
  config: GitLimitsConfig;
  bytesSince: (principal: string, since: number) => Promise<number>;
  now: () => number;
}): GitLimits {
  const { config, bytesSince, now } = deps;
  const perPrincipal = new Map<string, Window>();
  let global: Window = { minute: -1, count: 0 };

  function windowOf(current: Window | undefined, minute: number): Window {
    return current?.minute === minute ? current : { minute, count: 0 };
  }

  const spentBudget = () =>
    new GitRateLimited(`the daily git read budget of ${config.dailyBytes} bytes is spent; it resets at 00:00 UTC`);
  const usedToday = (principal: string) => bytesSince(principal, Math.floor(now() / DAY_MS) * DAY_MS);

  return {
    async settle(principal, resultBytes) {
      const used = await usedToday(principal);
      if (used + resultBytes > config.dailyBytes)
        throw new GitRateLimited(
          `this result would exceed the daily git read budget of ${config.dailyBytes} bytes; ${Math.max(0, config.dailyBytes - used)} bytes remain today, so narrow the request`,
        );
    },
    async admit(principal) {
      const at = now();
      const minute = Math.floor(at / MINUTE_MS);
      const own = windowOf(perPrincipal.get(principal), minute);
      const all = windowOf(global, minute);
      if (own.count >= config.callsPerMinute)
        throw new GitRateLimited(`at most ${config.callsPerMinute} git calls per minute per person; try again shortly`);
      if (all.count >= config.globalCallsPerMinute)
        throw new GitRateLimited(`QM is at its ${config.globalCallsPerMinute} git calls per minute; try again shortly`);
      if ((await usedToday(principal)) >= config.dailyBytes) throw spentBudget();
      own.count += 1;
      all.count += 1;
      for (const [key, w] of perPrincipal) if (w.minute !== minute) perPrincipal.delete(key);
      perPrincipal.set(principal, own);
      global = all;
    },
  };
}
