# Riot ingestion

Resumable Riot Match-V5 collection and normalization pipeline.

## Flow

1. `client.py` applies application and method rate limits and treats HTTP 429 as coordinated backpressure.
2. `collector.py` stores original JSON as compressed bronze records and persists progress through
   `checkpoint.py`.
3. `normalize.py` converts one Match-V5 match and timeline pair to the shared Arrow schemas.
4. `writer.py` normalizes bronze records in bounded batches and atomically replaces the target
   silver dataset after all batches are written.

`RIOT_API_KEY` is read only from the environment and must never be logged or persisted.

Normalization atomically rebuilds silver from the complete cumulative Riot bronze collection. Use
a distinct output directory if an existing synthetic dataset must be retained.

## Dataset validity

The canonical map coordinates and region library are Summoner's Rift-specific. `normalize.py`
therefore accepts only `mapId=11`. Other maps are intentional exclusions, not malformed records,
and are listed separately in `normalizationExclusions`.

Every Riot manifest includes `normalizationQuality` with `attempted`, `completed`, `failed`, and
`excluded` counts plus rates and exclusion reasons. Detailed corrupt-record failures remain in
`normalizationFailures`. A valid accounting satisfies:

```text
attempted = completed + failed + excluded
```

Timeline events carry `event_origin=observed`. Objective spawn rows synthesized from patch rules
carry `event_origin=inferred_rule` and retain `event_subtype=INFERRED_RULE` for compatibility.
