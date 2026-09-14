# Cross-package tests

Repository-level tests verify contracts that cannot be owned by a single package.

- [`conformance`](./conformance/) — shared golden cases for TypeScript and Python
- [`e2e`](./e2e/) — Playwright acceptance coverage for the complete user workflow

Package-local unit and property tests remain next to their owning packages.

```bash
pnpm test
pnpm test:py
pnpm test:e2e
```
