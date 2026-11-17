import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
let counter = 0;

export function fakeGit(dir: string, body: string): string {
  const file = join(dir, `fake-git-${counter++}.sh`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

export function loggingGit(dir: string): { bin: string; calls(): string[][] } {
  const log = join(dir, `calls-${counter++}.log`);
  const bin = fakeGit(
    dir,
    `for a in "$@"; do printf '%s\\n' "$a" >> ${log}; done\nprintf '%s\\n' '--end--' >> ${log}\nexec ${REAL_GIT} "$@"`,
  );
  return {
    bin,
    calls() {
      if (!existsSync(log)) return [];
      const calls: string[][] = [[]];
      for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
        if (line === "--end--") calls.push([]);
        else calls.at(-1)?.push(line);
      }
      return calls.filter((call) => call.length > 0);
    },
  };
}
