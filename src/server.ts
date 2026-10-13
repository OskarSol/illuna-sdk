import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineElements, elementsForPage, IllunaError, LIMITS, validateValue, assertKey } from "./index.js";
import type { AdaptResult, Elements, Snapshot, Value } from "./index.js";
import type { Storage, StoredState } from "./storage.js";
export type { Storage, Scope, StoredState } from "./storage.js";

export interface Identity { userId: string; sessionId: string }
export interface WireElement {
  description: string; type: "string" | "number" | "boolean";
  value: Value; default_value: Value; label?: string; category?: string;
  constraints?: { allowedValues?: readonly Value[]; maxLength?: number; min?: number; max?: number };
}
export interface AdaptPayload {
  contract_version: "illuna.ui.v1";
  message: string;
  ui_elements: Record<string, WireElement>;
  page_id: string;
  user_id: string; app_id: string; session_id: string;
  system_context: { instructions: string; available_actions: never[] };
}
export type Transport = (payload: AdaptPayload, context: { signal: AbortSignal; requestId: string }) => Promise<unknown>;
export interface ServerOptions {
  appId: string; elements: Elements; storage: Storage;
  endpoint?: string; apiKey?: string; timeoutMs?: number;
  /** Override for tests or an application-owned transport. Never supplied by the browser. */
  transport?: Transport;
}
export interface NodeHandlerOptions {
  getIdentity: (req: IncomingMessage) => Identity | null | Promise<Identity | null>;
  basePath?: string;
  allowedOrigins?: readonly string[];
  /** Page selection is not authorization. Supply this for pages with different access rules. */
  authorizePage?: (identity: Identity, pageId: string) => boolean | Promise<boolean>;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new IllunaError("INVALID_REVISION", "A valid revision is required");
}
async function readResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new IllunaError("UPSTREAM_ERROR", `Illuna returned HTTP ${response.status}`, 502);
  if (!response.body) throw new IllunaError("INVALID_RESPONSE", "Illuna returned no response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > LIMITS.bodyBytes) { await reader.cancel(); throw new IllunaError("INVALID_RESPONSE", "Illuna response is too large", 502); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof IllunaError) throw error;
    throw new IllunaError("INVALID_RESPONSE", "Illuna returned invalid JSON", 502);
  } finally { reader.releaseLock(); }
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= LIMITS.bodyBytes) chunks.push(chunk); });
    req.on("error", reject);
    req.on("end", () => {
      if (size > LIMITS.bodyBytes) return reject(new IllunaError("BODY_TOO_LARGE", "Request body is too large", 413));
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!record(body)) throw new Error(); resolve(body);
      } catch { reject(new IllunaError("INVALID_JSON", "Expected a JSON object")); }
    });
  });
}

