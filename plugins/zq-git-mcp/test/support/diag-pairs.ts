export interface DiagPair {
  path?: string;
  baseRef?: string;
  headRef?: string;
  baseBlob?: string;
  headBlob?: string;
  ref?: string;
}

export function parseDiagPairs(text: string, ref?: string): DiagPair[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): DiagPair => {
      const parts = entry.split(":");
      const kind = parts[0] === "blob" || parts[0] === "ref" ? parts[0] : "ref";
      const [path, base, head] = parts[0] === "blob" || parts[0] === "ref" ? parts.slice(1) : parts;
      if (!path || !base || !head)
        throw new Error(`a diagnostic pair is ref:<path>:<base>:<head> or blob:<path>:<base>:<head>, got "${entry}"`);
      return kind === "blob"
        ? { path, baseBlob: base, headBlob: head, ...(ref ? { ref } : {}) }
        : { path, baseRef: base, headRef: head };
    });
}
