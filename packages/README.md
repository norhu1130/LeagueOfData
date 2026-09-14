# TypeScript packages

These workspace packages separate the language, shared contracts, editor integrations, visual builder, and presentation logic.

| Package                                      | Responsibility                                            |
| -------------------------------------------- | --------------------------------------------------------- |
| [`@lol/analysis-client`](./analysis-client/) | API, SSE, cancellation, and drill-down client             |
| [`@lol/ast`](./ast/)                         | Canonical AST, runtime schema, envelopes, and hashes      |
| [`@lol/catalog`](./catalog/)                 | Semantic catalog and SQL binding source of truth          |
| [`@lol/charts`](./charts/)                   | Result-shape-driven chart selection and rendering helpers |
| [`@lol/data-model`](./data-model/)           | Coordinates, regions, and cross-language contracts        |
| [`@lol/dsl`](./dsl/)                         | Lexer, parser, printer, recovery, and diagnostics         |
| [`@lol/map-editor`](./map-editor/)           | Minimap region drawing and geometry editing               |
| [`@lol/monaco-lang`](./monaco-lang/)         | Monaco language services for the DSL                      |
| [`@lol/ui`](./ui/)                           | Reserved shared design-system boundary                    |
| [`@lol/validate`](./validate/)               | Semantic validation, grain inference, and card coverage   |
| [`@lol/visual-builder`](./visual-builder/)   | AST-to-card projection, patches, and synchronization      |

Use `pnpm -r typecheck` and `pnpm -r test` to verify the package graph.
