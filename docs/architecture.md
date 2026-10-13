# Architecture, persistence and operations

Implementation reference for SDK 0.1.0. The host application owns identity, authorization, rendering and saved UI state. Illuna's upstream processor proposes changes. This SDK executes the host application's bounded UI changes; it does not add an execution-feedback call or implement Illuna preference memory.

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| Shared catalog | Stable keys, page membership, descriptions, types, defaults and constraints |
| React provider | Current page, cached values, pending/error state and rerendering |
| Application server | Identity, page authorization, catalog lookup, upstream call and validation |
| Storage adapter | Definition registry, user overrides and atomic optimistic concurrency |
| Illuna upstream | Return `message` and a bounded `updates` list under the versioned contract |

The server never trusts descriptions, defaults, identity or element lists supplied by the browser. The browser sends only the command, page ID and revision. A page ID selects a catalog scope; it does not grant access. Use `authorizePage` when pages have different authorization rules.

## Persistence

The SQLite adapter creates a file and four SDK-owned tables:

| Table | Key / purpose |
| --- | --- |
| `illuna_definitions` | `(app_id, element_key)`; JSON definition, including its default |
| `illuna_values` | `(app_id, user_id, element_key)`; typed JSON override and timestamp |
| `illuna_revisions` | `(app_id, user_id)`; monotonic state revision |
| `illuna_migrations` | Applied adapter schema version; currently version 1 |

The effective value is the stored override when present, otherwise the catalog default. Definitions and user values are never conflated. Booleans and numbers retain their JSON types. Initialization is idempotent and does not reset overrides. A changed catalog increments existing user revisions.

Reset deletes overrides for the active page plus any explicitly global definitions. Other pages remain unchanged. Removed definitions are no longer exposed; their old override rows are retained. Reusing a removed key may restore its old value, so use a new key for a different meaning. If a type or constraint change makes an existing override invalid, initialization fails instead of discarding user data. Migrate that data explicitly or introduce a new key.

Use stable application IDs and pseudonymous user IDs from authenticated server sessions. The SDK has no end-user account database and never creates login credentials.

## Adaptation lifecycle

1. React captures its active page and loaded revision when `adapt(message)` is called.
2. The server authorizes the user/page and loads current saved values.
3. It sends only page members and explicitly global members, with all metadata.
4. It validates the entire response: target, `field`, scalar type, constraints, count and duplicate consistency.
5. The adapter compares the original revision and writes the full batch in one transaction.
6. The response contains the persisted snapshot and actual before/after changes. React updates its cache.

An invalid update rejects the **entire** response; there is no partial apply. Empty updates and unchanged values succeed without creating a new revision. Exact string representations of numeric/boolean values are accepted for compatibility, then stored as typed values. Unknown keys and inactive-page keys are rejected.

A manual change or another tab's save during a long request causes HTTP 409 at commit. The React client reloads current values and shows the conflict; it never automatically repeats a potentially billable Illuna request. Revisions cover the user's whole application state, so simultaneous edits on different pages can also conflict. This conservative behavior is intentional in 0.1.

## Transport and timing

The default transport requires HTTPS, sends `x-api-key` and a generated `x-request-id`, rejects redirects and performs no retries. The upstream timeout is 360 seconds by default and configurable up to 900 seconds. React's default timeout is 390 seconds; if you increase the server timeout, increase the provider timeout accordingly.

Every hosting hop must allow the intended request duration. A browser timer is a waiting indicator, not progress from Illuna and not a keepalive. No job queue, asynchronous completion protocol or streaming is implemented. A custom `Transport` must honor the supplied AbortSignal; the SDK cannot forcibly stop arbitrary caller code.

## HTTP handler

| Route under `/api/illuna` | Request | Result |
| --- | --- | --- |
| `GET /state?pageId=normal` | Authenticated session | `{ pageId, values, revision }` |
| `POST /adapt` | `{ pageId, revision, message }` | Snapshot plus `message` and `applied` |
| `POST /set` | `{ pageId, revision, id, value }` | Saved snapshot |
| `POST /reset` | `{ pageId, revision }` | Snapshot after removing page overrides |

Mutations require JSON. The handler rejects cross-site requests and mismatched Origin headers. It emits no permissive CORS headers. For a reverse proxy, preserve the external Host header or configure exact `allowedOrigins`; keep your application's existing CSRF protection. Same-origin cookies are used by the browser client. `getIdentity` is required; unauthenticated requests receive 401.

Errors are JSON `{ code, error }`: invalid input 400, authentication 401, access/origin 403, state conflict 409, oversized input 413, content type 415, invalid/upstream response 502 and upstream timeout 504. No stack traces, credentials or raw upstream error bodies are returned.

## Deployment boundary

Use Node.js 24+ with a persistent local writable directory. SQLite uses the bundled `node:sqlite` synchronous API with WAL and a five-second busy timeout. That API's stability designation depends on your Node minor version; test and pin the supported Node release in your deployment. See [Node SQLite documentation](https://nodejs.org/api/sqlite.html).

Version 0.1 is intended for one Node application instance per local database file, with one catalog version. Do not place the SQLite file on a network share or an ephemeral serverless/container filesystem. For distributed deployments, implement the exported `Storage` interface using your existing database, preserving atomic revision comparison and batch writes. Such an adapter is an extension point, not a shipped PostgreSQL implementation.

The host supplies request throttling, account lifecycle/deletion, operational logging, backups and access controls. No user commands are logged by the SDK. The example's fixed identity is for a loopback-only local demo and must be replaced before exposing it to other users.

## Verification boundaries

Automated tests exercise a deterministic in-process transport and real SQLite/HTTP. They do not prove that the production n8n flow accepts this contract. The [backend migration instructions](protocol.md#backend-migration) are a required integration step for live use.
