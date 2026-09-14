import { expect, test, type Page } from '@playwright/test';

async function openExample(page: Page, title: string) {
  await page.locator('.sidebar .doc-item').filter({ hasText: title }).last().click();
  await expect(page.locator('.result-pane h2')).not.toHaveText('—');
  await expect(page.locator('.run-phase')).toHaveCount(0);
}

async function openCardPicker(
  page: Page,
  kind: '사건' | '아이템 대응' | '위치' | '수치 차이' | '이어지는 사건' = '사건',
) {
  await page.getByRole('button', { name: '조건 카드 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '무엇을 분석에 추가할까요?' });
  await expect(dialog).toBeVisible();
  if (kind !== '사건') await dialog.getByRole('button', { name: kind, exact: true }).click();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('League of Data', { exact: true })).toBeVisible();
});

test('shows the required Riot Games non-endorsement notice', async ({ page }) => {
  await expect(page.getByRole('contentinfo')).toContainText(
    "League of Data isn't endorsed by Riot Games",
  );
  await expect(page.getByRole('contentinfo')).toContainText(
    'Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.',
  );
});

test('builds and edits an item-response analysis with friendly pickers', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const dialog = await openCardPicker(page, '아이템 대응');
  await dialog.getByRole('button', { name: /상대 구매 기준/ }).click();
  await dialog.getByLabel('추가할 아이템 대응 상대 구매자').selectOption('champion');
  const champion = dialog.getByLabel('추가할 아이템 대응 상대 챔피언');
  const purchased = dialog.getByLabel('추가할 상대 아이템 추가할 아이템');
  const missing = dialog.getByLabel('추가할 우리 팀 아이템 추가할 아이템');
  await expect(champion.locator('option')).not.toHaveCount(0);
  await expect(purchased.locator('option')).not.toHaveCount(0);
  await expect(missing.locator('option')).not.toHaveCount(0);
  await dialog.getByLabel('추가할 상대 아이템 구매 방식').selectOption('none');
  if ((await missing.locator('option').count()) > 0)
    await dialog.getByRole('button', { name: '아이템 추가' }).last().click();
  await dialog.getByRole('button', { name: '아이템 조건 만들기' }).click();

  await expect(page.getByLabel('아이템 대응 조건 설정')).toBeVisible();
  await expect(page.getByLabel('상대 아이템 구매 방식')).toHaveValue('none');
  await page.getByLabel('아이템 대응 상대 구매자').selectOption('anyEnemy');
  await expect(page.getByLabel('아이템 대응 조건 설정')).toBeVisible();
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane')).toContainText('표본');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('opponent.owns_item_at');
  await expect(page.locator('.monaco-host')).toContainText('NOT owns_item_at');
  await expect(page.locator('.monaco-host')).toContainText('ANALYZE team');
});

test('creates an editable champion matchup analysis from the card picker', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: '조건 카드 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '무엇을 분석에 추가할까요?' });
  await dialog.getByRole('button', { name: '챔피언', exact: true }).click();
  await dialog.getByLabel('추가할 챔피언 관계').selectOption('opponent_has_champion_in_role');
  await dialog.getByRole('button', { name: '챔피언 분석 만들기' }).click();

  await expect(page.getByLabel('분석 대상 챔피언')).toBeVisible();
  await expect(page.getByLabel('분석 대상 포지션')).toBeVisible();
  await expect(page.getByLabel('상대 챔피언 포지션')).toBeVisible();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('opponent_has_champion_in_role');
  await expect(page.locator('.monaco-host')).toContainText('RETURN win_rate');
});

test('describes player and ally champion conditions without exposing DSL names', async ({
  page,
}) => {
  await openExample(page, '같은 팀 챔피언 조합 승률');

  await expect(page.getByText('분석 대상 선수의 챔피언: Xayah')).toBeVisible();
  await expect(page.getByText('같은 팀에 Rakan 챔피언이 있습니다', { exact: true })).toBeVisible();
  await expect(page.locator('.result-pane')).toContainText('같은 팀에 Rakan 챔피언이 있습니다');
  await expect(page.getByText('ally_has_champion(...)')).toHaveCount(0);
  await expect(page.getByText('player.champion 값은 "Xayah"와 같습니다')).toHaveCount(0);
});

