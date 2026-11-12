// Admin view for registered MCP servers (GET/PUT/DELETE /api/admin/mcp-servers).
//
// Registration stays a human action: the PUT route is portal-only for the agent
// (see MCP_SERVERS in src/api/routes/admin.ts), and this page only talks to the
// admin browser-session aliases. Tokens and client secrets are write-only: the
// list returns hasBearerToken / hasClientSecret, and a blank field on edit keeps
// the stored value.

import { html, nothing, render } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { ifDefined } from "lit/directives/if-defined.js";
import type { AdminPage } from "./sections.ts";
import { badge } from "./shared.ts";

type AuthMode = "none" | "bearer" | "client-credentials" | "oauth-user";
type Approval = "annotations" | "all" | "none";

interface ServerTool {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpServerView {
  id: string;
  name: string;
  url: string;
  auth: AuthMode;
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  clientId?: string;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthScopes?: string[];
  approval?: Approval;
  catalog?: boolean;
  attestActor?: boolean;
  readOnly: boolean;
  enabled: boolean;
  about?: string;
  tools?: ServerTool[];
  hasBearerToken: boolean;
  hasClientSecret: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

interface ToolDef {
  name: string;
  serverId: string;
  description?: string;
  readOnly?: boolean;
  needsApproval?: boolean;
}

const AUTH_LABEL: Record<AuthMode, string> = {
  none: "No auth",
  bearer: "Bearer token",
  "client-credentials": "OAuth client credentials",
  "oauth-user": "OAuth (each user signs in)",
};
const APPROVAL_LABEL: Record<Approval, string> = {
  annotations: "Ask for tools not marked read-only (default)",
  all: "Ask before every tool call",
  none: "Never ask",
};

let page: AdminPage;
const state = {
  servers: [] as McpServerView[],
  tools: [] as ToolDef[],
  loaded: false,
  failure: "",
  notice: "",
  draft: {} as Record<string, any>,
  editing: null as McpServerView | null,
  saving: false,
  message: "",
  error: false,
  session: 0,
};

const draw = () => {
  if (page?.host.isConnected) render(template(), page.host);
};

export async function mount(next: AdminPage) {
  page = next;
  state.failure = "";
  draw();
  await load();
}

async function load() {
  const view = page;
  const res = await view.api<{ servers?: McpServerView[]; tools?: ToolDef[]; message?: string }>(
    "GET",
    "/api/mcp-servers",
  );
  if (!view.current()) return;
  state.loaded = true;
  if (!res.ok) {
    state.failure =
      res.status === 403 ? "Only organization admins can manage MCP servers." : res.data?.message || "Failed to load.";
  } else {
    state.failure = "";
    state.servers = res.data?.servers ?? [];
    state.tools = res.data?.tools ?? [];
  }
  draw();
}

function toolsFor(server: McpServerView): Array<{ name: string; description?: string; readOnly?: boolean }> {
  const live = state.tools.filter((t) => t.serverId === server.id);
  if (live.length) return live;
  return (server.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    readOnly: t.annotations?.readOnlyHint === true,
  }));
}

function blankDraft(item: McpServerView | null) {
  return {
    id: item?.id ?? "",
    name: item?.name ?? "",
    url: item?.url ?? "",
    auth: item?.auth ?? "none",
    bearerToken: "",
    clientId: item?.clientId ?? "",
    clientSecret: "",
    oauthAuthorizeUrl: item?.oauthAuthorizeUrl ?? "",
    oauthTokenUrl: item?.oauthTokenUrl ?? "",
    oauthScopes: (item?.oauthScopes ?? []).join(" "),
    credentialScope: item?.credentialScope ?? "shared",
    credentialHost: item?.credentialHost ?? "",
    credentialAccountType: item?.credentialAccountType ?? "default",
    approval: item?.approval ?? "annotations",
    readOnly: item?.readOnly ?? false,
    enabled: item?.enabled ?? true,
    validate: true,
  };
}

function dialog(): HTMLDialogElement | null {
  return page.host.querySelector<HTMLDialogElement>("#mcp-server-dialog");
}

function openEditor(item: McpServerView | null = null) {
  state.session++;
  state.editing = item;
  state.draft = blankDraft(item);
  state.message = "";
  state.error = false;
  state.saving = false;
  draw();
  dialog()?.showModal();
  page.host.querySelector<HTMLInputElement>(item ? "#mcp-server-name" : "#mcp-server-id")?.focus();
}

