# `@lol/visual-builder`

Projection and synchronization layer between the canonical AST and sentence-like analysis cards.

## Responsibilities

- project supported AST fragments into stable card identities
- preserve unsupported subtrees as locked advanced cards
- apply local card patches without rebuilding unrelated AST nodes
- manage synchronized, advanced, and stale editor states
- ignore obsolete worker responses by revision

The AST is the only semantic source of truth. When DSL input is temporarily invalid, the package retains the last successful AST and marks the visual projection stale.

Sequence cards expose the trigger team and follow-up team independently. The follow-up selector
also supports “the trigger event's opposing team,” which round-trips through the DSL as the
`opponent` scope.
