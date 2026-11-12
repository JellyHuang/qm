import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, type Route } from "./fixture.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
type Page = Awaited<ReturnType<typeof mountPage>>;
const type = (admin: Page, selector: string, value: string) => {
  const input = admin.document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new admin.window.Event("input", { bubbles: true }));
};
const choose = (admin: Page, selector: string, value: string) => {
  const el = admin.document.querySelector<HTMLSelectElement>(selector)!;
  el.value = value;
  el.dispatchEvent(new admin.window.Event("change", { bubbles: true }));
};
const click = (admin: Page, selector: string) => admin.document.querySelector<HTMLButtonElement>(selector)!.click();

const STORED = {
  id: "jira",
  name: "Jira",
  url: "https://mcp.example.com/mcp",
  auth: "bearer",
  credentialScope: "shared",
  readOnly: false,
  enabled: true,
  hasBearerToken: true,
  hasClientSecret: false,
  tools: [{ name: "search_issues", description: "Search", inputSchema: {}, annotations: { readOnlyHint: true } }],
};

test("MCP servers list shows stored-token state and tools, never a token value", async () => {
  const admin = await mountPage("/settings/mcp-servers", {
    "/mcp-servers": { servers: [STORED], tools: [] },
  });
  await admin.settle();
  const row = admin.document.querySelector(".mcp-server-row")!;
  assert.match(row.textContent!, /Jira/);
  assert.match(row.textContent!, /Token stored/);
  assert.match(row.textContent!, /search_issues/);
  assert.match(row.textContent!, /1 tool\b/);
  admin.close();
});

test("editing keeps the stored token when the field is blank, and a new server sends its fields", async () => {
  const saves: [string, string, unknown][] = [];
  const record: Route = ({ method, path, body }) => {
    saves.push([method, decodeURIComponent(path), body]);
    return { ok: true, server: STORED, tools: ["search_issues"] };
  };
  const admin = await mountPage("/settings/mcp-servers", {
    "/mcp-servers": { servers: [STORED], tools: [] },
    "PUT /mcp-servers/jira": record,
    "PUT /mcp-servers/wiki": record,
  });
  await admin.settle();
  admin.document.querySelector<HTMLButtonElement>(".mcp-server-row .credential-actions .btn")!.click();
  await admin.settle();
  const token = admin.document.querySelector<HTMLInputElement>("#mcp-server-bearerToken")!;
  assert.equal(token.value, "");
  assert.equal(token.type, "password");
  click(admin, "#mcp-server-save");
  await admin.settle();
  click(admin, "#add-mcp-server");
  type(admin, "#mcp-server-id", "wiki");
  type(admin, "#mcp-server-name", "Wiki");
  type(admin, "#mcp-server-url", "https://wiki.example.com/mcp");
  choose(admin, "#mcp-server-credentialScope", "per-user");
  await admin.settle();
  type(admin, "#mcp-server-credentialHost", "wiki.example.com");
  click(admin, "#mcp-server-readOnly");
  click(admin, "#mcp-server-save");
  await admin.settle();
  assert.deepEqual(plain(saves), [
    [
      "PUT",
      "/mcp-servers/jira",
      {
        name: "Jira",
        url: "https://mcp.example.com/mcp",
        auth: "bearer",
        credentialScope: "shared",
        approval: "annotations",
        readOnly: false,
        enabled: true,
      },
    ],
    [
      "PUT",
      "/mcp-servers/wiki",
      {
        name: "Wiki",
        url: "https://wiki.example.com/mcp",
        auth: "none",
        credentialScope: "per-user",
        approval: "annotations",
        readOnly: true,
        enabled: true,
        credentialHost: "wiki.example.com",
        credentialAccountType: "default",
      },
    ],
  ]);
  assert.match(admin.document.querySelector("#mcp-servers-notice")!.textContent!, /1 tool discovered/);
  admin.close();
});

test("deleting asks first and calls DELETE", async () => {
  const deletes: string[] = [];
  const admin = await mountPage(
    "/settings/mcp-servers",
    {
      "/mcp-servers": { servers: [STORED], tools: [] },
      "DELETE /mcp-servers/jira": ({ path }) => (deletes.push(path), { ok: true }),
    },
    { confirm: () => true },
  );
  await admin.settle();
  click(admin, ".mcp-server-row .danger");
  await admin.settle();
  assert.deepEqual(deletes, ["/mcp-servers/jira"]);
  admin.close();
});
