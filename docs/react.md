# React integration and page context

Use one `IllunaProvider` for the active screen. Its `pageId` is controlled by your router or tab state. The calculator uses two tabs so it needs no routing dependency.

```tsx
const [pageId, setPageId] = useState("normal");

<IllunaProvider elements={elements} pageId={pageId} identityKey={user.id}>
  <CurrentPage />
  <AdaptationControls />
</IllunaProvider>
```

For React Router, derive a stable page ID from the matched route; do not use unbounded record IDs or query strings as page names. Keep the definition catalog in a shared module, not freshly created on each render.

## What is automatic?

The app tells the provider which logical page is active once. Every `useIlluna().adapt(message)` call inside it automatically uses that page. The browser sends no element catalog. The server looks up all matching definitions and current saved values.

`pages: ["normal"]` belongs only to Normal. `pages: ["scientific"]` belongs only to Scientific. A property used by both pages can list both IDs and shares one saved value. `pages: ["*"]` explicitly includes a global property on every known page. A known page must have at least one explicitly registered property.

Selection is based on **logical page membership**, not DOM inspection or component mounting. A hidden panel's registered properties are still included if they belong to the page; otherwise Illuna could not turn it back on. Dynamic widget-level registration, nested active-page scopes and inferred routing are outside 0.1.

## Reading and changing values

```tsx
const title = useIllunaValue<string>("normal.title");
const fontSize = useIllunaValue<number>("normal.fontSize");
const showHint = useIllunaValue<boolean>("normal.showHint");
const illuna = useIlluna();

await illuna.adapt("Larger text, please.");
await illuna.setValue("normal.fontSize", 22); // no upstream model call
await illuna.reset();                       // this page's overrides only
```

The generic argument documents the component's expected scalar type; it is not inferred from string IDs. The server always validates against the catalog regardless of TypeScript declarations. Asking for a key outside the current page throws a developer error.

The provider uses a small browser store and React's `useSyncExternalStore`. A successful mutation response replaces the cached snapshot, so subscribed components rerender without polling. Values are loaded on mount, page/identity changes and window focus. `refresh()` is also available. No background cross-device synchronization or WebSocket connection is created.

## Navigation while an adaptation is pending

A request captures the page when it starts. Changing `pageId` creates a new page client, loads that page's saved state and cancels the old browser requests. A late result cannot replace the new page's cache.

Browser cancellation does not guarantee cancellation of upstream server processing. The old request may still commit to its **original** page if its revision remains current. It cannot retarget the new page. Returning to the original page loads the actual saved result. If you require “leaving a page must prevent any save,” add an explicit server cancellation protocol; it is not claimed by 0.1.

## Errors, authentication and defaults

- Render `error`, handle mutation rejections and disable controls until `ready` and while `pending`.
- Before loading completes, the hooks expose catalog defaults. Do not enable mutations during that interval.
- After a state conflict, the client reloads the latest values and exposes the error. Let the user decide whether to send another request.
- Set `identityKey` to your current authenticated account ID and change it on login/logout. It discards the previous browser cache. The backend still derives identity from its authenticated session.
- Render text as normal React text. Map numeric sizes/boolean visibility explicitly; never treat a returned string as trusted HTML or executable CSS.
- `applied` lists actual saved changes; an upstream message alone is not proof of execution.

The supplied demo is client-rendered. `getServerSnapshot` exposes defaults for deterministic initial rendering; persisted-state hydration and per-request server rendering are not part of the tested quickstart. See [React's external-store guidance](https://react.dev/reference/react/useSyncExternalStore) before extending this to SSR.
