# Python packages

Python packages provide data ingestion, normalization, generation, and validation. They do not parse the DSL or own semantic catalog definitions.

- [`lod_data`](./lod_data/) — the `lod-data` CLI and Parquet data pipeline

The API service is kept under `services/api` because it is independently runnable and consumes `lod_data` as a dependency.
