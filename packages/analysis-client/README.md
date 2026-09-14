# `@lol/analysis-client`

Typed browser client for the local analytics API. It submits AST requests, follows run progress over SSE, cancels work, and retrieves explanations and drill-down data.

## Public API

- `AnalysisClient` — catalog, run, cancel, explain, match-list, and match-detail requests
- `EffectiveCatalog` — complete effective event/context definitions, source capability restrictions,
  and dataset facets
- `AnalysisResponse` and `ComparisonPayload` — result/provenance contracts with
  unit-discriminated comparison differences
- `AnalysisApiError` — HTTP status, API diagnostic code, localized message, and structured detail
- `AnalysisClient.subscribe` — SSE lifecycle adapter with terminal-event cleanup and typed
  connection/payload error reporting
- `AnalysisSubscriptionError` and `AnalysisSubscriptionOptions` — typed subscription failures
  and an optional error callback
- shared request and response types used by the web application

This package knows the HTTP contract but does not interpret result semantics or choose visualizations.

```bash
pnpm test packages/analysis-client/test
pnpm -F @lol/analysis-client exec tsc --noEmit
```
