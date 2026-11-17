import { createReadStream } from "node:fs";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { SaxesParser, type SaxesTagPlain } from "saxes";

export interface PartSink {
  write(chunk: Uint8Array): void;
  end(): void;
}

export async function scanZip(file: string, open: (name: string) => PartSink | undefined): Promise<string[]> {
  const names: string[] = [];
  let failure: Error | undefined;
  const unzip = new Unzip((entry) => {
    const name = entry.name.replaceAll("\\", "/").replace(/^\/+/, "");
    names.push(name);
    const sink = open(name);
    if (!sink && entry.size !== undefined && entry.size > 0) return;
    entry.ondata = (error, data, final) => {
      if (error) {
        failure ??= error;
        return;
      }
      if (!sink) return;
      sink.write(data);
      if (final) sink.end();
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  for await (const chunk of createReadStream(file)) {
    unzip.push(chunk as Uint8Array);
    if (failure) throw failure;
  }
  unzip.push(new Uint8Array(0), true);
  if (failure) throw failure;
  return names;
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

function localAttributes(attributes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) if (!name.startsWith("xmlns")) out[local(name)] = value;
  return out;
}

export interface XmlHandlers {
  open?(name: string, attributes: Record<string, string>): void;
  close?(name: string): void;
  text?(text: string): void;
}

export function xmlSink(handlers: XmlHandlers): PartSink {
  const parser = new SaxesParser();
  const decoder = new TextDecoder("utf-8");
  parser.on("opentag", (tag: SaxesTagPlain) => handlers.open?.(local(tag.name), localAttributes(tag.attributes)));
  parser.on("closetag", (tag: SaxesTagPlain) => handlers.close?.(local(tag.name)));
  parser.on("text", (text: string) => handlers.text?.(text));
  return {
    write(chunk) {
      parser.write(decoder.decode(chunk, { stream: true }));
    },
    end() {
      parser.write(decoder.decode());
      parser.close();
    },
  };
}
