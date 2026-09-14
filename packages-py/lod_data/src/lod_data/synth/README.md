# Synthetic data

Deterministic generator for realistic, non-degenerate match relationships without Riot credentials.

Team strength is a shared latent cause of first blood, gold progression, objectives, and victory. This produces meaningful intersections instead of hard-coding isolated target rates.

- `params.py` — calibrated model parameters
- `generator.py` and `engine.py` — match and event generation
- `spatial.py` — lane and jungle position sampling
- `calibrate.py` — target-metric fitting
- `validate.py` — measurements taken from written Parquet data
- `writer.py` — partitioned output and manifest creation

Each simulation and materialization stream is derived from the global seed and absolute match
index. Logical match data therefore remains identical across chunk sizes and worker counts; only
the physical Parquet file grouping may differ.

Generation replaces the complete destination dataset after successfully staging every table. It
does not append to or mix with existing Riot or synthetic partitions.
