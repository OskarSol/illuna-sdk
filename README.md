# Illuna SDK

Page-scoped UI adaptation for React. Define adaptable properties once, connect your application server, and call:

```tsx
const illuna = useIlluna();
await illuna.adapt("Make the text larger and hide the hint.");
```

The server selects the active page's elements, sends **descriptions, types, current values, defaults and constraints** to Illuna, validates the response and saves the changes atomically. React renders the saved values.

**Status:** version 0.1.0, an intentionally small implementation. Node.js 24+ and React 18.2/19. The package is not published to npm. The existing Laravel portal contract is unchanged; this SDK uses the versioned [rich-element contract](docs/protocol.md). Production n8n compatibility has not been verified.

## Try it in under 30 minutes

The [two-page calculator](https://github.com/OskarSol/illuna-sdk-test) is the runnable quickstart. Clone the repositories as siblings:

```bash
git clone https://github.com/OskarSol/illuna-sdk.git
git clone https://github.com/OskarSol/illuna-sdk-test.git
cd illuna-sdk
npm ci
npm run build
cd ../illuna-sdk-test
npm ci
npm run dev
```

Open http://127.0.0.1:5173. No credentials are needed in the explicitly labeled local demo mode. Private repositories require your normal GitHub authentication.

Try “Larger text”, “Hide the hint”, and “Title: My calculator”. Switch between Normal and Scientific, then reload: values persist separately. Expand “What gets sent?” to inspect the active context.

## 1. Define the elements

Keep the catalog in one shared module imported by the server and React. Define it outside React components.

```ts
import { defineElements } from "@illuna/sdk";

export const elements = defineElements({
  "normal.title": {
    pages: ["normal"],
    description: "Heading above the normal calculator",
    valueType: "string",
    defaultValue: "Calculator",
    constraints: { maxLength: 40 },
  },
  "scientific.title": {
    pages: ["scientific"],
    description: "Heading above the scientific calculator",
    valueType: "string",
    defaultValue: "Scientific calculator",
    constraints: { maxLength: 40 },
  },
});
```

Version 0.1 supports `string`, `number` and `boolean`. `label` and `category` are optional metadata. Constraints support `allowedValues`, `maxLength`, `min` and `max`. Describe the property's meaning and valid adaptation, not just its appearance.

## 2. Connect the application server

```ts
import { createServer } from "node:http";
import { createIlluna } from "@illuna/sdk/server";
import { sqliteStorage } from "@illuna/sdk/storage/sqlite";
import { elements } from "./elements.js";
import { getAuthenticatedSession } from "./your-auth.js";

const illuna = createIlluna({
  appId: "my-app",
  elements,
  endpoint: process.env.ILLUNA_API_URL,
  apiKey: process.env.ILLUNA_API_KEY,
  storage: sqliteStorage("./data/illuna.sqlite"),
});
await illuna.initialize();

createServer(illuna.createNodeHandler({
  getIdentity: async request => {
    const session = await getAuthenticatedSession(request);
    return session
      ? { userId: session.userId, sessionId: session.id }
      : null;
  },
})).listen(8787, "127.0.0.1");
```

`getAuthenticatedSession` belongs to your host app, not this SDK. The [calculator server](https://github.com/OskarSol/illuna-sdk-test/blob/main/server/index.ts) is a complete runnable alternative using a fixed local demo identity. Keep the upstream API key on the server. Use a same-origin proxy from React to `/api/illuna`.

`initialize()` creates the SDK tables and syncs the catalog. Existing user values are preserved. Node's bundled `node:sqlite` API is used, so no additional database service or native npm addon is required. See [storage and operations](docs/architecture.md) for deployment constraints and schema changes.

## 3. Connect React to the current page

```tsx
import { IllunaProvider, useIlluna, useIllunaValue } from "@illuna/sdk/react";
import { elements } from "./elements";

function Heading({ pageId }: { pageId: "normal" | "scientific" }) {
  const title = useIllunaValue<string>(`${pageId}.title`);
  const illuna = useIlluna();
  return <>
    <h1>{title}</h1>
    <button disabled={!illuna.ready || illuna.pending}
      onClick={() => { void illuna.adapt("Use a friendlier heading.").catch(() => {}); }}>
      Adapt
    </button>
    {illuna.error && <p role="alert">{illuna.error}</p>}
  </>;
}

// pageId comes from your router or active-tab state; user.id comes from your login state.
<IllunaProvider elements={elements} pageId={pageId} identityKey={user.id}>
  <Heading pageId={pageId} />
</IllunaProvider>
```

The provider owns page context. No page ID, payload, key or element list is passed to `adapt()`. `identityKey` resets browser state when the user changes; it is **not** sent as an authentication credential. See [React integration](docs/react.md) for navigation and error handling.

## Public entry points

| Import | Exports |
| --- | --- |
| `@illuna/sdk` | `defineElements`, `elementsForPage`, shared types and limits |
| `@illuna/sdk/server` | `createIlluna`, `Storage`, `Transport`, server contract types |
| `@illuna/sdk/storage/sqlite` | `sqliteStorage` |
| `@illuna/sdk/react` | `IllunaProvider`, `useIlluna`, `useIllunaValue` |
| `@illuna/sdk/client` | Small browser client used by the React provider |

The React entry point imports no Node modules or database driver. React is an optional peer dependency; server-only consumers do not need it.

## Methods available from useIlluna()

| Method | Behavior |
| --- | --- |
| `adapt(message)` | Request, validate and automatically apply allowed changes for the current page |
| `setValue(id, value)` | Save a direct control change without an AI call |
| `reset()` | Remove overrides for the current page, including explicitly shared elements |
| `refresh()` | Reload the current page's saved state |

State includes `ready`, `pending`, `error`, `message`, `values`, `revision`, `pageId` and `applied` (actual before/after changes). Mutation promises reject on failure; show `error` and handle rejections. `message` is the upstream reply, not proof that something was saved; `applied` is the persistence result.

## Scope and limits

- One active page per provider; shared elements require an explicit `pages: ["*"]` definition.
- At most 50 elements per page, 25 updates per response, 1,000 command characters and 64 KiB request/response bodies.
- Strings are limited to 500 characters or a smaller per-element `maxLength`.
- Application and user scope is mandatory. No profiles, session-only preferences, arbitrary HTML/CSS, domain actions, UI discovery, streaming, background jobs, approval flow or undo in 0.1.
- The demo controls UI text, font size and hint visibility. Calculator operands/results are never part of the adaptation catalog.

## Development and package installation

```bash
npm ci
npm test
npm pack
```

Install the resulting tarball in another app with `npm install /path/to/illuna-sdk-0.1.0.tgz`. `npm pack` builds distributable JavaScript and declarations. GitHub source checkouts require `npm run build` before use. No npm publication or credentials are necessary.

Tests cover payload metadata, page/user isolation, atomic rejection, stale replies, persistence, reset, HTTP identity and upstream failures. The demo contains browser checks for navigation, reactivity and reload persistence.

## Documentation

- [Architecture, persistence and operations](docs/architecture.md)
- [Versioned wire contract and backend migration](docs/protocol.md)
- [React page context and lifecycle](docs/react.md)
- [Central Illuna SDK documentation](https://github.com/OskarSol/illuna/tree/main/docs/technical/sdk)

Licensed under [Apache-2.0](LICENSE). Existing Illuna brand rights are unaffected.
