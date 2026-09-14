# `@lol/ast`

Canonical AST contract shared by the visual builder, DSL, persisted documents, workers, and backend requests.

## Modules

- `nodes.ts` — program, condition, event, measure, temporal, and spatial node types
- `schema.ts` — Zod validation for untrusted JSON and worker messages
- `normalize.ts` — one structural representation for equivalent syntax
- `canonical.ts` and `sha256.ts` — cross-language serialization and hashing
- `envelope.ts` — versioned persistence and transport envelope

Formatting metadata and source spans are excluded from semantic hashes. Every external AST must pass runtime validation and every AST producer must normalize its output.

Repeatable event references carry an ordinal of `any`, `first`, `last`, or a positive occurrence
number. The ordinal participates in the deterministic binding ID, so every field read from
`dragon_kill[2]` refers to the same second event row.