test('changes the analysis unit between matches, teams, and players', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const units = page.getByRole('group', { name: '분석 단위' });

  await units.getByRole('button', { name: '선수', exact: true }).click();
  await expect(page.getByText('분석 대상: 선수')).toBeVisible();
  await expect(page.getByText('선수 한 명의 한 경기를 표본 하나로 사용합니다.')).toBeVisible();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('ANALYZE player');
  await page.getByRole('button', { name: '빌더', exact: true }).click();

  await units.getByRole('button', { name: '경기', exact: true }).click();
  await expect(page.getByText('분석 대상: 경기')).toBeVisible();
  await units.getByRole('button', { name: '팀', exact: true }).click();
  await expect(page.getByRole('group', { name: '분석 팀 범위' })).toBeVisible();
  await expect(page.getByRole('button', { name: '전체 팀', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('edits the AI counter-item query entirely through one visual card', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(`ANALYZE team
WHEN opponent_has_champion("Trundle", "Briar", "Vladimir", "Aatrox", "Volibear")
  AND item_purchase.item IN (3011, 3033, 3075, 3076, 3123, 3165, 3916, 6609)
RETURN win_rate() AS our_win_rate, count() AS sample_size`);
  await page.getByRole('button', { name: '빌더', exact: true }).click();

  await expect(page.getByLabel('상대 챔피언과 대응 아이템 조건 설정')).toBeVisible();
  await expect(page.locator('.analysis-card--advanced')).toHaveCount(0);
  await expect(page.locator('.banner--advanced')).toHaveCount(0);
  await expect(page.getByLabel('상대 챔피언과 대응 아이템 조건 설정')).toContainText(
    '화학공학 부패기',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByLabel('우리 팀 대응 아이템 구매 방식').selectOption('none');
  await expect(page.getByLabel('우리 팀 대응 아이템 구매 방식')).toHaveValue('none');
  await page.getByRole('button', { name: '상대 챔피언 Briar 제거' }).click();
  await expect(page.getByRole('button', { name: '상대 챔피언 Briar 제거' })).toHaveCount(0);

  const title = page.getByLabel('분석 이름');
  await title.fill(
    '상대팀에 트런들 브라이어 블라디미르 아트록스 중 하나라도 있고 우리 팀이 치감 아이템을 구매하지 않은 경기의 승률',
  );
  const titleMetrics = await title.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(titleMetrics.clientHeight).toBeGreaterThan(40);
  expect(titleMetrics.scrollHeight).toBeLessThanOrEqual(titleMetrics.clientHeight + 1);
  expect(titleMetrics.scrollWidth).toBeLessThanOrEqual(titleMetrics.clientWidth + 1);
});

test('keeps an event occurrence and its location in one card', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const dialog = await openCardPicker(page);
  await dialog.getByLabel('추가할 사건', { exact: true }).selectOption('death');
  await dialog.getByLabel('추가할 사건 위치 영역').selectOption('top_lane');
  await dialog.getByRole('button', { name: '사건 조건 추가' }).click();

  await expect(page.getByLabel('사건 위치 영역')).toHaveValue('top_lane');
  await expect(page.locator('.card-kicker').filter({ hasText: '위치 조건' })).toHaveCount(0);
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('death.position IN region');
});

test('keeps builder and DSL controls inside their columns in side-by-side mode', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openExample(page, '블루팀 10분 1500골드 리드');
  await page.getByRole('button', { name: '나란히', exact: true }).click();
  await expect(page.locator('.dsl-pane')).toBeVisible();
  await expect(page.locator('.monaco-host')).toBeVisible();

  const layout = await page.evaluate(() => {
    const builder = document.querySelector('.builder-pane')!.getBoundingClientRect();
    const dsl = document.querySelector('.dsl-pane')!.getBoundingClientRect();
    const title = document.querySelector('.analysis-title')!.getBoundingClientRect();
    const editor = document.querySelector('.monaco-host')!.getBoundingClientRect();
    const range = document.querySelector<HTMLInputElement>('[aria-label="수치 우위 기준"]')!;
    const card = range.closest('.analysis-card')!.getBoundingClientRect();
    return { builder, dsl, title, editor, card, range: range.getBoundingClientRect() };
  });
  expect(layout.builder.right).toBeLessThanOrEqual(layout.dsl.left);
  expect(layout.title.right).toBeLessThanOrEqual(layout.builder.right + 1);
  expect(layout.editor.left).toBeGreaterThanOrEqual(layout.dsl.left - 1);
  expect(layout.editor.right).toBeLessThanOrEqual(layout.dsl.right + 1);
  expect(layout.range.left).toBeGreaterThanOrEqual(layout.card.left);
  expect(layout.range.right).toBeLessThanOrEqual(layout.card.right);
});

test('resizes and persists the left and right application panels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('lod-panel-layout'));
  await page.reload();
  await openExample(page, '블루팀 10분 1500골드 리드');

  const biasCard = page.locator('.bias-audit');
  await expect(biasCard).toBeVisible();
  const biasBox = await biasCard.boundingBox();
  const analysisCard = await page.locator('.analysis-card').first().boundingBox();
  expect(Math.abs((biasBox?.width ?? 0) - (analysisCard?.width ?? 0))).toBeLessThan(1);

  const sidebarHandle = page.getByRole('separator', { name: '왼쪽 탐색 패널 너비 조절' });
  const resultHandle = page.getByRole('separator', { name: '오른쪽 결과 패널 너비 조절' });
  const initialSidebar = await page.locator('.sidebar').boundingBox();
  const initialResult = await page.locator('.result-pane').boundingBox();
  const sidebarBox = await sidebarHandle.boundingBox();
  if (!initialSidebar || !initialResult || !sidebarBox) {
    throw new Error('Resizable panel fixture is not visible');
  }

  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(sidebarBox.x + sidebarBox.width / 2 + 64, sidebarBox.y + 120, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await page.locator('.sidebar').boundingBox())?.width ?? 0)
    .toBeGreaterThan(initialSidebar.width + 50);

  const resultBox = await resultHandle.boundingBox();
  if (!resultBox) throw new Error('Result panel resize handle is not visible');
  await page.mouse.move(resultBox.x + resultBox.width / 2, resultBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(resultBox.x + resultBox.width / 2 - 80, resultBox.y + 120, { steps: 5 });
  await page.mouse.up();

  const resizedSidebar = await page.locator('.sidebar').boundingBox();
  const resizedResult = await page.locator('.result-pane').boundingBox();
  expect(resizedSidebar?.width).toBeGreaterThan(initialSidebar.width + 50);
  expect(resizedResult?.width).toBeGreaterThan(initialResult.width + 65);

  await page.reload();
  await openExample(page, '블루팀 10분 1500골드 리드');
  const persistedSidebar = await page.locator('.sidebar').boundingBox();
  const persistedResult = await page.locator('.result-pane').boundingBox();
  expect(Math.abs((persistedSidebar?.width ?? 0) - (resizedSidebar?.width ?? 0))).toBeLessThan(1);
  expect(Math.abs((persistedResult?.width ?? 0) - (resizedResult?.width ?? 0))).toBeLessThan(1);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(resultHandle).toBeHidden();
  const compactWorkspace = await page.locator('.workspace').boundingBox();
  const compactResult = await page.locator('.result-pane').boundingBox();
  expect(compactResult?.y).toBeGreaterThanOrEqual(
    (compactWorkspace?.y ?? 0) + (compactWorkspace?.height ?? 0) - 1,
  );

  await page.setViewportSize({ width: 700, height: 900 });
  await expect(sidebarHandle).toBeHidden();
});

test('toggles and persists the dark theme across the app', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('lod-color-theme', 'light'));
  await page.reload();

  const darkThemeButton = page.getByRole('button', { name: '다크 테마로 전환' });
  await expect(darkThemeButton).toHaveAttribute('aria-pressed', 'false');
  await darkThemeButton.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '라이트 테마로 전환' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toHaveClass(/vs-dark/);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '라이트 테마로 전환' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('uses consistent Korean UI and monospace editor font stacks', async ({ page }) => {
  const bodyFont = await page
    .locator('body')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(bodyFont).toContain('Pretendard');
  const datasetBadgeFont = await page
    .locator('.sidebar')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(datasetBadgeFont).toContain('Pretendard');
  const brandFont = await page
    .locator('.brand-lockup strong')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(brandFont).toContain('Pretendard');

  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editorFont = await page
    .locator('.monaco-editor .view-lines')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(editorFont).toContain('SFMono-Regular');
});

test('shows the run shortcut on hover and supports editor keyboard commands', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();

  const runButton = page.getByRole('button', { name: '분석 실행' });
  const shortcut = page.getByRole('tooltip');
  await expect(runButton).toHaveAttribute('aria-describedby', 'run-shortcut-hint');
  await expect(shortcut).toHaveCSS('opacity', '0');
  await runButton.hover();
  await expect(shortcut).toHaveCSS('opacity', '1');
  await expect(shortcut).toContainText('⌘ Enter');
  await expect(shortcut).toContainText('Ctrl Enter');

  await page.getByLabel('분석 이름').fill('Keyboard shortcut analysis');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-status')).toHaveText('저장됨');

  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  const glyphMetrics = await page.locator('.monaco-editor .view-lines').evaluate((element) => {
    const style = getComputedStyle(element);
    return { letterSpacing: style.letterSpacing, fontVariantLigatures: style.fontVariantLigatures };
  });
  expect(['normal', '0px']).toContain(glyphMetrics.letterSpacing);
  expect(glyphMetrics.fontVariantLigatures).toBe('none');

  await page.keyboard.press('Control+Enter');
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane h2')).not.toHaveText('—');

  await page.reload();
  await expect(page.getByLabel('분석 이름')).toHaveValue('Keyboard shortcut analysis');
});

