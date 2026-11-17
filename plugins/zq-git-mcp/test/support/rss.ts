import { readdirSync, readFileSync } from "node:fs";

function indexPackPeakKb(): number {
  let peak = 0;
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("index-pack")) continue;
      const hwm = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
      peak = Math.max(peak, Number(hwm ?? 0));
    } catch {
      continue;
    }
  }
  return peak;
}

export async function withIndexPackPeak<T>(run: () => Promise<T>): Promise<{ value: T; peakBytes: number }> {
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, indexPackPeakKb());
  }, 25);
  try {
    const value = await run();
    return { value, peakBytes: peak * 1024 };
  } finally {
    clearInterval(timer);
  }
}
