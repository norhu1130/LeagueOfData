# `@lol/validate`

Semantic validation for canonical ASTs.

The package infers analysis grain, checks event and field availability, validates measure types and coordinate spaces, detects statistical caveats, and reports which AST fragments can be represented by visual cards.

Diagnostics carry stable codes, source ranges, localized user guidance, current/required context, and optional fixes. Validation never emits SQL.

Closed categorical fields are validated against catalog-owned values before execution. Coverage
classification treats victim-role membership, `all_values(...)`, and role-filtered follow-up
events as card-editable constructs rather than advanced DSL fragments.
