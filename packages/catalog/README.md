# `@lol/catalog`

Single semantic source of truth for events, fields, functions, group keys, landmarks, diagnostics,
SQL bindings, and the versioned DSL capability manifest.

TypeScript definitions generate `data/reference/catalog.json`, which is consumed by both the frontend and Python compiler. Event semantics must not be duplicated in the compiler.

## Commands

```bash
pnpm -F @lol/catalog build:json
pnpm test packages/catalog/test
pnpm check:reference
```

Adding a catalog entry requires an identifier, localized UI metadata, availability state, valid grains, and a valid SQL binding where applicable.

`src/language.ts` distinguishes syntax accepted by the parser from syntax executable by the engine
and syntax editable by visual cards. AI generation may emit only entries with `aiGenerate: true`.
The generated manifest is included in the catalog hash, so a grammar capability change cannot
silently leave the API or AI prompt on an older contract.

Dragon subtype choices are catalog-owned qualifiers. Each choice maps to an executable event
variant, including a forward-compatible `other_dragon_kill` bucket, so cards, completion, the
compiler, and AI generation share one subtype vocabulary.

Categorical context fields may declare `allowedValues`. The victim-role field uses the closed
`TOP`, `JUNGLE`, `MID`, `BOT`, and `SUPPORT` vocabulary, preventing misspellings from silently
returning an empty result. Event metadata also declares whether its team is the actor or victim.

`dragon_soul_acquired` is an executable derived event backed by the fourth elemental-dragon view.
`team_aced` remains explicitly unavailable because the normalized timeline does not contain the
complete respawn state needed to identify an ace without guessing.
