# End-to-end tests

Playwright tests that exercise the user-visible acceptance workflow against the real web application and API.

Coverage includes the six onboarding analyses, visual-card changes, DSL synchronization, custom polygon binding and reload persistence, comparisons, and match drill-down. Import/export, analysis-document reopening, cancellation, and network-recovery flows require separate tests before they can be considered covered.

```bash
pnpm test:e2e
```

Synthetic data and generated reference artifacts must exist before the suite starts.
