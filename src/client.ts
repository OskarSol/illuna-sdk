import { elementsForPage, IllunaError } from "./index.js";
import type { AdaptResult, Elements, Snapshot, Value } from "./index.js";

export interface ClientState extends Snapshot {
  ready: boolean; pending: boolean; error: string | null; message: string;
  applied: AdaptResult["applied"];
}
export interface ClientOptions { endpoint: string; elements: Elements; pageId: string; timeoutMs?: number }
export function createClient(options: ClientOptions) {
  const selected = elementsForPage(options.elements, options.pageId);
  const initial: ClientState = {
    pageId: options.pageId, revision: 0,
    values: Object.fromEntries(Object.entries(selected).map(([id, d]) => [id, d.defaultValue])),
    ready: false, pending: false, error: null, message: "", applied: [],
  };
  let state = initial; let generation = 0;
  const listeners = new Set<() => void>(); const controllers = new Set<AbortController>();
  const endpoint = options.endpoint.replace(/\/$/, "");
  function update(next: Partial<ClientState>) { state = { ...state, ...next }; for (const notify of listeners) notify(); }
  async function request(path: string, body?: unknown): Promise<Snapshot | AdaptResult> {
    const controller = new AbortController(); controllers.add(controller);
    try {
      const response = await fetch(endpoint + path, {
        method: body ? "POST" : "GET", credentials: "same-origin",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 390_000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new IllunaError(data.code ?? "HTTP_ERROR", data.error ?? "The request failed", response.status);
      if (!data || data.pageId !== options.pageId || typeof data.revision !== "number" || !data.values || typeof data.values !== "object") throw new IllunaError("INVALID_RESPONSE", "The application server returned an invalid state");
      return data;
    } finally { controllers.delete(controller); }
  }
  async function refresh() {
    const run = ++generation;
    update({ pending: true, error: null });
    try {
      const data = await request("/state?pageId=" + encodeURIComponent(options.pageId));
      if (run === generation) update({ ...data, ready: true });
    } catch (error) {
      if (run === generation) update({ error: error instanceof Error ? error.message : "Loading failed" });
    } finally { if (run === generation) update({ pending: false }); }
  }
  async function mutate(path: string, extra: Record<string, unknown>): Promise<Snapshot | AdaptResult> {
    if (!state.ready || state.pending) throw new IllunaError("BUSY", "Wait until the current request has finished", 409);
    const run = ++generation;
    update({ pending: true, error: null, message: "", applied: [] });
    try {
      const result = await request(path, { ...extra, pageId: options.pageId, revision: state.revision });
      if (run === generation) update({ ...result, ready: true });
      return result;
    } catch (error) {
      if (run === generation) {
        if (error instanceof IllunaError && error.code === "CONFLICT") {
          try { const latest = await request("/state?pageId=" + encodeURIComponent(options.pageId)); if (run === generation) update(latest); } catch { /* preserve the original conflict */ }
        }
        if (run === generation) update({ error: error instanceof Error ? error.message : "The request failed" });
      }
      throw error;
    } finally { if (run === generation) update({ pending: false }); }
  }
  return {
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    refresh,
    adapt: (message: string) => mutate("/adapt", { message }) as Promise<AdaptResult>,
    setValue: (id: string, value: Value) => mutate("/set", { id, value }),
    reset: () => mutate("/reset", {}),
    cancel() { ++generation; for (const controller of controllers) controller.abort(); controllers.clear(); update({ pending: false }); },
  };
}
export type IllunaClient = ReturnType<typeof createClient>;
