# `lod_data`

Python package and `lod-data` CLI for creating the Parquet dataset consumed by the analytics engine.

## Responsibilities

- shared Arrow and Parquet schemas
- deterministic synthetic match generation and calibration
- Riot Match-V5 collection, checkpointing, and normalization
- coordinate and region conformance helpers
- DuckDB views and dataset manifests
- post-generation quality validation

```bash
uv run lod-data synth --n 10000 --seed 20260914
uv run lod-data validate
uv run lod-data info
uv run --directory packages-py/lod_data pytest
```

Riot normalization uses all but one logical CPU by default and reports throughput and ETA. Use
`lod-data normalize-riot --workers 4`, `--workers 1` for sequential troubleshooting, or
`--no-progress` for quiet logs.

The package owns physical data contracts, not DSL semantics. Built-in regions come from the generated TypeScript artifact. Wheel builds bundle that artifact, while editable monorepo development uses `data/reference/regions_builtin.json`.

Dataset writes use replace semantics: a complete generation is staged beside the destination and
then swapped into place. Point synthetic and Riot normalization commands at different output paths
when both datasets must be retained.

## Spatial and event-origin contracts

The shared normalized coordinate space and built-in regions describe Summoner's Rift (`mapId=11`)
only. Riot matches from ARAM or any other map are excluded during normalization and reported in the
manifest; they are never mixed into a spatially queryable Summoner's Rift dataset.

Schema version 2 adds the non-null `events.event_origin` column:

- `observed` — an event present in the Riot timeline
- `inferred_rule` — an event derived from documented patch rules, such as objective spawns
- `synthetic` — an event produced by the deterministic generator

Consumers must retain this column in event bindings and surface a derivation caveat whenever an
analysis uses `inferred_rule` rows. Existing schema-version-1 Parquet datasets must be regenerated.
Manifests summarize these capabilities in `eventOrigins` and `inferredEventTypes` so consumers do
not need to scan event rows to determine whether a result may include derived events.

Schema version 5 widens participant inventory and event item IDs to unsigned 32-bit integers.
This preserves the six-digit transformed item IDs emitted by Swiftplay. It also drops Riot's
`championId: -1` placeholder from normalized ban lists. Older Parquet datasets must be regenerated
before they are combined with version 5 data.

`v_deaths` enriches kill events with the victim participant's role and uses the victim team as the
event team. `v_dragon_soul_acquired` deterministically selects each team's fourth elemental dragon.
No ace view is synthesized: exact ace detection requires respawn-state data that the current
normalized contract does not retain.
