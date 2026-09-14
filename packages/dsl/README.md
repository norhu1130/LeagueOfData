# `@lol/dsl`

Lexer, recovery parser, canonical printer, formatter, and source diagnostics for the LoL analytics DSL.

The parser combines recursive descent for clauses with Pratt parsing for expressions. Invalid editor input returns a partial AST containing recovery nodes instead of throwing, allowing the last valid visual projection to remain available.

## Invariants

- `parse(print(parse(source)))` preserves the AST.
- Printing is idempotent.
- Event binding identifiers are deterministic.
- Duration and clock literals preserve the intended semantics.

Property and conformance tests are hard gates for visual-builder integration.

## Relative team scope

Temporal chains can bind the follow-up event to the trigger event's opposing team:

```lolq
AFTER team.ward_placed WITHIN 90s IF opponent.baron_kill
RETURN success_rate()
```

`opponent` is valid only on the follow-up event. It is resolved for every trigger row rather than
being treated as a fixed blue or red side.

Follow-up events can carry a correlated field filter. The filter is evaluated on the same event
row that satisfies the time window:

```lolq
ANALYZE team
AFTER dragon_kill[4] WITHIN 90s IF death.role IN ("TOP", "MID")
RETURN loss_rate()
```

`IN` means at least one selected value occurs. Wrap membership with `all_values(...)` when each
selected value must occur at least once. For non-`success_rate()` measures, a successful follow-up
is an eligibility filter; `success_rate()` instead retains every trigger in its denominator.

Champion pick rate uses one match as one denominator unit, so mirror picks cannot push the result
above 100%:

```text
ANALYZE match
RETURN pick_rate("Ahri")
```

## Event occurrence and dragon type

Use `event[n]` to select a numbered occurrence, for example `team.dragon_kill[2]`. Dragon types
have executable surfaces such as `chemtech_dragon_kill`, `hextech_dragon_kill`, and
`elder_dragon_kill`; they can also be numbered, as in `chemtech_dragon_kill[2]`.
