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

  return {
    async admit(principal) {
      const at = now();
      const minute = Math.floor(at / MINUTE_MS);
      const own = windowOf(perPrincipal.get(principal), minute);
      const all = windowOf(global, minute);
      if (own.count >= config.callsPerMinute)
        throw new GitRateLimited(`at most ${config.callsPerMinute} git calls per minute per person; try again shortly`);
      if (all.count >= config.globalCallsPerMinute)
        throw new GitRateLimited(`QM is at its ${config.globalCallsPerMinute} git calls per minute; try again shortly`);
      const dayStart = Math.floor(at / DAY_MS) * DAY_MS;
      if ((await bytesSince(principal, dayStart)) >= config.dailyBytes)
        throw new GitRateLimited(
          `the daily git read budget of ${config.dailyBytes} bytes is spent; it resets at 00:00 UTC`,
        );
      own.count += 1;
      all.count += 1;
      for (const [key, w] of perPrincipal) if (w.minute !== minute) perPrincipal.delete(key);
      perPrincipal.set(principal, own);
      global = all;
    },
  };
}