test('updates the current analysis in the sidebar without waiting for autosave', async ({
  page,
}) => {
  const saveNow = async () => {
    await page.locator('.save-status').click();
    await expect(page.locator('.save-status')).toHaveText('저장됨');
  };
  const analysisItems = page.locator('.sidebar .doc-row .doc-item');

  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.getByRole('button', { name: '새 분석', exact: true })).toBeVisible();

  await page.getByLabel('분석 이름').fill('First analysis');
  await expect(sidebar.getByRole('button', { name: 'First analysis', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: '새 분석', exact: true })).toHaveCount(0);
  await saveNow();

  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByLabel('분석 이름').fill('Second analysis');
  await saveNow();
  await expect(analysisItems.nth(0)).toHaveText('Second analysis');
  await expect(analysisItems.nth(1)).toHaveText('First analysis');

  await sidebar.getByRole('button', { name: 'First analysis', exact: true }).click();
  await expect(analysisItems.first()).toHaveText('First analysis', { timeout: 500 });
});

test('uses the pinned Summoner Rift image under the interactive coordinate layers', async ({
  page,
}) => {
  await page.getByRole('button', { name: '영역', exact: true }).click();
  const image = page.locator('.minimap-image');
  await expect(image).toHaveAttribute('src', '/assets/summoners-rift-map-16.17.1.png');
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(512);
  await expect(page.locator('.minimap-heatmap')).toHaveCSS('z-index', '1');
  await expect(page.getByLabel('소환사의 협곡 영역 편집 미니맵')).toHaveCSS('z-index', '2');

  const regionSelect = page.getByRole('button', { name: '탑 강가 사용자 영역', exact: true });
  await regionSelect.click();
  const regionItem = regionSelect.locator('..');
  await expect(regionItem).toHaveClass(/region-library__item--selected/);
  await expect(regionSelect).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const regionDelete = page.getByRole('button', { name: '탑 강가 사용자 영역 영역 삭제' });
  const [selectBox, deleteBox] = await Promise.all([
    regionSelect.boundingBox(),
    regionDelete.boundingBox(),
  ]);
  if (!selectBox || !deleteBox) throw new Error('cannot read region action dimensions');
  expect(Math.abs(selectBox.x + selectBox.width - deleteBox.x)).toBeLessThan(1);
});

test('separates analytical emphasis from interactive colors in dark mode', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('lod-color-theme', 'dark'));
  await page.reload();
  await openExample(page, '퍼블을 먹은 팀 승률');

  const resultColor = await page
    .locator('.result-pane h2')
    .evaluate((element) => getComputedStyle(element).color);
  const runButtonColor = await page
    .getByRole('button', { name: '분석 실행' })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(resultColor).toBe('rgb(221, 161, 127)');
  expect(runButtonColor).toBe('rgb(71, 126, 113)');
  expect(resultColor).not.toBe(runButtonColor);
});

test('enables optional AI drafting and grounded result interpretation without storing the key', async ({
  page,
}) => {
  await page.route('**/api/v1/ai/config', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        model: 'openai/gpt-5.6-luna',
        provider: 'OpenRouter',
        persistent: false,
        sessionConfigured: true,
      }),
    });
  });
  await page.route('**/api/v1/ai/dsl', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        dsl: 'ANALYZE team\nWHEN team.first_blood\nRETURN win_rate()',
        titleKo: '퍼스트 블러드 팀 승률',
        explanationKo: '조건을 만족한 팀의 관찰 승률을 계산합니다.',
      }),
    });
  });
  await page.route('**/api/v1/ai/interpret', async (route) => {
    const request = route.request().postDataJSON() as { result: { result: object } };
    expect(request.result.result).not.toHaveProperty('mapPoints');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        summaryKo: '조건을 만족한 팀에서 관찰된 승률입니다.',
        findingsKo: ['엔진이 계산한 표본을 기준으로 합니다.'],
        cautionsKo: ['인과관계로 해석할 수 없습니다.'],
      }),
    });
  });

  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByLabel('OpenRouter API 키').fill('sk-or-v1-browser-session-key');
  await page.getByRole('button', { name: '키 연결' }).click();
  await expect(page.getByText('AI 활성화됨')).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sk-or-v1');

  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'AI로 DSL 만들기' }).click();
  await page
    .getByLabel('AI에게 전달할 분석 질문')
    .fill('퍼스트 블러드를 기록한 팀의 승률을 보여줘');
  await page.getByRole('button', { name: 'DSL과 카드 만들기' }).click();
  await expect(page.getByLabel('분석 이름')).toHaveValue('퍼스트 블러드 팀 승률');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-editor')).toContainText('team.first_blood');

  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.getByRole('button', { name: 'AI로 해석' })).toBeVisible();
  await page.getByRole('button', { name: 'AI로 해석' }).click();
  await expect(page.getByText('조건을 만족한 팀에서 관찰된 승률입니다.')).toBeVisible();
});

