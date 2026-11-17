import { createHash } from "node:crypto";

export const NAME_MAX = 100;
const EMAIL_CONDITION_MAX = 254;

const INVISIBLE = /\p{Cf}/gu;
const WORD = /\p{Lu}+(?![\p{Ll}\p{M}])|\p{Lu}?[\p{Ll}\p{M}]+|\p{Lo}+|\p{N}+/gu;

export function displayName(raw: string): string {
  return raw.normalize("NFKC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

export const nameKey = (raw: string): string => displayName(raw).toLowerCase();

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export const hashName = (raw: string): string => digest(nameKey(raw));

export const hashEmail = (raw: string): string => digest(normaliseEmail(raw));

export function encodeNameId(key: string): string {
  return key.replaceAll("%", "%25").replaceAll("|", "%7C");
}

export function usableEmail(raw: string): boolean {
  const email = normaliseEmail(raw);
  const at = email.indexOf("@");
  return at > 0 && at === email.lastIndexOf("@") && at < email.length - 1;
}

export function emailDomain(raw: string): string | undefined {
  const email = normaliseEmail(raw);
  return usableEmail(email) ? email.slice(email.indexOf("@") + 1) : undefined;
}

export function emailCondition(raw: string): string | undefined {
  const email = normaliseEmail(raw);
  return email && email.length <= EMAIL_CONDITION_MAX && !/\s/u.test(email) ? email : undefined;
}

export function isGenericName(raw: string, generic: readonly string[]): boolean {
  const key = nameKey(raw);
  const last = key.slice(key.lastIndexOf("\\") + 1);
  const wanted = new Set(generic.map(nameKey));
  return wanted.has(key) || wanted.has(last);
}

function tokens(raw: string): string[] {
  return displayName(raw)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .flatMap((chunk) => chunk.match(WORD) ?? [])
    .map((token) => token.toLowerCase());
}

export interface BotRules {
  botNames: readonly string[];
  botTokens: readonly string[];
}

export function isBotAuthor(author: { name: string; email: string }, rules: BotRules): boolean {
  const email = normaliseEmail(author.email);
  const local = usableEmail(email) ? email.slice(0, email.indexOf("@")) : "";
  const exact = new Set(rules.botNames.map(nameKey));
  const wanted = new Set(rules.botTokens.map((token) => token.toLowerCase()));
  return [author.name, local]
    .filter(Boolean)
    .some((part) => exact.has(nameKey(part)) || tokens(part).some((token) => wanted.has(token)));
}
