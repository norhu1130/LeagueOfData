# `@lol/monaco-lang`

Monaco language contribution for the analytics DSL.

It registers syntax highlighting, catalog-aware completion, hover text, signature help, formatting, diagnostics, code actions, inlay hints, and region navigation. User-facing documentation remains localized while inserted DSL tokens remain English.

Context-aware inline completion renders VS Code-style ghost text and accepts it with `Tab`. It suggests a starter analysis for an empty document, events after `WHEN`, measures after `RETURN`, grouping keys after `GROUP BY`, and catalog fields after an event dot. `Ctrl+Space` continues to open the full completion list.

Monaco is loaded lazily by the web application so onboarding does not pay the editor bundle cost.