test('hides AI drafting when no OpenRouter key is configured', async ({ page }) => {
  await page.route('**/api/v1/ai/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: false,
        model: 'openai/gpt-5.6-luna',
        provider: 'OpenRouter',
        persistent: false,
        sessionConfigured: false,
      }),
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await expect(page.getByRole('button', { name: 'AI로 DSL 만들기' })).toHaveCount(0);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByText('AI 비활성화')).toBeVisible();
});

test('builds each A–F analysis from a new visual analysis without typing DSL', async ({ page }) => {
  const startNew = async () => {
    await page.getByRole('button', { name: '+ 새 분석' }).click();
    await expect(page.getByText('조건 없이 전체 경기를 분석합니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '분석 실행' })).toBeEnabled();
  };
  const expectDsl = async (text: string) => {
    await page.getByRole('button', { name: 'DSL', exact: true }).click();
    await expect(page.locator('.monaco-host')).toContainText(text);
    await page.getByRole('button', { name: '빌더', exact: true }).click();
  };
  const runBuilt = async () => {
    await page.getByRole('button', { name: '분석 실행' }).click();
    await expect(page.locator('.run-phase')).toHaveCount(0);
    await expect(page.locator('.result-pane h2')).not.toHaveText('—');
  };

  await startNew();
  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await expectDsl('WHEN first_blood');
  await runBuilt();

  await startNew();
  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await openCardPicker(page, '위치');
  await page.getByLabel('위치를 확인할 사건').selectOption('first_blood');
  await page.getByRole('button', { name: '위치 조건 추가' }).click();
  await expectDsl('first_blood.position IN region("top_lane")');
  await runBuilt();

  await startNew();
  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await page.getByRole('button', { name: '두 사건 사이의 시간' }).click();
  await expect(page.getByLabel('시간 측정 시작 사건', { exact: true })).toHaveValue('first_blood');
  await expect(page.getByLabel('시간 측정 끝 사건', { exact: true })).toHaveValue('turret_destroy');
  await page.getByRole('button', { name: '시간 측정 적용' }).click();
  await expectDsl('avg(duration(blue.first_blood, blue.first_turret_destroy))');
  await runBuilt();

  await startNew();
  await openCardPicker(page, '수치 차이');
  await page.getByRole('button', { name: '수치 조건 추가' }).click();
  await expectDsl('blue.gold_diff(10:00) >= 1500');
  await runBuilt();

  await startNew();
  await openCardPicker(page, '위치');
  await page.getByLabel('추가할 위치 영역').selectOption('custom_region_1');
  await page.getByRole('button', { name: '위치 조건 추가' }).click();
  await expectDsl('death.position IN region("custom_region_1")');
  await runBuilt();

  await startNew();
  await openCardPicker(page, '이어지는 사건');
  await page.getByRole('button', { name: '연결 조건 추가' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('AFTER kill WITHIN 90s');
  await expect(page.locator('.monaco-host')).toContainText('IF dragon_kill');
  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await runBuilt();
});

test('DoD A–F examples display real engine results', async ({ page }) => {
  const cases = [
    ['퍼블을 먹은 팀 승률', /\d+\.\d%/],
    ['탑 퍼스트 블러드 승률', /\d+\.\d%/],
    ['블루팀 퍼블에서 첫 타워까지', /\d+분 \d+초/],
    ['블루팀 10분 1500골드 리드', /\d+\.\d%/],
    ['특정 영역에서 사망한 팀', /\d+\.\d%/],
    ['블루팀 킬 후 90초 내 드래곤', /\d+\.\d%/],
  ] as const;
  for (const [title, value] of cases) {
    await openExample(page, title);
    await expect(page.locator('.result-pane h2')).toHaveText(value);
    await expect(page.locator('.result-pane')).toContainText('관찰된');
  }
});

test('edits and runs the champion pick-rate template as a visual card', async ({ page }) => {
  await openExample(page, '챔피언 픽·밴·승률 한눈에 보기');

  await expect(page.getByText('분석 대상: 경기')).toBeVisible();
  await expect(page.getByLabel('챔피언 지표 챔피언').first()).toHaveValue('Ahri');
  await expect(page.locator('.analysis-card--advanced')).toHaveCount(0);
  await page.getByLabel('챔피언 지표 챔피언').first().selectOption('Aatrox');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('pick_rate("Aatrox")');
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane')).toContainText('%');
});

test('keeps only the newest result when analyses are opened in rapid succession', async ({
  page,
}) => {
  await page
    .locator('.sidebar .doc-item')
    .filter({ hasText: '퍼블을 먹은 팀 승률' })
    .last()
    .click();
  await page
    .locator('.sidebar .doc-item')
    .filter({ hasText: '블루팀 킬 후 90초 내 드래곤' })
    .last()
    .click();
  await expect(page.getByLabel('분석 이름')).toHaveValue('블루팀 킬 후 90초 내 드래곤');
  await expect(page.locator('.result-pane h2')).toHaveText(/\d+\.\d%/);
});

test('the gold-threshold card patch for D round-trips through the DSL', async ({ page }) => {
  await openExample(page, '블루팀 10분 1500골드 리드');
  await page.getByLabel('수치 우위 기준').fill('2000');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('>= 2000');
});

test('invalidates an old result immediately after a semantic edit and after reload', async ({
  page,
}) => {
  await openExample(page, '블루팀 10분 1500골드 리드');
  await expect(page.locator('.result-pane h2')).toBeVisible();
  await page.getByLabel('수치 우위 기준').fill('2000');
  await expect(page.locator('.result-pane h2')).toHaveCount(0);
  await expect(page.locator('.result-pane')).toContainText('분석을 실행하세요');
  await expect(page.getByRole('button', { name: '포함 경기 보기' })).toHaveCount(0);
  await page.waitForTimeout(1_700);
  await page.reload();
  await expect(page.getByLabel('수치 우위 기준')).toHaveValue('2000');
  await expect(page.locator('.result-pane h2')).toHaveCount(0);
});

test('submits the effective catalog hash returned by the API', async ({ page }) => {
  const effectiveHash = 'sha256:effective-catalog-test';
  let submittedHash: unknown;
  await page.route('**/api/v1/catalog', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, hash: effectiveHash } });
  });
  await page.route('**/api/v1/analyses/run', async (route) => {
    submittedHash = (route.request().postDataJSON() as { catalogHash?: unknown }).catalogHash;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ detail: { code: 'E-SEM-060', messageKo: '테스트 응답' } }),
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect.poll(() => submittedHash).toBe(effectiveHash);
  await expect(page.locator('.result-pane')).toContainText('테스트 응답');
});

