# Runtime data

This directory contains source responses, normalized analytics tables, generated reference artifacts, and per-run materializations. Most contents are reproducible and intentionally excluded from Git.

## Layout

- `bronze/` — compressed original Riot API responses retained for reprocessing
- `silver/` — normalized Parquet tables partitioned by patch, queue, and region
- `gold/` — precomputed summaries used by recurring analyses
- `reference/` — catalog, region, and JSON Schema artifacts generated from TypeScript sources
- `runs/` — temporary matched-unit materializations used by drill-down requests
- `_riot_checkpoint.sqlite3` — resumable Riot collection state

## Generate and inspect

```bash
pnpm gen:reference
uv run lod-data synth --n 10000 --seed 20260914
uv run lod-data validate
uv run lod-data info
```

`silver/_manifest.json` contains the content-derived `snapshot_id` used in API cache keys. Do not edit reference files by hand; regenerate them from their source packages.