function closeEditor() {
  state.session++;
  state.saving = false;
  state.draft.bearerToken = "";
  state.draft.clientSecret = "";
  const d = dialog();
  if (d?.open) d.close();
  draw();
}

function set(key: string, value: unknown) {
  state.draft[key] = value;
  draw();
}

export function mcpServerBody(d: Record<string, any>): Record<string, unknown> {
  const auth = d.auth as AuthMode;
  const oauthUser = auth === "oauth-user";
  const credentialScope = oauthUser ? "per-user" : d.credentialScope;
  const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const body: Record<string, unknown> = {
    name: trimmed(d.name),
    url: trimmed(d.url),
    auth,
    credentialScope,
    approval: d.approval,
    readOnly: !!d.readOnly,
    enabled: !!d.enabled,
  };
  if (credentialScope === "per-user") {
    body.credentialHost = trimmed(d.credentialHost);
    body.credentialAccountType = d.credentialAccountType;
  }
  if (auth === "bearer" && trimmed(d.bearerToken)) body.bearerToken = trimmed(d.bearerToken);
  if (auth === "client-credentials") {
    if (trimmed(d.clientId)) body.clientId = trimmed(d.clientId);
    if (trimmed(d.clientSecret)) body.clientSecret = trimmed(d.clientSecret);
  }
  if (oauthUser) {
    if (trimmed(d.clientId)) body.clientId = trimmed(d.clientId);
    if (trimmed(d.clientSecret)) body.clientSecret = trimmed(d.clientSecret);
    if (trimmed(d.oauthAuthorizeUrl)) body.oauthAuthorizeUrl = trimmed(d.oauthAuthorizeUrl);
    if (trimmed(d.oauthTokenUrl)) body.oauthTokenUrl = trimmed(d.oauthTokenUrl);
    if (trimmed(d.oauthScopes)) body.oauthScopes = trimmed(d.oauthScopes);
  }
  if (!d.validate) body.validate = false;
  return body;
}

function fail(message: string) {
  state.message = message;
  state.error = true;
  draw();
}

async function save() {
  if (state.saving) return;
  const d = state.draft;
  const id = String(d.id ?? "").trim();
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) {
    return fail("Id must be 2–40 characters: lowercase letters, digits and hyphens, starting with a letter.");
  }
  if (!String(d.url ?? "").trim()) return fail("URL is required.");
  const existing = state.editing;
  if (d.auth === "bearer" && !String(d.bearerToken).trim() && !(existing?.auth === "bearer" && existing.hasBearerToken))
    return fail("Bearer auth needs a token.");
  const session = state.session;
  state.saving = true;
  state.error = false;
  state.message = d.validate && d.auth !== "oauth-user" ? "Saving and testing the connection…" : "Saving…";
  draw();
  const res = await page.api<{ server?: McpServerView; tools?: string[]; message?: string }>(
    "PUT",
    "/api/mcp-servers/" + encodeURIComponent(id),
    mcpServerBody(d),
  );
  if (session !== state.session) return;
  state.saving = false;
  if (!res.ok) return fail(res.data?.message || "Could not save this MCP server.");
  const tools = res.data?.tools;
  state.notice = tools
    ? `Saved ${id}. Connection OK: ${tools.length} tool${tools.length === 1 ? "" : "s"} discovered${tools.length ? " (" + tools.slice(0, 12).join(", ") + (tools.length > 12 ? ", …" : "") + ")" : ""}.`
    : `Saved ${id}.${d.auth === "oauth-user" ? " Each user connects it from their own connectors page." : " Connection was not tested."}`;
  closeEditor();
  await load();
}

async function remove(item: McpServerView) {
  if (!confirm(`Delete the MCP server "${item.name}" (${item.id})? Its tools stop being available to the assistant.`))
    return;
  const res = await page.api("DELETE", "/api/mcp-servers/" + encodeURIComponent(item.id));
  state.notice = res.ok ? `Deleted ${item.id}.` : res.data?.message || "Could not delete this MCP server.";
  await load();
}

function credentialBadges(s: McpServerView) {
  if (s.auth === "bearer")
    return badge(s.hasBearerToken ? "Token stored" : "Token missing", s.hasBearerToken ? "ok" : "err");
  if (s.auth === "client-credentials")
    return badge(s.hasClientSecret ? "Secret stored" : "Secret missing", s.hasClientSecret ? "ok" : "err");
  if (s.auth === "oauth-user")
    return badge(s.hasClientSecret ? "Confidential client" : "Public client (PKCE)", "muted");
  return nothing;
}