test('generic first-blood analysis uses target-relative events across both team sides', async ({
  page,
}) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await expect(page.getByRole('button', { name: '전체 팀' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('ANALYZE team');
  await expect(page.locator('.monaco-host')).toContainText('WHEN first_blood');
  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await page.getByRole('button', { name: '포함 경기 보기' }).click();
  await expect(page.locator('.match-row').filter({ hasText: '팀 100' }).first()).toBeVisible();
  await expect(page.locator('.match-row').filter({ hasText: '팀 200' }).first()).toBeVisible();
});

test('shows coverage, snapshot, and synthetic-source context for duration results', async ({
  page,
}) => {
  await page.route('**/api/v1/catalog', async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...catalog, datasetSource: 'synthetic_e2e' } });
  });
  await page.reload();
  await expect(page.locator('.synthetic-notice')).toContainText('실제 Riot 경기 통계가 아닙니다');
  await openExample(page, '블루팀 퍼블에서 첫 타워까지');
  await expect(page.locator('.coverage-panel')).toContainText(/\d[\d,]*\/\d[\d,]*건/);
  await expect(page.locator('.dataset-provenance')).toContainText('출처 합성 데이터');
  await expect(page.locator('.dataset-provenance')).toContainText('스냅샷');
});

test('the duration editor exposes and updates both event endpoints', async ({ page }) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await page.getByRole('button', { name: '두 사건 사이의 시간' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('시간 측정 시작 사건', { exact: true }).selectOption('dragon_kill');
  await page.getByLabel('시간 측정 끝 사건', { exact: true }).selectOption('baron_kill');
  await expect(page.getByLabel('시간 측정 끝 사건 순서 방식')).toHaveValue('first');
  await expect(
    page.getByLabel('시간 측정 끝 사건 순서 방식').getByRole('option', {
      name: '가장 먼저 발생한 사건',
    }),
  ).toHaveCount(0);
  await page.getByLabel('시간 측정 끝 사건 순서 방식').selectOption('last');
  await page.getByRole('button', { name: '시간 측정 적용' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText(
    'avg(duration(first_dragon_kill, baron_kill[last]))',
  );
});

test('builds elder-dragon win rate and time-to-victory from the visual editor', async ({
  page,
}) => {
  await openExample(page, '장로용 처치 후 승률과 승리 시간');
  await expect(page.getByRole('button', { name: '승률', pressed: true })).toBeVisible();
  await expect(
    page.getByText('결과: 마지막 장로 드래곤 처치 → 승리(게임 종료) 평균 시간'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '조건 카드 추가' })).toHaveCount(1);
  await expect(page.locator('.logic-connector').filter({ hasText: /^결과로$/ })).toHaveCount(1);
  await expect(page.locator('.logic-connector').filter({ hasText: /^함께$/ })).toHaveCount(1);
  await expect(page.getByLabel('시간 측정 끝 사건', { exact: true })).toHaveValue('victory');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('WHEN elder_dragon_kill');
  await expect(page.locator('.monaco-host')).toContainText(
    'avg(duration(elder_dragon_kill[last], victory))',
  );
});

test('the time-window card patch for F round-trips through the DSL', async ({ page }) => {
  await openExample(page, '블루팀 킬 후 90초 내 드래곤');
  await expect(page.getByLabel('이어지는 사건 시작', { exact: true })).toHaveValue('kill');
  await expect(page.getByLabel('이어지는 사건 끝', { exact: true })).toHaveValue('dragon_kill');
  await page.getByLabel('이어지는 사건 시작', { exact: true }).selectOption('first_blood');
  await page.getByLabel('이어지는 사건 끝', { exact: true }).selectOption('baron_kill');
  await page.getByLabel('이어지는 사건 시간 창').fill('120');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('AFTER blue.first_blood');
  await expect(page.locator('.monaco-host')).toContainText('IF blue.baron_kill');
  await expect(page.locator('.monaco-host')).toContainText('WITHIN 120s');
});

test('edits the start and end team of a sequence independently', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const dialog = await openCardPicker(page, '이어지는 사건');
  await dialog.getByLabel('추가할 시작 사건 팀').selectOption('blue');
  await dialog.getByLabel('추가할 끝 사건 팀').selectOption('red');
  await dialog.getByRole('button', { name: '연결 조건 추가' }).click();

  await expect(page.getByLabel('이어지는 사건 시작 팀')).toHaveValue('blue');
  await expect(page.getByLabel('이어지는 사건 끝 팀')).toHaveValue('red');
  await page.getByLabel('이어지는 사건 끝 팀').selectOption('any');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('AFTER blue.kill');
  await expect(page.locator('.monaco-host')).toContainText('IF team.dragon_kill');
});

test('relates a follow-up event to the opposing team of any trigger team', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const dialog = await openCardPicker(page, '이어지는 사건');
  await dialog.getByLabel('추가할 시작 사건 팀').selectOption('any');
  await dialog.getByLabel('추가할 시작 사건', { exact: true }).selectOption('ward_placed');
  await dialog.getByLabel('추가할 끝 사건 팀').selectOption('opponent');
  await dialog.getByLabel('추가할 끝 사건', { exact: true }).selectOption('baron_kill');
  await dialog.getByRole('button', { name: '연결 조건 추가' }).click();

  await expect(page.getByLabel('이어지는 사건 시작 팀')).toHaveValue('any');
  await expect(page.getByLabel('이어지는 사건 끝 팀')).toHaveValue('opponent');
  await expect(page.locator('.banner--advanced')).toHaveCount(0);
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('AFTER team.ward_placed');
  await expect(page.locator('.monaco-host')).toContainText('IF opponent.baron_kill');
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane h2')).not.toHaveText('—');
});

