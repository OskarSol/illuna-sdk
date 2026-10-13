import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createClient } from "./client.js";
import type { IllunaClient } from "./client.js";
import type { Elements, Value } from "./index.js";

const Context = createContext<IllunaClient | null>(null);
export interface IllunaProviderProps {
  endpoint?: string; elements: Elements; pageId: string;
  /** Change this on login/logout to discard the previous user's browser state. */
  identityKey: string;
  timeoutMs?: number; children: ReactNode;
}
export function IllunaProvider({ endpoint = "/api/illuna", elements, pageId, identityKey, timeoutMs, children }: IllunaProviderProps) {
  const client = useMemo(() => createClient({ endpoint, elements, pageId, timeoutMs }), [endpoint, elements, pageId, identityKey, timeoutMs]);
  useEffect(() => {
    void client.refresh();
    function onFocus() { if (!client.getSnapshot().pending) void client.refresh(); }
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); client.cancel(); };
  }, [client]);
  return <Context.Provider value={client}>{children}</Context.Provider>;
}
function useClient() {
  const client = useContext(Context);
  if (!client) throw new Error("Place this component inside an IllunaProvider");
  return client;
}
/** Captures the current provider's page. No page or element list needed at the call site. */
export function useIlluna() {
  const client = useClient();
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getServerSnapshot);
  return { ...state, adapt: client.adapt, setValue: client.setValue, reset: client.reset, refresh: client.refresh };
}
export function useIllunaValue<T extends Value = Value>(id: string): T {
  const client = useClient();
  const value = useSyncExternalStore(client.subscribe, () => client.getSnapshot().values[id], () => client.getServerSnapshot().values[id]);
  if (value === undefined) throw new Error(`Element ${id} is not registered for the active page`);
  return value as T;
}
