# Compiler

Transforms validated ASTs into an engine-neutral `PhysicalPlan` and parameterized SQL.

The planner resolves grain, unifies event witnesses, collects frame probes, lowers atomic predicates, reconstructs boolean expressions, lowers measures, and weaves provenance counts into the same scan.

User values are always parameters. SQL identifiers can originate only from validated catalog bindings.

For a chain target scoped as `opponent`, SQL correlates the follow-up event with
`target.team_id <> trigger.team_id`. The relation is evaluated per trigger event and therefore
works for triggers from either side.