test('keeps an explicit any-team event editable in visual mode', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const dialog = await openCardPicker(page);
  await dialog.getByLabel('추가할 사건 팀').selectOption('any');
  await dialog.getByRole('button', { name: '사건 조건 추가' }).click();
  await expect(page.getByLabel('사건 팀')).toHaveValue('any');
  await expect(page.locator('.banner--advanced')).toHaveCount(0);
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('WHEN team.first_blood');
});

test('adds, changes, and removes grouping criteria from an ordinary analysis', async ({ page }) => {
  await openExample(page, '특정 영역에서 사망한 팀');
  await page.getByRole('button', { name: '분류 기준 추가' }).click();
  const menu = page.getByRole('menu', { name: '추가할 분류 기준' });
  await expect(menu.getByRole('menuitem', { name: /진영/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /진영/ }).click();
  await expect(page.getByRole('button', { name: '진영' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('GROUP BY side');
  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await page.getByRole('button', { name: '분류 기준 카드 삭제' }).click();
  await expect(page.getByText('분류 기준', { exact: true })).toHaveCount(0);
});

test('uses square inner and rounded outer corners for adjacent builder actions', async ({
  page,
}) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  const actions = page.locator(
    '.builder-action-group--joined > button, .builder-action-group--joined > .grouping-control > button',
  );
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toHaveCSS('border-radius', '6px 0px 0px 6px');
  await expect(actions.nth(1)).toHaveCSS('border-radius', '0px 6px 6px 0px');
});

test('turns the advanced DSL workspace on and off explicitly', async ({ page }) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await page.getByRole('button', { name: '고급 DSL 켜기' }).click();
  await expect(page.locator('.monaco-host')).toBeVisible();
  await expect(page.getByRole('button', { name: '고급 DSL 끄기' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '고급 DSL 끄기' }).click();
  await expect(page.locator('.monaco-host')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '고급 DSL 켜기' })).toBeVisible();
});

test('accepts context-aware DSL inline completion with Tab', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('AN');
  await expect(page.locator('.ghost-text-decoration')).toContainText('ALYZE');
  await page.keyboard.press('Tab');
  await expect(page.locator('.monaco-host')).toContainText('ANALYZE');
});

test('removes regular cards and saved analyses from the visual interface', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByLabel('분석 이름').fill('삭제할 분석');
  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await expect(page.getByLabel(/카드 삭제$/)).toBeVisible();
  await page.getByLabel(/카드 삭제$/).click();
  await expect(page.getByText('조건 없이 전체 경기를 분석합니다')).toBeVisible();

  await openCardPicker(page);
  await page.getByRole('button', { name: '사건 조건 추가' }).click();
  await page.waitForTimeout(1_700);
  await expect(page.getByRole('button', { name: '삭제할 분석 분석 삭제' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '삭제할 분석 분석 삭제' }).click();
  await expect(page.getByRole('button', { name: '삭제할 분석 분석 삭제' })).toHaveCount(0);
});

