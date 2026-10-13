# SDK wire contract: illuna.ui.v1

Canonical contract for SDK 0.1.0. This is a new rich-element request shape. It does **not** silently replace the Laravel portal's existing scalar-map contract. The SDK always sends descriptions and types inside `ui_elements`; no metadata-free fallback exists.

## Request

The Node server makes an HTTPS POST with `Content-Type: application/json`, `x-api-key` and `x-request-id`. Keys remain server-side. Example:

```json
{
  "contract_version": "illuna.ui.v1",
  "message": "Make the text larger and hide the hint.",
  "page_id": "normal",
  "app_id": "calculator-demo",
  "user_id": "local-demo-user",
  "session_id": "local-demo-session",
  "ui_elements": {
    "normal.fontSize": {
      "description": "Calculator button text size in pixels.",
      "type": "number",
      "value": 18,
      "default_value": 18,
      "category": "font",
      "constraints": { "min": 14, "max": 28 }
    },
    "normal.showHint": {
      "description": "Show the explanatory hint below the calculator heading.",
      "type": "boolean",
      "value": true,
      "default_value": true,
      "category": "visibility"
    }
  },
  "system_context": {
    "instructions": "Return a bounded proposal for the supplied elements. Do not claim execution or write external memory.",
    "available_actions": []
  }
}
```

This abbreviated example omits the calculator's title target. Actual requests include every registered property for the active page plus any explicit global properties, not every page in the application.

| Element field | Meaning |
| --- | --- |
| Map key | Stable target ID; response `id` must exactly match it |
| `description` | Required meaning and purpose of the property |
| `type` | Required `string`, `number` or `boolean` |
| `value` | Current effective value loaded by the server |
| `default_value` | Application-defined fallback |
| `label`, `category` | Optional additional context |
| `constraints` | Optional `allowedValues`, `maxLength`, `min`, `max` |

The revision stays between the browser and application server; it is not an instruction for the model. The SDK sends no chat history, DOM, calculation input, hidden-page catalog, API key in the body or automatic execution feedback.

## Response

```json
{
  "message": "I suggest larger text and hiding the hint.",
  "updates": [
    { "id": "normal.fontSize", "field": "Value", "new_value": 22 },
    { "id": "normal.showHint", "field": "Value", "new_value": false }
  ]
}
```

Return one JSON object. `message` is required, at most 2,000 characters. `updates` is required and can be empty. Maximum 25 updates and 64 KiB body. The response has no model-chosen URLs, SQL, executable actions or new definitions. Only `field: "Value"` is supported.

Prefer correctly typed scalar `new_value` values. For compatibility, exact `"true"`/`"false"` strings and finite JSON-number strings are converted when the registered type requires them. String definitions do not coerce numbers or booleans into text. Constraints are enforced after conversion. The SDK rejects wrapper arrays, fenced JSON, prose-only replies and nested `output[].content[].text` envelopes; normalize these at the upstream boundary.

Unknown/off-page targets, invalid types/ranges and conflicting duplicates reject the entire batch. Identical duplicate updates are combined. The application only reports a successful save after its own database commit.

## Backend migration

The current Illuna portal sends `ui_elements` values as strings. This SDK sends an object for each value. Route by `contract_version` or use a dedicated SDK-compatible endpoint while preserving portal traffic.

For the n8n workflow:

1. Authenticate the API key and bind the allowed application/user scope server-side.
2. Read the request body and verify `contract_version === "illuna.ui.v1"`.
3. Pass the complete `ui_elements` JSON to the UIAdapter's model input. Preserve descriptions, types, defaults, constraints and current values; do not flatten it back into `id → value`.
4. Also pass the instructions in `system_context` and the current page context. Apply host-specific external-memory restrictions deterministically; a prompt sentence does not enforce them.
5. Return the single response object above from every reachable branch. Clarification/no-op branches return `updates: []`.
6. Exercise a request for each page, plus an intentionally invalid/off-page result, before enabling live mode.

The documented historical export does not prove these steps are implemented. No production workflow was modified by creating this SDK. See the central [integration gap register](https://github.com/OskarSol/illuna/blob/main/docs/technical/backend/07-integration-gaps.md).

## Compatibility policy

The package is pre-1.0. Keep the two example repositories on tested revisions and use lockfiles. A future incompatible wire format must get a new `contract_version`; metadata must never be silently dropped to support an old endpoint.
