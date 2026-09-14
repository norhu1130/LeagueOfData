# `@lol/data-model`

Cross-language contracts for map coordinates, region definitions, shared result shapes, and generated reference data.

## Coordinate rule

Game and normalized coordinates preserve the game y-axis. Only screen conversion flips y. Both axes use `MAP_SPAN = 15000`, preserving isotropic distance.

Built-in regions are defined here and exported to `data/reference`; Python loads the generated artifact instead of maintaining a second copy.

```bash
pnpm -F @lol/data-model export-reference
pnpm -F @lol/data-model export-region-golden
pnpm test packages/data-model/test
```