test('edits dragon type and occurrence in event and sequence cards', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const eventDialog = await openCardPicker(page);
  await eventDialog.getByLabel('추가할 사건', { exact: true }).selectOption('dragon_kill');
  await eventDialog.getByLabel('추가할 사건 용 종류').selectOption('CHEMTECH_DRAGON');
  await eventDialog.getByLabel('추가할 사건 용 순서 방식').selectOption('nth');
  await eventDialog.getByLabel('추가할 사건 용 순서', { exact: true }).fill('2');
  await eventDialog.getByRole('button', { name: '사건 조건 추가' }).click();

  await expect(page.getByLabel('사건 조건 용 종류')).toHaveValue('CHEMTECH_DRAGON');
  await expect(page.getByLabel('사건 조건 용 순서', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('chemtech_dragon_kill[2]');

  await page.getByRole('button', { name: '빌더', exact: true }).click();
  const sequenceDialog = await openCardPicker(page, '이어지는 사건');
  await sequenceDialog.getByLabel('추가할 시작 사건', { exact: true }).selectOption('dragon_kill');
  await sequenceDialog.getByLabel('추가할 시작 사건 용 종류').selectOption('ELDER_DRAGON');
  await sequenceDialog.getByLabel('추가할 시작 사건 용 순서 방식').selectOption('nth');
  await sequenceDialog.getByLabel('추가할 시작 사건 용 순서', { exact: true }).fill('1');
  await expect(sequenceDialog.getByLabel('추가할 끝 사건 용 종류')).toBeVisible();
});

test('filters victim positions in event and sequence cards without advanced DSL', async ({
  page,
}) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  const eventDialog = await openCardPicker(page);
  await eventDialog.getByLabel('추가할 사건', { exact: true }).selectOption('death');
  await eventDialog.getByLabel('추가할 사망 포지션 탑').check();
  await eventDialog.getByLabel('추가할 사망 포지션 미드').check();
  await eventDialog.getByLabel('추가할 사망 포지션 선택 방식').selectOption('all');
  await eventDialog.getByRole('button', { name: '사건 조건 추가' }).click();

  await expect(page.getByLabel('사망 조건 포지션 탑')).toBeChecked();
  await expect(page.getByLabel('사망 조건 포지션 미드')).toBeChecked();
  await expect(page.getByText(/고급 DSL 사용 중/)).toHaveCount(0);
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText(
    'all_values(death.role IN ("TOP", "MID"))',
  );

  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await page.getByRole('button', { name: '패배율', exact: true }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('RETURN blue.loss_rate()');

  await page.getByRole('button', { name: '빌더', exact: true }).click();
  const sequenceDialog = await openCardPicker(page, '이어지는 사건');
  await sequenceDialog.getByLabel('추가할 시작 사건', { exact: true }).selectOption('dragon_kill');
  await sequenceDialog.getByLabel('추가할 시작 사건 용 순서 방식').selectOption('nth');
  await sequenceDialog.getByLabel('추가할 시작 사건 용 순서', { exact: true }).fill('4');
  await sequenceDialog.getByLabel('추가할 끝 사건', { exact: true }).selectOption('death');
  await sequenceDialog.getByLabel('추가할 끝 사건 포지션 탑').check();
  await sequenceDialog.getByRole('button', { name: '연결 조건 추가' }).click();

  await expect(page.getByLabel('이어지는 사건 끝 포지션 탑')).toBeChecked();
  await expect(page.getByText(/고급 DSL 사용 중/)).toHaveCount(0);
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('AFTER dragon_kill[4]');
  await expect(page.locator('.monaco-host')).toContainText('IF death.role IN ("TOP")');

  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await page.getByRole('button', { name: '분류 기준 추가', exact: true }).click();
  await page.getByRole('menuitem', { name: /4번째 용 종류/ }).click();
  await expect(page.getByRole('button', { name: '4번째 용 종류', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '패배율', exact: true }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText(
    'GROUP BY dragon_kill[4].monster_subtype',
  );
  await expect(page.locator('.monaco-host')).toContainText('RETURN blue.loss_rate()');
  await expect(page.getByText(/고급 DSL 사용 중/)).toHaveCount(0);
});

test('moves from a deleted active analysis to the next saved analysis or home', async ({
  page,
}) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByLabel('분석 이름').fill('남길 분석');
  await page.waitForTimeout(1_700);
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByLabel('분석 이름').fill('먼저 삭제할 분석');
  await page.waitForTimeout(1_700);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '먼저 삭제할 분석 분석 삭제' }).click();
  await expect(page.getByLabel('분석 이름')).toHaveValue('남길 분석');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '남길 분석 분석 삭제' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole('heading', { name: '질문을 고르면 분석 카드와 결과를 함께 보여드려요' }),
  ).toBeVisible();
});

test('a polygon drawn for E is bound to the location condition automatically', async ({ page }) => {
  await openExample(page, '특정 영역에서 사망한 팀');
  await expect(page.locator('.heatmap-count')).toContainText('위치 표본');
  await page.getByRole('button', { name: '영역 그리기', exact: true }).click();
  const map = page.getByLabel('소환사의 협곡 영역 편집 미니맵');
  for (const [x, y] of [
    [0.15, 0.15],
    [0.4, 0.15],
    [0.4, 0.4],
    [0.15, 0.4],
  ]) {
    const box = await map.boundingBox();
    if (!box) throw new Error('cannot read minimap dimensions');
    await map.click({ position: { x: box.width * x, y: box.height * y } });
  }
  const handles = map.locator('.region-handle');
  await expect(handles).toHaveCount(4);
  const firstHandle = await handles.first().evaluate((element) => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy')),
  }));
  expect(Math.abs(firstHandle.x - 150)).toBeLessThan(2);
  expect(Math.abs(firstHandle.y - 150)).toBeLessThan(2);
  await page.getByRole('button', { name: '도형 완성' }).click();
  await page.getByRole('button', { name: '저장하고 조건에 적용' }).click();
  await expect(
    page.locator('.analysis-card').filter({ hasText: '사망 위치 · 내 영역' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.heatmap-count')).toContainText('위치 표본');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('region("my_region")');
  await page.waitForTimeout(1_700);
  await page.reload();
  await expect(page.getByRole('button', { name: '내 영역', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '내 영역 영역 삭제' }).click();
  await expect(page.getByRole('button', { name: '내 영역', exact: true })).toHaveCount(0);
  await expect(page.getByText('조건 없이 전체 경기를 분석합니다')).toBeVisible();
  await expect(page.locator('.topbar')).toContainText('저장됨');
  await page.reload();
  await expect(page.getByRole('button', { name: '내 영역', exact: true })).toHaveCount(0);
  await expect(page.getByText('조건 없이 전체 경기를 분석합니다')).toBeVisible();
});

test('converts a regular condition to a comparison and executes the same AST', async ({ page }) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await page.getByRole('button', { name: '조건과 반대 비교' }).click();
  await expect(page.locator('.analysis-card').filter({ hasText: '비교 조건' })).toHaveCount(2);
  await expect(page.locator('.banner--advanced')).toHaveCount(0);
  await expect(page.getByLabel('비교 사건', { exact: true })).toHaveCount(2);
  await page.getByLabel('비교 사건', { exact: true }).nth(1).selectOption('turret_destroy');
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.chart-choice')).toContainText('comparison_bar');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('COMPARE WHEN first_blood');
  await expect(page.locator('.monaco-host')).toContainText('VS WHEN NOT turret_destroy');
});

test('keeps an undefined duration-comparison arm visible with its coverage', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea');
  await editor.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(`ANALYZE blue
COMPARE WHEN blue.first_blood
VS WHEN NOT blue.first_blood
RETURN avg(duration(blue.first_blood, blue.first_turret_destroy))`);
  await expect(page.getByRole('button', { name: '분석 실행' })).toBeEnabled();
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane h2')).toHaveText('비교할 값 없음');
  await expect(page.locator('.comparison-summary')).toContainText('측정 가능 0건');
  await expect(page.locator('.result-pane')).not.toContainText('NaN');
});

