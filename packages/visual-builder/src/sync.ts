import { astEquals, type Program } from '@lol/ast';
import { parse, printDsl } from '@lol/dsl';
import { coverage } from '@lol/validate';
import type { BuilderPatch, SyncDocument } from './model.js';
import { applyBuilderPatch } from './patch.js';

function stateOf(ast: Program): SyncDocument['state'] {
  return coverage(ast).full ? 'synced' : 'advanced';
}

export function createSyncDocument(ast: Program, dslText = printDsl(ast)): SyncDocument {
  return { ast, dslText, state: stateOf(ast), origin: 'builder', dslRev: 0, diagnostics: [] };
}

/** Never echoes source back into the DSL editor; failure retains the last successful AST. */
export function applyDslEdit(document: SyncDocument, dslText: string): SyncDocument {
  const parsed = parse(dslText);
  const hasErrors = parsed.diagnostics.some((item) => item.severity === 'error');
  if (!parsed.ast || hasErrors) {
    return {
      ...document,
      dslText,
      state: 'stale',
      origin: 'dsl',
      dslRev: document.dslRev + 1,
      diagnostics: parsed.diagnostics,
    };
  }
  return {
    ast: astEquals(document.ast, parsed.ast) ? document.ast : parsed.ast,
    dslText,
    state: stateOf(parsed.ast),
    origin: 'dsl',
    dslRev: document.dslRev + 1,
    diagnostics: parsed.diagnostics,
  };
}

/** Only builder patches print canonical DSL; patches leave advanced subtrees untouched. */
export function applyCardEdit(document: SyncDocument, patch: BuilderPatch): SyncDocument {
  const patched = applyBuilderPatch(document.ast, patch);
  if (astEquals(patched, document.ast)) return document;
  const dslText = printDsl(patched);
  // Reparse canonical output so node spans always address the text currently shown in the editor.
  const reparsed = parse(dslText);
  const hasErrors = reparsed.diagnostics.some((item) => item.severity === 'error');
  if (!reparsed.ast || hasErrors || !astEquals(reparsed.ast, patched)) return document;
  const ast = reparsed.ast;
  return {
    ast,
    dslText,
    state: stateOf(ast),
    origin: 'builder',
    dslRev: document.dslRev + 1,
    diagnostics: reparsed.diagnostics,
  };
}

export function shouldAcceptWorkerResult(responseRev: number, currentRev: number): boolean {
  return responseRev === currentRev;
}
