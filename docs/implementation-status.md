# Implementation status

Last verified: 2026-09-14

Local implementation of milestones M0–M8 and acceptance questions A–F is complete. Completion here means the code, synthetic data, and browser workflow were verified locally. Live Riot-account collection remains a separate operational check requiring a user-provided API key.

| Milestone | Status   | Verified output                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| M0        | Complete | pnpm/uv workspaces, shared coordinates and regions, web/API startup, CI workflow                             |
| M1        | Complete | Seven 10k synthetic Parquet tables, calibration, validation, and resumable Riot ingestion                    |
| M2        | Complete | TypeScript catalog generation, Python loading, schema health, and dynamic dataset facets                     |
| M3        | Complete | Runtime AST schema, recursive-descent/Pratt parser, printer, property round trips, and cross-language hashes |
| M4        | Complete | Type, grain, and coverage validation; partial-AST recovery; localized diagnostics; Monaco fixes              |
| M5        | Complete | PhysicalPlan IR, shared result/provenance scan, DuckDB execution, SSE, cancellation, and cache               |
| M6        | Complete | Card projection and local patches, synchronization states, lazy Monaco, and bidirectional editing            |
| M7        | Complete | SVG region editing, automatic binding, canvas heatmap, charts, export, and explanation panels                |
| M8        | Complete | A–F onboarding, IndexedDB documents and regions, import conflict handling, drill-down, and benchmarks        |

## Automated verification baseline

- TypeScript: 313 tests across 19 files
- Python: 202 tests
- Chromium E2E: 15 scenarios covering A–F, opposite-team event conditions, the complete card library, card/document/region deletion, explicit sequence endpoints, click-accurate region persistence, comparison, drill-down, deep-link restoration, and narrow-screen navigation
- Typecheck, Ruff, Prettier, production Vite build, and catalog/reference checks passed
- Catalog: 21 events (20 available), 14 functions, 6 grouping keys, and 38 diagnostics
- Geometry: 16 presets checked against 1,691 shared TypeScript/Python points
- Dataset readiness: seven silver tables
- Dataset snapshot: `sha256:0d4c8c0e081f4415718922f2c5b46365`

## Synthetic 10k metrics

| Metric                                        |           Value |
| --------------------------------------------- | --------------: |
| Overall blue win rate                         |          50.90% |
| First-blood team win rate                     |          60.18% |
| Top-lane first-blood team win rate            |          64.21% |
| Win rate with a 1,500-gold lead at 10 minutes |          69.55% |
| First blood to first turret, mean / median    | 199.4s / 194.7s |
| Dragon within 90 seconds after a kill         |          17.96% |

## Performance gates

The 10k strict gate requires p50 below 250 ms for every representative query and peak RSS below 4 GB. The 100k gate requires p95 below two seconds and the same RSS ceiling. The harness rejects a dataset whose manifest count does not match the selected 10k/100k profile, uses two warmups, and confirms an initial threshold breach with another measured batch. JSON reports record the resolved data path, snapshot ID, manifest row count, sample count, latency, and RSS; retain those reports with environment metadata when publishing benchmark numbers.

## Reproduce verification

```sh
pnpm install --frozen-lockfile
uv sync --frozen
pnpm check:reference
pnpm typecheck
pnpm test
uv run pytest -q
pnpm lint
uv run lod-data synth --n 10000 --seed 20260914
uv run lod-data validate
uv run python bench/run_bench.py --dataset synth-10k --strict \
  --json bench/results/local-10k.json
pnpm -F @lol/web build
pnpm test:e2e
```

## External operational check

Riot ingestion is verified with mocked responses and file normalization. Live network collection requires `RIOT_API_KEY`; the key is never written to logs or persisted data.

The catalog derives effective event capabilities from the dataset source. Riot datasets disable
recall events and ward-position context that Match-V5 timelines cannot provide, while synthetic
datasets retain the full development catalog.
