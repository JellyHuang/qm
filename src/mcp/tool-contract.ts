export interface McpToolContract {
  required: string[];
  forbidden: string[];
}

export interface McpContractViolation {
  missing: string[];
  forbidden: string[];
}

export class McpContractError extends Error {
  readonly violation: McpContractViolation;
  constructor(serverName: string, violation: McpContractViolation) {
    super(contractMessage(serverName, violation));
    this.violation = violation;
  }
}

function contractMessage(serverName: string, { missing, forbidden }: McpContractViolation): string {
  const parts = [
    ...(missing.length ? [`missing required tools: ${missing.join(", ")}`] : []),
    ...(forbidden.length ? [`exposes forbidden tools: ${forbidden.join(", ")}`] : []),
  ];
  return `${serverName} does not match its tool contract (${parts.join("; ")})`;
}

export function contractViolation(
  tools: ReadonlyArray<{ name: string }>,
  contract: McpToolContract | undefined,
): McpContractViolation | undefined {
  if (!contract) return undefined;
  const names = new Set(tools.map((t) => t.name));
  const missing = contract.required.filter((n) => !names.has(n));
  const forbidden = contract.forbidden.filter((n) => names.has(n));
  return missing.length || forbidden.length ? { missing, forbidden } : undefined;
}

export function assertToolContract(
  serverName: string,
  tools: ReadonlyArray<{ name: string }>,
  contract: McpToolContract | undefined,
): void {
  const violation = contractViolation(tools, contract);
  if (violation) throw new McpContractError(serverName, violation);
}

export function parseToolContract(value: unknown): McpToolContract | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const { required, forbidden, ...rest } = value as Record<string, unknown>;
  const names = (list: unknown): string[] | undefined =>
    list === undefined
      ? []
      : Array.isArray(list) &&
          list.length <= 200 &&
          list.every((n) => typeof n === "string" && /^[\w.:-]{1,128}$/.test(n))
        ? [...new Set(list as string[])]
        : undefined;
  const req = names(required);
  const forb = names(forbidden);
  if (Object.keys(rest).length || !req || !forb || req.some((n) => forb.includes(n))) return "invalid";
  return req.length || forb.length ? { required: req, forbidden: forb } : undefined;
}
