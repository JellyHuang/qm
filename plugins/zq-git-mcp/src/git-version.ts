import type { GitRunner } from "./runner.ts";

const MIN_GIT_VERSION = { major: 2, minor: 44 } as const;

export function parseGitVersion(text: string): { major: number; minor: number } | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(text);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

export function gitVersionSupported(version: { major: number; minor: number }): boolean {
  return (
    version.major > MIN_GIT_VERSION.major ||
    (version.major === MIN_GIT_VERSION.major && version.minor >= MIN_GIT_VERSION.minor)
  );
}

export async function assertGitVersion(runner: GitRunner): Promise<void> {
  const text = (await runner.run(undefined, ["--version"])).stdout.toString("utf8").trim();
  const version = parseGitVersion(text);
  if (!version) throw new Error(`cannot read the git version from "${text.slice(0, 80)}"`);
  if (!gitVersionSupported(version))
    throw new Error(
      `git ${version.major}.${version.minor} is too old: ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required for GIT_NO_LAZY_FETCH`,
    );
}