export function createIlluna(options: ServerOptions) {
  assertKey(options.appId);
  // Own a copy so UI code or a caller cannot mutate the trusted catalog after initialization.
  const elements = defineElements(structuredClone(options.elements));
  const timeoutMs = options.timeoutMs ?? 360_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new IllunaError("INVALID_CONFIG", "timeoutMs must be between 1 and 900000");
  if (!options.transport) {
    if (!options.endpoint || !options.apiKey) throw new IllunaError("INVALID_CONFIG", "An Illuna endpoint and API key are required");
    const url = new URL(options.endpoint);
    if (url.protocol !== "https:") throw new IllunaError("INVALID_CONFIG", "The upstream endpoint must use HTTPS");
  }
  let initialized = false;
  function scope(identity: Identity) {
    if (typeof identity?.userId !== "string" || typeof identity.sessionId !== "string" || !identity.userId || !identity.sessionId || identity.userId.length > 200 || identity.sessionId.length > 200) throw new IllunaError("UNAUTHORIZED", "An authenticated identity is required", 401);
    if (!initialized) throw new IllunaError("NOT_INITIALIZED", "Call initialize() before serving requests", 503);
    return { appId: options.appId, userId: identity.userId };
  }
  function snapshot(stored: StoredState, pageId: string): Snapshot {
    const selected = elementsForPage(elements, pageId);
    return { pageId, revision: stored.revision, values: Object.fromEntries(Object.entries(selected).map(([id, d]) => [id, Object.hasOwn(stored.values, id) ? stored.values[id] : d.defaultValue])) };
  }
  function payload(identity: Identity, state: Snapshot, message: string): AdaptPayload {
    const selected = elementsForPage(elements, state.pageId);
    return {
      contract_version: "illuna.ui.v1", message, page_id: state.pageId,
      app_id: options.appId, user_id: identity.userId, session_id: identity.sessionId,
      ui_elements: Object.fromEntries(Object.entries(selected).map(([id, d]) => [id, {
        description: d.description, type: d.valueType, value: state.values[id], default_value: d.defaultValue,
        ...(d.label ? { label: d.label } : {}), ...(d.category ? { category: d.category } : {}),
        ...(d.constraints ? { constraints: d.constraints } : {}),
      }])),
      system_context: {
        instructions: "Return only a JSON object with message and updates. Each update has id, field: Value, and new_value. Adapt only the supplied UI elements. Respect each description, type and constraints. Return updates: [] for clarification or no change. Do not claim changes have already been saved. Do not execute actions or write external preference memory.",
        available_actions: [],
      },
    };
  }
  function updatesFrom(raw: unknown, selected: Elements): Record<string, Value> {
    if (!record(raw) || typeof raw.message !== "string" || raw.message.length > 2000 || !Array.isArray(raw.updates) || raw.updates.length > LIMITS.updates) throw new IllunaError("INVALID_RESPONSE", "Expected message and a bounded updates array", 502);
    const changes: Record<string, Value> = Object.create(null);
    for (const update of raw.updates) {
      if (!record(update) || typeof update.id !== "string" || !Object.hasOwn(selected, update.id) || update.field !== "Value") throw new IllunaError("INVALID_UPDATE", "An update targets an unsupported element or field", 502);
      const def = selected[update.id]; let value = update.new_value;
      // Accept exact scalar strings from the existing Illuna response convention.
      if (def.valueType === "boolean" && (value === "true" || value === "false")) value = value === "true";
      if (def.valueType === "number" && typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
      try { validateValue(def, value); } catch { throw new IllunaError("INVALID_UPDATE", `Invalid value for ${update.id}`, 502); }
      if (Object.hasOwn(changes, update.id) && changes[update.id] !== value) throw new IllunaError("INVALID_UPDATE", "Conflicting duplicate updates", 502);
      changes[update.id] = value;
    }
    return changes;
  }
  const api = {
    async initialize() { await options.storage.initialize(options.appId, elements); initialized = true; },
    async getState(identity: Identity, pageId: string) {
      const s = scope(identity); elementsForPage(elements, pageId);
      return snapshot(await options.storage.read(s), pageId);
    },
    async adapt(identity: Identity, input: { pageId: string; message: string; revision: number }): Promise<AdaptResult> {
      const s = scope(identity); requireRevision(input.revision);
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > LIMITS.message) throw new IllunaError("INVALID_MESSAGE", `Provide a command of 1–${LIMITS.message} characters`);
      const selected = elementsForPage(elements, input.pageId);
      const before = snapshot(await options.storage.read(s), input.pageId);
      if (before.revision !== input.revision) throw new IllunaError("CONFLICT", "Refresh before sending another adaptation", 409);
      const request = payload(identity, before, input.message.trim());
      if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.bodyBytes) throw new IllunaError("PAYLOAD_TOO_LARGE", "The page context is too large", 413);
      const signal = AbortSignal.timeout(timeoutMs); const requestId = randomUUID(); let raw: unknown;
      try {
        raw = options.transport
          ? await options.transport(request, { signal, requestId })
          : await readResponse(await fetch(options.endpoint!, {
            method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", "x-api-key": options.apiKey!, "x-request-id": requestId },
            body: JSON.stringify(request),
          }));
        if (signal.aborted) throw new IllunaError("TIMEOUT", "Illuna did not finish in time", 504);
      } catch (error) {
        if (signal.aborted) throw new IllunaError("TIMEOUT", "Illuna did not finish in time", 504);
        if (error instanceof IllunaError) throw error;
        throw new IllunaError("UPSTREAM_ERROR", "Illuna could not be reached", 502);
      }
      if (Buffer.byteLength(JSON.stringify(raw) ?? "") > LIMITS.bodyBytes) throw new IllunaError("INVALID_RESPONSE", "Illuna response is too large", 502);
      const changes = updatesFrom(raw, selected);
      const applied = Object.entries(changes).filter(([id, value]) => before.values[id] !== value).map(([id, value]) => ({ id, previousValue: before.values[id], value }));
      const saved = await options.storage.commit(s, before.revision, Object.fromEntries(applied.map(c => [c.id, c.value])));
      return { ...snapshot(saved, input.pageId), message: (raw as { message: string }).message, applied };
    },
    async setValue(identity: Identity, input: { pageId: string; id: string; value: Value; revision: number }): Promise<Snapshot> {
      const s = scope(identity); requireRevision(input.revision);
      const selected = elementsForPage(elements, input.pageId);
      if (!Object.hasOwn(selected, input.id)) throw new IllunaError("UNKNOWN_ELEMENT", "Element is not available on this page");
      validateValue(selected[input.id], input.value);
      return snapshot(await options.storage.commit(s, input.revision, { [input.id]: input.value }), input.pageId);
    },
    async reset(identity: Identity, input: { pageId: string; revision: number }): Promise<Snapshot> {
      const s = scope(identity); requireRevision(input.revision);
      const selected = elementsForPage(elements, input.pageId);
      return snapshot(await options.storage.commit(s, input.revision, Object.fromEntries(Object.keys(selected).map(id => [id, null]))), input.pageId);
    },
    createNodeHandler(config: NodeHandlerOptions) {
      const base = (config.basePath ?? "/api/illuna").replace(/\/$/, "");
      return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        function json(status: number, body: unknown) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); }
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const route = url.pathname.slice(base.length);
          if (!url.pathname.startsWith(base + "/") || !["/state", "/adapt", "/set", "/reset"].includes(route)) return json(404, { error: "Not found", code: "NOT_FOUND" });
          if (req.method !== (route === "/state" ? "GET" : "POST")) return json(405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
          const identity = await config.getIdentity(req);
          if (!identity) throw new IllunaError("UNAUTHORIZED", "Sign in to use Illuna", 401);
          let body: Record<string, unknown> = {};
          if (req.method === "POST") {
            if (req.headers["sec-fetch-site"] === "cross-site") throw new IllunaError("FORBIDDEN", "Cross-site requests are not accepted", 403);
            const origin = req.headers.origin;
            if (origin && !(config.allowedOrigins ? config.allowedOrigins.includes(origin) : new URL(origin).host === req.headers.host)) throw new IllunaError("FORBIDDEN", "Origin is not allowed", 403);
            if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new IllunaError("INVALID_CONTENT_TYPE", "Use application/json", 415);
            body = await readBody(req);
          }
          const pageId = req.method === "GET" ? url.searchParams.get("pageId") : body.pageId;
          if (typeof pageId !== "string") throw new IllunaError("UNKNOWN_PAGE", "pageId is required");
          if (config.authorizePage && !await config.authorizePage(identity, pageId)) throw new IllunaError("FORBIDDEN", "Page access is denied", 403);
          if (route === "/state") return json(200, await api.getState(identity, pageId));
          requireRevision(body.revision);
          if (route === "/adapt") return json(200, await api.adapt(identity, { pageId, revision: body.revision, message: body.message as string }));
          if (route === "/set") {
            if (typeof body.id !== "string") throw new IllunaError("UNKNOWN_ELEMENT", "id is required");
            return json(200, await api.setValue(identity, { pageId, revision: body.revision, id: body.id, value: body.value as Value }));
          }
          return json(200, await api.reset(identity, { pageId, revision: body.revision }));
        } catch (error) {
          const e = error instanceof IllunaError ? error : new IllunaError("INTERNAL_ERROR", "The request could not be saved", 500);
          json(e.status, { error: e.message, code: e.code });
        }
      };
    },
    async close() { initialized = false; await options.storage.close(); },
  };
  return api;
}
