# LoL Match Analytics IDE

A local analytics environment for exploring League of Legends match data with a composable, domain-specific language.

This is not a match-history site or a fixed dashboard. It combines three systems:

- **Analytics DSL** — a declarative language for LoL match questions
- **Visual builder** — sentence-like cards that produce the same analysis without code
- **Vectorized engine** — a DuckDB service that analyzes partitioned Parquet data

The visual builder and DSL editor share one canonical AST and can switch between views without changing the meaning of an analysis.

## Quick start

```bash
pnpm install && uv sync
pnpm gen:reference
uv run lod-data synth --n 10000 --seed 20260914
uv run lod-data validate
pnpm dev
```

The web application runs on `http://127.0.0.1:5173` and the API on `http://127.0.0.1:8000`. If data is missing, `/readyz` reports the command required to generate it.

## Optional AI assistance

The application can draft validated DSL and explain completed engine results through OpenRouter.
The default model is `openai/gpt-5.6-luna`. Copy `.env.example` to `.env`, add the key, and restart
the API for persistent configuration. A key entered on the Settings screen is held only in the
local API process memory and is cleared on restart; it is never stored in browser storage.

AI output is advisory. Generated DSL must pass the same parser and semantic validation as manually
written DSL before it can replace the current analysis. Interpretations receive a bounded,
map-point-free result summary and may only describe numbers already computed by the engine.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm test:py
pnpm lint
pnpm check:reference
pnpm test:e2e
uv run python bench/run_bench.py --dataset synth-10k --strict
```

## Riot data

The collector stores Match-V5 responses as compressed bronze data before normalization and resumes interrupted work from a SQLite checkpoint. API keys are accepted only through the environment.

```bash
export RIOT_API_KEY='...'
uv run lod-data collect --routing asia --puuid '<PUUID>' --count 100
uv run lod-data normalize-riot
uv run lod-data info
```

For a bounded breadth-first crawl, put `RIOT_API_KEY` in the gitignored `.env` file and start from
a Riot ID. This example collects ranked solo (420) and Swiftplay (480), discovers the PUUIDs in
each accepted match, and repeats up to the configured player, match, and depth limits:

```bash
uv run lod-data crawl --riot-id 'Hide on bush#KR1' \
  --riot-id 'Example Player#KR1' \
  --queue 420 --queue 480 \
  --matches-per-player 20 --max-players 25 --max-depth 2
```

Crawler normalization runs by default, and the completed-match count is unlimited unless
`--max-matches` is supplied. Surrenders and remakes are excluded before timeline
download and also rejected during normalization. Participant solo-rank entries are captured at
collection time; the match tier used by the IDE is the median of the available participant tiers.
The crawler stores a player-and-queue cursor in `data/bronze/checkpoint.sqlite3`. Repeating the same
command continues with the next Match-V5 page, keeps existing bronze matches, and rebuilds silver
from the complete cumulative bronze collection. Use `tee -a riot-crawl.log` if the crawl log should
also be appended instead of replaced.
Use the crawl limits deliberately: participant expansion is a network crawl and is not a random or
representative sample of the entire regional population.

## Repository map

```text
apps/web              React application and analysis workspace
packages/             TypeScript domain and UI packages
packages-py/lod_data  Parquet schemas, synthetic data, and Riot ingestion
services/api          FastAPI service and DuckDB execution engine
data/                 Generated and collected runtime data
tests/conformance     Shared TypeScript/Python golden cases
tests/e2e             Playwright acceptance tests
bench/                 Performance regression harness
```

Detailed ownership, public APIs, and development commands are documented in each directory:

- [Web application](apps/web/README.md)
- [TypeScript packages](packages/README.md)
- [Python data package](packages-py/lod_data/README.md)
- [Analytics API](services/api/README.md)
- [Runtime data](data/README.md)
- [Benchmarks](bench/README.md)
- [Tests](tests/README.md)

## Core invariants

### Coordinates

Stored and queried coordinates use the game orientation. The y-axis is inverted only when converting to screen pixels. Both axes use the same normalization span so circles remain circles and spatial radii remain meaningful.

### Single semantic sources

Coordinate constants and built-in regions live in `packages/data-model`. Events, functions, diagnostics, and SQL bindings live in `packages/catalog`. Python consumes generated reference artifacts instead of redefining them. `pnpm check:reference` detects drift.

### Canonical AST

Formatting, comments, spans, and redundant parentheses are not semantic state. Every AST producer passes through normalization, and TypeScript and Python must produce identical canonical hashes. The hash keys result caches and drill-down artifacts.

### No arbitrary SQL boundary

The API accepts versioned AST JSON, never arbitrary SQL. SQL is generated only from validated AST nodes and catalog-owned bindings.

### Reproducible synthetic data

Synthetic matches are driven by a latent team-strength variable rather than hard-coded outcomes. A fixed seed produces a stable snapshot, and `lod-data validate` remeasures target metrics directly from generated Parquet files.

### Observational language

Results describe observed associations, include a baseline and confidence interval where applicable, and never claim that a condition caused the outcome.

## License

The source code in this repository is available under the custom
[League of Data Source-Available License 1.0](LICENSE). It permits noncommercial personal use;
company, institutional, and commercial use requires Use Case registration and written permission.
Send the registration request to the licensing email listed in the repository owner's GitHub
profile or repository metadata. If no licensing email is listed, open a GitHub Issue to request a
private contact channel. Riot Games assets and properties remain the property of their respective
owners.

## Riot Games notice

League of Data isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
Games or anyone officially involved in producing or managing Riot Games properties. Riot Games,
and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
