# Web application

React and Vite application that presents onboarding, visual cards, the DSL editor, minimap regions, results, provenance, and match drill-down.

The visual builder exposes the full effective event catalog through a progressive card picker.
The current analysis stays visible as the primary canvas; the picker opens only when the user adds
a condition and shows one of event, position, numeric, or sequence setup at a time. Sequence cards
show explicit start-event, end-event, and time-window controls. Removable cards expose a delete
action, while saved analyses and user regions can be deleted from their respective libraries.
Analysis targets and condition actors are independent: event, position, and gold cards can refer to
the blue team, red team, or either team without changing which team's result is measured.

The dataset scope bar filters every analysis by the active snapshot's game modes and collection-time
match tier. These filters are sent separately from the DSL and participate in result-cache identity,
so changing a queue or tier cannot reuse a result computed for another population.

When OpenRouter is configured, the builder can turn a Korean or English question into DSL and the
result pane can request a grounded explanation. The browser never persists the API key. Generated
DSL is applied only after local syntax and semantic validation succeeds.
The bias-review action is available without AI: deterministic server rules inspect the current
analysis and show risks plus mitigations without changing the query. Completed results carry the
same audit into the optional AI explanation, so the model explains computed warnings rather than
deciding which matches to remove.

## Architecture

- `App.tsx` — document state, run lifecycle, builder/DSL switching, and result layout
- `MapPanel.tsx` — custom region creation, editing, deletion, SVG-coordinate conversion, and spatial result overlay
- `storage.ts` — IndexedDB documents, regions, preferences, and import/export
- `routes.ts` — dependency-free parsing and generation for analysis, match, region, and settings URLs
- `packages/analysis-client` — API and SSE transport
- `packages/visual-builder` — AST/card projection and patches

The minimap background is the pinned Summoner's Rift `map11.png` asset from Riot Games Data
Dragon 16.17.1. It is stored locally at `public/assets/summoners-rift-map-16.17.1.png` so region
editing works offline and cannot drift independently of the normalized coordinate overlay. Source:
`https://ddragon.leagueoflegends.com/cdn/16.17.1/img/map/map11.png`.

The canonical AST owns meaning. Raw DSL text is preserved while the editor is the origin, and invalid intermediate input never replaces the last valid AST.

Analysis URLs use `/a/:docId`. Match lists and match details extend that path with `/matches`
and `/matches/:matchId`; the saved document and its latest result are restored from IndexedDB on
reload. `/regions`, `/data-sources`, and `/settings` provide stable links to those application
panels. The data-source screen validates and switches between the local silver dataset and
session-scoped S3 or GCS Parquet connections; credentials are sent only to the loopback API and
never persisted by the browser.

Dragon event, position, comparison, and sequence cards expose catalog-driven type and occurrence
slots. Deleting the active analysis opens the next most recent saved analysis, or returns to home
when none remain.

Death cards identify their team as the victim's team and support one or several lane roles. Users
can choose whether any selected role or every selected role must die. Sequence cards expose the
same role controls on their end event. When an analysis contains a numbered generic dragon event,
the grouping menu offers that occurrence's elemental dragon type; legacy first-blood region
grouping is shown only in a compatible first-blood team analysis.

```bash
pnpm -F @lol/web dev
pnpm -F @lol/web build
pnpm test:e2e
```
