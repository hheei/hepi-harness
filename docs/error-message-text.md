# Error message text

A caught value is `unknown`: a rejection can be a string, a plain object or a value from a port or WebView, and a
surface still has to render something. One pure formatter states the rule for both sides of the wire:

```ts
import { errorText } from "@hepi/protocol/error-text";
```

`errorText(error)` returns `error.message` when the value is an `Error` and `String(error)` otherwise. It is a
formatter and nothing else — it never redacts, shortens or classifies. Its dedicated `@hepi/protocol/error-text`
subpath lets callers use it without loading the protocol root barrel.

## What it does not own

Sanitization stays with the code that has the trust boundary. The Backend's is `safeFailure` in
`apps/server/src/public-errors.ts`: it applies the same formatting and then replaces a credential or configuration
failure message before it reaches an HTTP response, an SSE frame or a conversation entry. `errorText` is what that
function formats with; it is not interchangeable with it, and a caller that owes redaction must call the owner of the
redaction.

## Where it is used

Backend and Web callers in this migration that render a caught value as one line — route messages, warnings, panels,
hooks and file operations — import this function instead of spelling
`x instanceof Error ? x.message : String(x)` again. A place that needs something else from the value (a typed
`ResourceReadError` branch, an i18n fallback, a classification by `code`) keeps its own branch and calls
`errorText` only for the plain-message arm.
