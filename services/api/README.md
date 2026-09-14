# Analytics API

Local FastAPI service that accepts versioned AST JSON, compiles an engine-neutral physical plan, and executes it over Parquet with DuckDB. It never exposes an arbitrary SQL endpoint.

## Pipeline

```text
AST envelope -> validation -> PlanBuilder -> PhysicalPlan -> ExecutionEngine -> AnalysisResponse
```

- [`compile`](./src/lod_api/compile/) — physical IR and SQL lowering
- [`engine`](./src/lod_api/engine/) — execution protocol and DuckDB implementation
- [`routers`](./src/lod_api/routers/) — run, SSE, catalog, and health endpoints
- `runs.py` — lifecycle, cancellation, snapshot-aware cache, and result envelope
- `catalog.py` — generated catalog loading and schema-drift checks
- `db.py` — shared DuckDB instance and Parquet views

## API

| Method | Path                               | Purpose                                     |
| ------ | ---------------------------------- | ------------------------------------------- |
| POST   | `/api/v1/analyses/run`             | Start an AST run                            |
| GET    | `/api/v1/runs/{id}/events`         | Stream progress and the terminal result     |
| DELETE | `/api/v1/runs/{id}`                | Cancel a run                                |
| GET    | `/api/v1/runs/{id}/explain`        | Return generated SQL and condition metadata |
| GET    | `/api/v1/runs/{id}/matches`        | Page through included matches               |
| GET    | `/api/v1/matches/{id}?runId=...`   | Return match details and witnesses          |
| POST   | `/api/v1/analyses/bias-audit`      | Inspect deterministic observational risks   |
| GET    | `/api/v1/catalog`                  | Return language and dataset facets          |
| GET    | `/api/v1/ai/status`                | Report optional AI availability and model   |
| PUT    | `/api/v1/ai/config`                | Set an in-memory OpenRouter key             |
| DELETE | `/api/v1/ai/config`                | Clear the in-memory OpenRouter key          |
| POST   | `/api/v1/ai/dsl`                   | Draft constrained DSL from a question       |
| POST   | `/api/v1/ai/interpret`             | Explain a bounded, computed result payload  |
| GET    | `/api/v1/data-sources`             | List local and session object-store sources |
| POST   | `/api/v1/data-sources`             | Validate, connect, and activate S3/GCS      |
| PUT    | `/api/v1/data-sources/{id}/active` | Switch the active analysis dataset          |
| DELETE | `/api/v1/data-sources/{id}`        | Forget a session connection                 |

```bash
uv run --directory services/api pytest
uv run uvicorn lod_api.main:app --app-dir services/api/src --reload
```

Wheel builds bundle the generated semantic catalog so catalog loading does not depend on a repository checkout. Match data remains external and is selected with `LOD_DATA_DIR`.

## S3 and GCS Parquet sources

Remote sources use DuckDB's `httpfs` extension. Install the version-matched extension once in the
API runtime or bake it into the production image; request handlers deliberately never download
executable extensions:

```bash
uv run --project services/api python -c "import duckdb; c=duckdb.connect(); c.execute('INSTALL httpfs')"
```

The selected URI must be the root of a League of Data silver dataset. It must contain
`_manifest.json` and all seven Hive-partitioned Parquet table directories. S3 access keys and GCS
interoperability HMAC keys are installed as scoped, temporary DuckDB secrets and retained only in
API process memory. Deleting a connection never modifies remote objects.

## Optional OpenRouter gateway

Set `LOD_OPENROUTER_API_KEY` for persistent local configuration. The model defaults to
`openai/gpt-5.6-luna` and can be changed with `LOD_OPENROUTER_MODEL`. A key submitted to the config
endpoint is wrapped as a secret and retained only in process memory; status responses and logs do
not expose it.

The gateway requests strict JSON-schema responses. DSL generation receives the generated EBNF,
operator precedence, parser/engine/card capability matrix, complete function signatures, event
context fields, valid grains, available events, landmarks, and `{id, label}` region references.
Only constructs marked `aiGenerate` may be emitted. Result interpretation receives only whitelisted
aggregate, provenance, coverage, and caveat fields; raw minimap points are excluded and table rows
are capped.

Bias handling is deliberately split: `bias.py` deterministically inspects the validated plan and
computed comparison sizes, while the AI interpreter may only explain those warnings. The audit
never rewrites a condition, excludes a match, or claims causal adjustment. Item-purchase analyses
are flagged because the current event means “purchased at least once during the whole match”; the
AI must not invent cutoff-time or inventory-state syntax.

## Dataset capabilities

`/api/v1/catalog` applies the active silver dataset manifest's `source` field to the static
catalog. The response includes `datasetSource` and `sourceCapabilities`; event `available` flags
and each event's `context` list are the effective values the planner enforces. The effective hash
also participates in the run request contract, so changing from synthetic to Riot data invalidates
stale catalog clients.

Run requests may select `dataset.queue` and `dataset.tier`. Both are compiled as bound DuckDB
parameters, included in provenance, and applied to the base match population before event joins.

The runtime overrides are intentionally limited to omissions confirmed by the current normalizer:

- `synthetic_v1` preserves the complete generated catalog.
- `riot_v5` marks `recall` unavailable because Riot timelines do not emit recall events.
- `riot_v5` removes `position` from `ward_placed` and `ward_destroyed` because those timeline
  events do not carry coordinates.

Match-detail responses intentionally omit Riot account identifiers (`puuid`, Riot ID, and summoner
name). Those fields stay in the local normalized dataset for explicit offline analysis only.

Numbered event witnesses use deterministic timestamp/event-ID ordering. The compiler applies the
same ordinal semantics to filters, event fields, temporal-chain triggers, and temporal-chain
targets. Dragon subtype variants remain catalog SQL bindings rather than compiler special cases.
Follow-up field filters are correlated to the selected target row. A chain followed by
`success_rate()` keeps every trigger in the denominator; other measures filter to successful
chains, so loss rate, win rate, count, provenance, and drill-down all use the same included units.
The provenance funnel reports the follow-up step independently.
