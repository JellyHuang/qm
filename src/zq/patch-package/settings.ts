import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PatchPackageSettings {
  ticketPattern: string;
  authorName: string;
  authorEmail: string;
  outputDir: string;
  subjectMax: number;
  bodyMax: number;
}

export const DEFAULT_TICKET_PATTERN = "^(WP-)?[0-9]{1,9}$";
export const DEFAULT_AUTHOR_NAME = "QM Bot";
export const DEFAULT_AUTHOR_EMAIL = "qm-bot@invalid";
export const DEFAULT_SUBJECT_MAX = 72;
export const DEFAULT_BODY_MAX = 5000;
export const defaultOutputDir = () => join(tmpdir(), "qm-patch-packages");

export type PatchPackageErrorCode =
  | "bad_input"
  | "bad_ticket"
  | "bad_message"
  | "truncated_diff"
  | "unsupported"
  | "empty"
  | "unchanged"
  | "missing_file"
  | "exists"
  | "git_failed"
  | "verify_failed";

export class PatchPackageError extends Error {
  readonly code: PatchPackageErrorCode;
  constructor(code: PatchPackageErrorCode, message: string) {
    super(message);
    this.name = "PatchPackageError";
    this.code = code;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const RESERVED_TRAILER = /^(Ticket|AI-Generated):/im;

export function validateTicket(settings: PatchPackageSettings, ticket: unknown): string {
  if (
    typeof ticket !== "string" ||
    ticket.length === 0 ||
    ticket.length > 64 ||
    /\s/.test(ticket) ||
    CONTROL.test(ticket)
  )
    throw new PatchPackageError("bad_ticket", "the ticket id is required: 1 through 64 characters without whitespace");
  if (!new RegExp(settings.ticketPattern).test(ticket))
    throw new PatchPackageError("bad_ticket", `the ticket id ${ticket} does not match ${settings.ticketPattern}`);
  return ticket;
}

export function validateMessage(
  settings: PatchPackageSettings,
  subject: unknown,
  body: unknown,
): { subject: string; body: string } {
  if (typeof subject !== "string" || subject.length === 0 || subject.trim() !== subject)
    throw new PatchPackageError("bad_message", "the subject is required and must not start or end with whitespace");
  if ([...subject].length > settings.subjectMax)
    throw new PatchPackageError("bad_message", `the subject is longer than ${settings.subjectMax} characters`);
  if (CONTROL.test(subject))
    throw new PatchPackageError("bad_message", "the subject must not contain control characters");
  const text = body === undefined ? "" : body;
  if (typeof text !== "string") throw new PatchPackageError("bad_message", "the body must be a string");
  if ([...text].length > settings.bodyMax)
    throw new PatchPackageError("bad_message", `the body is longer than ${settings.bodyMax} characters`);
  if (BODY_CONTROL.test(text))
    throw new PatchPackageError("bad_message", "the body must not contain control characters other than newline");
  if (RESERVED_TRAILER.test(subject) || RESERVED_TRAILER.test(text))
    throw new PatchPackageError("bad_message", "the subject and body must not contain Ticket: or AI-Generated: lines");
  return { subject, body: text.replace(/\n+$/, "") };
}

export function validateIdentity(name: string, email: string): void {
  if (!/qm/i.test(`${name} ${email}`))
    throw new PatchPackageError(
      "bad_input",
      "the author identity must be recognisably QM (the name or email contains QM)",
    );
  if (!name || CONTROL.test(name) || /[<>]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email))
    throw new PatchPackageError("bad_input", "the author name and email are not valid identity values");
}

export function commitMessage(ticket: string, subject: string, body: string): string {
  return `${subject}\n\n${body ? `${body}\n\n` : ""}Ticket: ${ticket}\nAI-Generated: QM\n`;
}