test('keeps condition teams independent when the analysis target changes', async ({ page }) => {
  await openExample(page, '블루팀 10분 1500골드 리드');
  await page
    .locator('.analysis-card')
    .filter({ hasText: '분석 대상' })
    .getByRole('button', { name: '레드팀' })
    .click();
  await page.getByRole('button', { name: '조건과 반대 비교' }).click();
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('ANALYZE red');
  await expect(page.locator('.monaco-host')).toContainText('blue.gold_diff(10:00) >= 1500');
  await expect(page.locator('.monaco-host')).toContainText('NOT blue.gold_diff(10:00) >= 1500');
  await expect(page.locator('.monaco-host')).toContainText('RETURN red.win_rate');
});

test('combines events from opposite teams in one visual analysis', async ({ page }) => {
  await page.getByRole('button', { name: '+ 새 분석' }).click();

  await openCardPicker(page);
  await page.getByLabel('추가할 사건 팀').selectOption('blue');
  await page.getByLabel('추가할 사건', { exact: true }).selectOption('ward_placed');
  await page.getByRole('button', { name: '사건 조건 추가' }).click();

  await openCardPicker(page);
  await page.getByLabel('추가할 사건 팀').selectOption('red');
  await page.getByLabel('추가할 사건', { exact: true }).selectOption('first_blood');
  await page.getByRole('button', { name: '사건 조건 추가' }).click();

  await expect(page.getByLabel('사건 팀').nth(0)).toHaveValue('blue');
  await expect(page.getByLabel('사건 팀').nth(1)).toHaveValue('red');
  await page.getByRole('button', { name: 'DSL', exact: true }).click();
  await expect(page.locator('.monaco-host')).toContainText('blue.ward_placed');
  await expect(page.locator('.monaco-host')).toContainText('red.first_blood');
  await expect(page.locator('.monaco-host')).toContainText('RETURN blue.win_rate');
  await page.getByRole('button', { name: '빌더', exact: true }).click();
  await page.getByRole('button', { name: '분석 실행' }).click();
  await expect(page.locator('.run-phase')).toHaveCount(0);
  await expect(page.locator('.result-pane h2')).not.toHaveText('—');
});

test('opens the included-match list from a completed analysis', async ({ page }) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await expect(page).toHaveURL(/\/a\/[^/]+$/);
  await page.waitForTimeout(1_600);
  await expect(page.locator('.topbar')).toContainText('저장됨');
  await page.getByRole('button', { name: '포함 경기 보기' }).click();
  await expect(page).toHaveURL(/\/a\/[^/]+\/matches$/);
  await expect(page.getByRole('button', { name: '포함 경기 보기' })).toHaveCount(0);
  await expect(page.getByText('포함 경기 20개 미리보기')).toBeVisible();
  await expect(page.locator('.match-row')).toHaveCount(20);
  await page.route('**/api/v1/matches/*', async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as {
      events?: Array<Record<string, unknown>>;
      matchReason?: { conditions?: Array<Record<string, unknown>> };
    };
    const firstEvent = detail.events?.[0];
    const firstCondition = detail.matchReason?.conditions?.[0];
    if (firstEvent && firstCondition) {
      firstCondition.witnesses = [
        {
          event_id: firstEvent.event_id,
          timestamp_ms: firstEvent.timestamp_ms,
          event_type: firstEvent.event_type,
        },
      ];
    }
    await route.fulfill({ response, json: detail });
  });
  await page.locator('.match-row').first().click();
  await expect(page).toHaveURL(/\/a\/[^/]+\/matches\/[^/]+$/);
  await expect(page.locator('.match-detail')).toContainText('선수 10명');
  await expect(page.locator('.match-detail')).toContainText(
    '이 경기는 표시된 분석 조건을 만족했습니다.',
  );
  await expect(page.getByLabel('경기 사건 타임라인')).toBeVisible();
  await expect(page.locator('.timeline-event--matched')).toHaveCount(1);

  await page.reload();
  await expect(page.getByLabel('분석 이름')).toHaveValue('퍼블을 먹은 팀 승률');
  await expect(page.locator('.match-detail')).toContainText('선수 10명');
  await expect(page.getByLabel('경기 사건 타임라인')).toBeVisible();
});

test('supports stable home, region, and settings routes', async ({ page }) => {
  await page.getByRole('button', { name: '영역', exact: true }).click();
  await expect(page).toHaveURL(/\/regions$/);
  await expect(page.getByLabel('소환사의 협곡 영역 편집 미니맵')).toBeVisible();
  await expect(page.getByRole('button', { name: /저장/ })).toHaveCount(0);
  await expect(page.getByLabel('분석 화면에서 자동 저장됩니다')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '영역', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: '로컬 분석 환경' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '로컬 분석 환경' })).toBeVisible();

  await page.getByRole('button', { name: '홈', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: '홈', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('keeps the current result when the active analysis is clicked again', async ({ page }) => {
  await openExample(page, '퍼블을 먹은 팀 승률');
  await expect(page.locator('.result-pane')).toContainText('표본');
  const resultText = await page.locator('.result-pane > h2').textContent();

  await page.locator('.doc-item--active').click();

  await expect(page.locator('.result-pane > h2')).toHaveText(resultText ?? '');
  await expect(page).toHaveURL(/\/a\/[^/]+$/);
});

test('redirects an unknown saved-analysis route to home', async ({ page }) => {
  await page.goto('/a/does_not_exist');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: '홈', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('keeps analysis navigation and results available on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(page.getByRole('button', { name: '+ 새 분석' })).toBeVisible();
  await openExample(page, '퍼블을 먹은 팀 승률');
  await expect(page.locator('.result-pane')).toBeVisible();
});
