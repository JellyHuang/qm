export interface ZqConfig {
  identityMap: boolean;
}

export function zqConfigFromEnv(env: NodeJS.ProcessEnv): ZqConfig {
  return { identityMap: env.ZQ_IDENTITY_MAP?.trim() === "1" };
}
