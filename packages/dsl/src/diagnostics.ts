/**
 * Parser diagnostics.
 *
 * Section 29 requires structured current/required context rather than a generic syntax error,
 * plus an automatic fix where possible. User-facing messages avoid implementation terms.
 */
import type { Span } from '@lol/ast';

export interface DiagnosticSlot {
  readonly labelKo: string;
  readonly items: readonly string[];
}

export interface QuickFix {
  readonly titleKo: string;
  readonly span: Span;
  readonly newText: string;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'hint';
  readonly span: Span;
  readonly titleKo: string;
  readonly bodyKo: string;
  /** What is currently present. */
  readonly got?: DiagnosticSlot;
  /** What should be present. */
  readonly need?: DiagnosticSlot;
  readonly quickFixes?: readonly QuickFix[];
  /** Used by the builder to associate the diagnostic with a card. */
  readonly astPath?: string;
}

export function errorAt(
  code: string,
  span: Span,
  titleKo: string,
  bodyKo: string,
  extra: Partial<Diagnostic> = {},
): Diagnostic {
  return { code, severity: 'error', span, titleKo, bodyKo, ...extra };
}

export const got = (labelKo: string, ...items: string[]): DiagnosticSlot => ({ labelKo, items });
export const need = (labelKo: string, ...items: string[]): DiagnosticSlot => ({ labelKo, items });

/** Sorts diagnostics by source location and removes duplicates at the same location. */
export function normalizeDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return [...diagnostics]
    .sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1])
    .filter((d) => {
      const key = `${d.code}:${d.span[0]}:${d.span[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
