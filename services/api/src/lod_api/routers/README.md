# API routers

Thin HTTP adapters around catalog access and `RunManager`.

- `analyses.py` — run creation, SSE events, cancellation, explanation, and drill-down
- `catalog.py` — semantic catalog and dataset facets
- `health.py` — liveness, readiness, and catalog/schema integrity

Routers validate transport data and map domain failures to HTTP responses. Planning and execution logic belong outside this package.
