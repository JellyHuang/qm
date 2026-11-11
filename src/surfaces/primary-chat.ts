let primary = "slack";

export function primaryChatSurface(): string {
  return primary;
}

export function setPrimaryChatSurface(kind: string): void {
  primary = kind;
}

export function isChatSurface(kind: string | undefined): boolean {
  return kind === "slack" || kind === primary;
}