function serverRows() {
  if (!state.servers.length) return html`<div class="hint">No MCP servers registered.</div>`;
  return repeat(
    state.servers,
    (s) => s.id,
    (s) => {
      const tools = toolsFor(s);
      return html`<div class="credential-row mcp-server-row" data-id=${s.id}>
        <div class="credential-main">
          <div class="credential-title"><strong>${s.name}</strong><span class="credential-slug">${s.id}</span></div>
          <div class="hint">${s.url}</div>
          <div class="hint">
            ${AUTH_LABEL[s.auth] ?? s.auth} ·
            ${s.credentialScope === "per-user" ? "per-user credentials" + (s.credentialHost ? " (" + s.credentialHost + ")" : "") : "shared credentials"}
            ${s.updatedBy ? " · by " + s.updatedBy : ""}${s.updatedAt ? " · " + new Date(s.updatedAt).toLocaleString() : ""}
          </div>
          <div class="credential-badges">
            ${badge(s.enabled ? "Enabled" : "Disabled", s.enabled ? "ok" : "warn")}
            ${s.readOnly ? badge("Trusted read-only", "warn", "Every tool is treated as read-only; writes are not blocked") : nothing}
            ${credentialBadges(s)}
            ${badge(tools.length + " tool" + (tools.length === 1 ? "" : "s"), tools.length ? "info" : "muted")}
          </div>
          ${
            tools.length
              ? html`<details class="mcp-tools">
                  <summary>Discovered tools</summary>
                  <ul>
                    ${tools.map(
                      (t) =>
                        html`<li>
                          <code>${t.name}</code>${t.readOnly ? html` ${badge("read-only", "muted")}` : nothing}
                          ${t.description ? html`<span class="hint"> — ${t.description}</span>` : nothing}
                        </li>`,
                    )}
                  </ul>
                </details>`
              : nothing
          }
        </div>
        <div class="credential-actions">
          <button class="btn" type="button" @click=${() => openEditor(s)}>Edit</button
          ><button
            type="button"
            class="btn compact rowbtn danger"
            aria-label=${"Delete " + s.name}
            @click=${() => remove(s)}
          >
            Delete
          </button>
        </div>
      </div>`;
    },
  );
}

function field(
  key: string,
  label: string,
  o: { placeholder?: string; type?: string; disabled?: boolean; hint?: string } = {},
) {
  return html`<label
    >${label}${o.hint ? html` <span class="label-detail">${o.hint}</span>` : nothing}<input
      id=${"mcp-server-" + key}
      type=${ifDefined(o.type)}
      .value=${state.draft[key] ?? ""}
      ?disabled=${!!o.disabled}
      autocomplete="off"
      placeholder=${ifDefined(o.placeholder)}
      @input=${(e: Event) => (state.draft[key] = (e.target as HTMLInputElement).value)}
  /></label>`;
}

function select(key: string, label: string, options: Record<string, string>, disabled = false) {
  return html`<label
    >${label}<select
      id=${"mcp-server-" + key}
      ?disabled=${disabled}
      @change=${(e: Event) => set(key, (e.target as HTMLSelectElement).value)}
    >
      ${Object.entries(options).map(
        ([value, text]) => html`<option value=${value} .selected=${state.draft[key] === value}>${text}</option>`,
      )}
    </select></label
  >`;
}

function check(key: string, label: string) {
  return html`<label class="inline"
    ><input
      type="checkbox"
      id=${"mcp-server-" + key}
      .checked=${!!state.draft[key]}
      @change=${(e: Event) => set(key, (e.target as HTMLInputElement).checked)}
    />
    ${label}</label
  >`;
}

