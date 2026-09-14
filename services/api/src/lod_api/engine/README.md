# Execution engine

Boundary between physical plans and concrete analytics engines.

`ExecutionEngine` defines capabilities, execution, explanation, and cancellation. `DuckDBEngine` executes result and provenance SQL, uses native interruption, samples map positions, and lazily materializes matched units for drill-down.

Results cross this boundary as Arrow tables so a future engine can be introduced without changing HTTP serialization or DSL packages.
