# Conformance cases

Shared golden fixtures that force TypeScript and Python to agree on language semantics.

Each case contains DSL input, canonical AST, canonical printer output, diagnostics, canonical hash data, and metadata. The source definitions live in `packages/dsl/scripts/cases.ts`. Python consumes the canonical AST and hash fixtures; engine integration tests execute supported cases against generated data. SQL and result payloads are not golden files.

```bash
pnpm gen:conformance
pnpm test
pnpm test:py
```

Regenerate the complete fixture set instead of editing generated case files by hand.
