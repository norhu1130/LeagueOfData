import { catalog } from '@lol/catalog';
import { parse } from '@lol/dsl';
import { validate } from '@lol/validate';
import { describe, expect, it } from 'vitest';

describe('catalog AI recipes', () => {
  it('keeps every natural-language recipe executable', () => {
    expect(catalog.aiRecipes.length).toBeGreaterThanOrEqual(8);
    for (const recipe of catalog.aiRecipes) {
      const parsed = parse(recipe.dsl);
      const diagnostics = [
        ...parsed.diagnostics,
        ...(parsed.ast ? validate(parsed.ast, { regionIds: [] }).diagnostics : []),
      ].filter((diagnostic) => diagnostic.severity === 'error');
      expect(diagnostics, recipe.id).toEqual([]);
    }
  });
});