function editorDialog() {
  const d = state.draft;
  const e = state.editing;
  const oauthUser = d.auth === "oauth-user";
  const perUser = oauthUser || d.credentialScope === "per-user";
  const tokenStored = e?.auth === "bearer" && e.hasBearerToken;
  const secretStored = (e?.auth === "client-credentials" || e?.auth === "oauth-user") && !!e?.hasClientSecret;
  return html`<dialog
    class="custom-provider-dialog"
    id="mcp-server-dialog"
    aria-labelledby="mcp-server-title"
    @cancel=${() => closeEditor()}
    @click=${(ev: MouseEvent) => {
      if (ev.target === ev.currentTarget) closeEditor();
    }}
  >
    <div class="project-dialog-head">
      <div>
        <h2 id="mcp-server-title">${e ? "Edit " + e.name : "Add MCP server"}</h2>
        <p>A Streamable HTTP MCP endpoint. Its tools become available to the assistant across the organization.</p>
      </div>
      <button class="project-icon-button" type="button" aria-label="Close" @click=${closeEditor}>×</button>
    </div>
    <div class="custom-provider-form">
      ${field("id", "Server id", { placeholder: "jira", disabled: !!e, hint: "lowercase slug, cannot change later" })}
      ${field("name", "Display name", { placeholder: "Jira" })}
      ${field("url", "URL", { placeholder: "https://mcp.example.internal/mcp" })}
      ${select("auth", "Authentication", AUTH_LABEL)}
      ${
        d.auth === "bearer"
          ? field("bearerToken", "Bearer token", {
              type: "password",
              placeholder: tokenStored ? "•••• stored (leave blank to keep)" : "write-only",
              hint: tokenStored ? "a token is stored; it is never shown" : "write-only",
            })
          : nothing
      }
      ${
        d.auth === "client-credentials"
          ? html`${field("clientId", "Client id")}
            ${field("clientSecret", "Client secret", {
              type: "password",
              placeholder: secretStored ? "•••• stored (leave blank to keep)" : "write-only",
              hint: secretStored ? "a secret is stored; it is never shown" : "write-only",
            })}`
          : nothing
      }
      ${
        oauthUser
          ? html`${field("clientId", "OAuth client id", { hint: "blank: use dynamic client registration" })}
            ${field("clientSecret", "OAuth client secret", {
              type: "password",
              placeholder: secretStored ? "•••• stored (leave blank to keep)" : "only for a confidential client",
              hint: secretStored
                ? "a secret is stored; it is never shown"
                : "write-only; leave blank for a public client",
            })}
            ${field("oauthAuthorizeUrl", "Authorize URL", { placeholder: "discovered when blank" })}
            ${field("oauthTokenUrl", "Token URL", { placeholder: "discovered when blank" })}
            ${field("oauthScopes", "Scopes", { placeholder: "space separated; discovered when blank" })}`
          : nothing
      }
      ${select(
        "credentialScope",
        "Credentials",
        { shared: "Shared: one credential for everyone", "per-user": "Per-user: each person uses their own" },
        oauthUser,
      )}
      ${
        perUser
          ? html`${field("credentialHost", "Credential host", {
              placeholder: "mcp.example.com",
              hint: "the host each user's credential is stored under",
            })}
            ${select("credentialAccountType", "Account type", {
              default: "Default",
              personal: "Personal",
              company: "Company",
            })}`
          : nothing
      }
      ${select("approval", "Approval", APPROVAL_LABEL)}
      ${check("readOnly", "Trust as read-only: offer all its tools even in read-only sessions. This does NOT block write tools; use only for servers that cannot write.")}
      ${check("enabled", "Enabled")}
      ${check("validate", oauthUser ? "Test connection on save (not available for per-user OAuth)" : "Test connection on save (lists the server's tools)")}
      <span
        class=${classMap({ status: true, err: state.error, saving: state.saving })}
        id="st-mcp-server"
        aria-live="polite"
        >${state.message}</span
      >
    </div>
    <div class="project-dialog-actions">
      <button class="btn" type="button" @click=${closeEditor}>Cancel</button
      ><button class="btn primary" id="mcp-server-save" ?disabled=${state.saving} @click=${save}>
        ${e ? "Save changes" : "Add server"}
      </button>
    </div>
  </dialog>`;
}

function template() {
  return html`<div id="view-mcp-servers">
    <section class="card" id="card-mcp-servers">
      <div class="head">
        <h2>MCP servers</h2>
        <p>
          Remote MCP servers whose tools the assistant can call. Only admins can register or change them here; the
          assistant cannot add servers for itself. Tokens and secrets are write-only and never displayed.
        </p>
      </div>
      <div class="body">
        ${state.failure ? html`<p class="hint" role="status">${state.failure}</p>` : nothing}
        ${state.notice ? html`<p class="hint" id="mcp-servers-notice" role="status">${state.notice}</p>` : nothing}
        <div id="mcp-server-list">${state.loaded ? serverRows() : html`<div class="hint">Loading…</div>`}</div>
      </div>
      <div class="foot">
        <button class="btn" type="button" id="add-mcp-server" @click=${() => openEditor()}>+ Add MCP server</button>
      </div>
    </section>
    ${editorDialog()}
  </div>`;
}
