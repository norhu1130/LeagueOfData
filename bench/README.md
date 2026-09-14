# Benchmarks

The benchmark harness runs representative golden ASTs through `PlanBuilder` and `DuckDBEngine` to detect execution regressions. Before timing, it verifies that the selected directory contains a manifest for exactly the requested dataset size. Reports include the resolved silver path, snapshot ID, manifest match count, warm p50/p95 latency, result counts, and peak RSS.

Coverage includes the six acceptance questions, high-cardinality grouping, comparison, spatial radius filters, and compound analyses.

```bash
# 10k workspace data: every p50 below 250 ms and RSS below 4 GB
uv run python bench/run_bench.py --dataset synth-10k --strict

# A separate 100k data root containing silver/: every p95 below 2 seconds and RSS below 4 GB
uv run python bench/run_bench.py --dataset synth-100k \
  --data-dir /path/to/synth-100k --strict
```

`synth-10k` defaults to the repository `data/` root. `synth-100k` defaults to `data/synth-100k/`; `--data-dir` or `LOD_DATA_DIR` can select another root containing `silver/`. A mismatched or missing manifest fails before timing.

Pass `--json <path>` to save machine-readable results. Strict mode uses two warmups and at least five measured samples. A first threshold breach is measured again before it fails, reducing sensitivity to one noisy batch. Inputs come from `tests/conformance/cases`, so benchmarks exercise the same AST shapes as engine integration tests.
