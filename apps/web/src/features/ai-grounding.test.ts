import { describe, expect, it } from 'vitest';
import { questionScopedChampionReferences } from './useChampionMetadata.js';
import { questionScopedItemReferences } from './useItemMetadata.js';

describe('question-scoped AI entity grounding', () => {
  it('sends only champion names actually mentioned in the question', () => {
    const references = questionScopedChampionReferences('애쉬 세라핀 조합 승률', [
      { value: 'Ashe', localizedName: '애쉬' },
      { value: 'Seraphine', localizedName: '세라핀' },
      { value: 'Rakan', localizedName: '라칸' },
    ]);

    expect(references).toEqual([
      { value: 'Ashe', aliases: ['애쉬'] },
      { value: 'Seraphine', aliases: ['세라핀'] },
    ]);
  });

  it('does not match short English champion names inside another word', () => {
    expect(
      questionScopedChampionReferences('show vision score', [
        { value: 'Vi', localizedName: '바이' },
      ]),
    ).toEqual([]);
  });

  it('sends only a localized item explicitly named in the question', () => {
    expect(
      questionScopedItemReferences('존야의 모래시계 구매 후 승률', [
        { id: 3157, name: '존야의 모래시계' },
        { id: 3089, name: '라바돈의 죽음모자' },
      ]),
    ).toEqual([{ id: 3157, aliases: ['존야의 모래시계'] }]);
  });

  it('uses Data Dragon colloquial item aliases without exposing the whole item list', () => {
    expect(
      questionScopedItemReferences('존야 구매 후 승률', [
        { id: 3157, name: '존야의 모래시계', aliases: ['존야'] },
        { id: 3089, name: '라바돈의 죽음모자', aliases: ['라바돈'] },
      ]),
    ).toEqual([{ id: 3157, aliases: ['존야의 모래시계', '존야'] }]);
  });
});
