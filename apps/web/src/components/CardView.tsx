import type { BinaryExpr, Expr, GroupKey } from '@lol/ast';
import { listGroupKeys, type EventDef } from '@lol/catalog';
import type { RegionDefinition } from '@lol/data-model';
import {
  applyCardEdit,
  type AstPath,
  type BuilderCard,
  type SyncDocument,
} from '@lol/visual-builder';
import {
  counterItemSelection,
  itemResponseSelection,
  validate,
  type CounterItemSelection,
} from '@lol/validate';
import { RoleMultiSelect, type ItemOption } from './AnalysisInputs.js';
import {
  EventQualifierSlots,
  findNumberedDragonRef,
  isDragonTypeGroup,
  occurrenceNumber,
} from './EventConditionEditors.js';
import {
  chainedEventRef,
  conditionFromDsl,
  counterItemCondition,
  deathRoleDsl,
  deathRoleMode,
  deathRoleValues,
  documentFromDsl,
  eventPredicate,
  eventRefSide,
  eventScopePrefix,
  itemResponseCondition,
  itemResponseDsl,
  teamPrompt,
  type EventScopeChoice,
  type ItemResponseDraft,
} from '../features/analysis-dsl.js';
import { CARD_TYPE_LABELS } from '../features/analysis-options.js';
import {
  changeAnalysisTarget,
  changePlayerSelector,
  type AnalysisTargetChoice,
} from '../features/builder-commands.js';
import {
  AdvancedCardEditor,
  CompareCardEditor,
  NumericConditionEditor,
  PlayerRosterConditionEditor,
  RosterRelationConditionEditor,
  TargetCardEditor,
} from './card-editors/CardLeafEditors.js';
import { EventCardEditor, LocationCardEditor } from './card-editors/EventCardEditors.js';
import { CounterItemCardEditor, ItemResponseCardEditor } from './card-editors/ItemCardEditors.js';
import { SequenceCardEditor } from './card-editors/SequenceCardEditor.js';
import { MeasureCardEditor } from './card-editors/MeasureCardEditor.js';
import {
  playerRosterDsl,
  playerRosterSelection,
  rosterRelationDsl,
  rosterRelationSelection,
} from '../features/roster-analysis.js';
import { getCardDisplayLabel } from './card-display-label.js';

export function CardView({
  card,
  sync,
  onChange,
  regions,
  onOpenDsl,
  coachText,
  events,
  champions,
  items,
  onActivateLocation,
}: {
  card: BuilderCard;
  sync: SyncDocument;
  onChange: (next: SyncDocument) => void;
  regions: readonly RegionDefinition[];
  onOpenDsl: (span?: readonly [number, number]) => void;
  coachText?: string;
  events: readonly EventDef[];
  champions: readonly { readonly id: number; readonly name: string }[];
  items: readonly ItemOption[];
  onActivateLocation?: (path: AstPath) => void;
}) {
  const side = sync.ast.analyze?.side ?? 'blue';
  const compareArm = card.node.kind === 'CompareArm' ? card.node : null;
  const itemResponse =
    card.type === 'itemResponse' ? itemResponseSelection(card.node as Expr) : null;
  const counterItem = card.type === 'counterItem' ? counterItemSelection(card.node as Expr) : null;
  const displayLabel = getCardDisplayLabel({ card, sync, events, regions, items });
  const conditionEventRef = card.type === 'condition' ? chainedEventRef(card.node as Expr) : null;
  const conditionDeathRoles =
    conditionEventRef?.eventType === 'death' ? deathRoleValues(card.node as Expr) : [];
  const playerRoster = card.type === 'condition' ? playerRosterSelection(card.node as Expr) : null;
  const rosterRelation =
    card.type === 'condition' ? rosterRelationSelection(card.node as Expr) : null;
  const lockedToEvent = sync.ast.body.kind === 'SimpleStmt' && Boolean(sync.ast.body.chain);
  const targetChoices: readonly AnalysisTargetChoice[] = ['match', 'player', 'team', 'blue', 'red'];
  const disabledTargetReasons = Object.fromEntries(
    targetChoices.flatMap((choice) => {
      if (lockedToEvent)
        return [[choice, '사건 연결 카드를 삭제한 뒤 분석 단위를 바꿀 수 있습니다.']];
      const currentChoice =
        sync.ast.analyze?.entity === 'team'
          ? (sync.ast.analyze.side ?? 'team')
          : sync.ast.analyze?.entity;
      if (choice === currentChoice) return [];
      const candidate = changeAnalysisTarget(sync, choice);
      const errors = validate(candidate.ast, {
        regionIds: regions.map((region) => region.id),
      }).diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      return errors.length
        ? [[choice, `현재 카드와 함께 사용할 수 없습니다: ${errors[0]!.titleKo}`]]
        : [];
    }),
  ) as Partial<Record<AnalysisTargetChoice, string>>;
  const changeNumericCondition = (
    threshold: number,
    metric = card.node.kind === 'BinaryExpr' && card.node.left.kind === 'MeasureAt'
      ? card.node.left.measure
      : 'gold_diff',
    operator: '>' | '>=' | '<' | '<=' = '>=',
    scope: 'target' | 'blue' | 'red' = 'target',
  ) => {
    if (card.node.kind !== 'BinaryExpr' || card.node.right.kind !== 'NumberLit') return;
    const value: BinaryExpr = {
      ...card.node,
      op: operator,
      left:
        card.node.left.kind === 'MeasureAt'
          ? {
              ...card.node.left,
              measure: metric,
              scope:
                scope === 'target'
                  ? sync.ast.analyze?.entity === 'player'
                    ? { kind: 'ScopeRef', entity: 'player' }
                    : null
                  : { kind: 'ScopeRef', entity: 'team', side: scope },
            }
          : card.node.left,
      right: { ...card.node.right, value: threshold },
    };
    onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
  };
  const changeItemResponse = (selection: ItemResponseDraft) => {
    if (itemResponse && selection.actor !== itemResponse.actor) {
      onChange(documentFromDsl(itemResponseDsl(selection)));
      return;
    }
    onChange(
      applyCardEdit(sync, {
        kind: 'replace',
        path: card.path,
        value: itemResponseCondition(selection),
      }),
    );
  };
  const changeCounterItem = (selection: CounterItemSelection) => {
    onChange(
      applyCardEdit(sync, {
        kind: 'replace',
        path: card.path,
        value: counterItemCondition(selection),
      }),
    );
  };
  return (
    <article
      className={`analysis-card ${card.type === 'advanced' ? 'analysis-card--advanced' : ''}`}
    >
      <div className="card-heading">
        <div className="card-kicker">{CARD_TYPE_LABELS[card.type]}</div>
        {card.removable && card.type !== 'advanced' && (
          <button
            className="card-delete"
            aria-label={`${displayLabel} 카드 삭제`}
            title="카드 삭제"
            onClick={() =>
              onChange(applyCardEdit(sync, { kind: 'removeCondition', path: card.path }))
            }
          >
            삭제
          </button>
        )}
      </div>
      <p>{displayLabel}</p>
      {card.type === 'target' && (
        <TargetCardEditor
          entity={lockedToEvent ? 'event' : sync.ast.analyze?.entity}
          side={sync.ast.analyze?.side}
          selector={sync.ast.analyze?.selector}
          lockedToEvent={lockedToEvent}
          disabledReasons={disabledTargetReasons}
          onSelect={(choice) => onChange(changeAnalysisTarget(sync, choice))}
          onPlayerSelectorChange={(selector) => onChange(changePlayerSelector(sync, selector))}
        />
      )}
      {card.type === 'event' && (
        <EventCardEditor
          card={card}
          sync={sync}
          events={events}
          regions={regions}
          onChange={onChange}
        />
      )}
      {card.type === 'location' && (
        <LocationCardEditor
          card={card}
          sync={sync}
          events={events}
          regions={regions}
          onChange={onChange}
          onActivate={() => onActivateLocation?.(card.path)}
        />
      )}
      {card.type === 'itemResponse' && itemResponse && (
        <ItemResponseCardEditor
          selection={itemResponse}
          champions={champions}
          items={items}
          onChange={changeItemResponse}
        />
      )}
      {card.type === 'counterItem' && counterItem && (
        <CounterItemCardEditor
          selection={counterItem}
          champions={champions}
          items={items}
          onChange={changeCounterItem}
        />
      )}
      {card.type === 'condition' &&
        !itemResponse &&
        card.node.kind === 'BinaryExpr' &&
        card.node.left.kind === 'MeasureAt' &&
        card.node.right.kind === 'NumberLit' && (
          <NumericConditionEditor
            measure={card.node.left.measure}
            threshold={card.node.right.value}
            scope={card.node.left.scope?.side ?? 'target'}
            operator={card.node.op as '>' | '>=' | '<' | '<='}
            targetEntity={sync.ast.analyze?.entity === 'player' ? 'player' : 'team'}
            onChange={(measure, threshold, operator, scope) =>
              changeNumericCondition(threshold, measure, operator, scope)
            }
          />
        )}
      {card.type === 'condition' && playerRoster && (
        <PlayerRosterConditionEditor
          selection={playerRoster}
          champions={champions}
          onChange={(selection) => {
            const value = conditionFromDsl(side, playerRosterDsl(selection));
            onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
          }}
        />
      )}
      {card.type === 'condition' && rosterRelation && (
        <RosterRelationConditionEditor
          selection={rosterRelation}
          champions={champions}
          onChange={(selection) => {
            const value = conditionFromDsl(side, rosterRelationDsl(selection));
            onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
          }}
        />
      )}
      {card.type === 'condition' &&
        conditionEventRef?.eventType === 'death' &&
        conditionDeathRoles.length > 0 && (
          <div className="event-editor">
            <label className="select-slot">
              <span>{teamPrompt('death')}</span>
              <select
                aria-label="사망 조건 팀"
                value={eventRefSide(conditionEventRef)}
                onChange={(event) => {
                  const ref = `${eventScopePrefix(event.target.value as EventScopeChoice)}death`;
                  const value = conditionFromDsl(
                    side,
                    `${ref}.role IN (${conditionDeathRoles.map((role) => `"${role}"`).join(', ')})`,
                  );
                  onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
                }}
              >
                <option value="target">분석 대상 팀</option>
                <option value="blue">블루팀</option>
                <option value="red">레드팀</option>
                <option value="any">어느 팀이든</option>
              </select>
            </label>
            <RoleMultiSelect
              prefix="사망 조건 포지션"
              selected={conditionDeathRoles}
              mode={deathRoleMode(card.node as Expr)}
              onModeChange={(mode) => {
                const scope = eventRefSide(conditionEventRef);
                const value = conditionFromDsl(
                  side,
                  deathRoleDsl(`${eventScopePrefix(scope)}death`, conditionDeathRoles, mode),
                );
                onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
              }}
              onChange={(roles) => {
                const scope = eventRefSide(conditionEventRef);
                const value = roles.length
                  ? conditionFromDsl(
                      side,
                      deathRoleDsl(
                        `${eventScopePrefix(scope)}death`,
                        roles,
                        deathRoleMode(card.node as Expr),
                      ),
                    )
                  : eventPredicate(scope, 'death');
                onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
              }}
            />
          </div>
        )}
      {card.type === 'sequence' && (
        <SequenceCardEditor card={card} sync={sync} events={events} onChange={onChange} />
      )}
      {card.type === 'groupBy' && card.node.kind === 'GroupKey' && (
        <div className="slot-row slot-row--wrap">
          {findNumberedDragonRef({
            chain: sync.ast.body.kind === 'SimpleStmt' ? sync.ast.body.chain : null,
            when: sync.ast.body.kind === 'SimpleStmt' ? sync.ast.body.when : null,
          }) &&
            !sync.ast.body.groupBy.some(
              (group) => group !== card.node && isDragonTypeGroup(group),
            ) && (
              <button
                aria-pressed={
                  card.node.expr.kind === 'FieldAccess' &&
                  card.node.expr.field === 'monster_subtype' &&
                  card.node.expr.object.kind === 'EventRef' &&
                  card.node.expr.object.eventType === 'dragon_kill'
                }
                title="선택한 N번째 용을 화학공학·마법공학·바람·대지·불·바다 용으로 나눕니다."
                onClick={() => {
                  const dragon = findNumberedDragonRef({
                    chain: sync.ast.body.kind === 'SimpleStmt' ? sync.ast.body.chain : null,
                    when: sync.ast.body.kind === 'SimpleStmt' ? sync.ast.body.when : null,
                  });
                  if (!dragon) return;
                  const value: GroupKey = {
                    ...(card.node as GroupKey),
                    expr: { kind: 'FieldAccess', object: { ...dragon }, field: 'monster_subtype' },
                  };
                  onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
                }}
              >
                {`${occurrenceNumber(findNumberedDragonRef(sync.ast)?.ordinal ?? 1)}번째 용 종류`}
              </button>
            )}
          {listGroupKeys(
            sync.ast.body.kind === 'SimpleStmt' && sync.ast.body.chain
              ? 'event'
              : (sync.ast.analyze?.entity ?? 'team'),
          )
            .filter((group) => {
              const current = card.node as GroupKey;
              const currentId = current.expr.kind === 'Identifier' ? current.expr.name : null;
              return (
                group.id === currentId ||
                !sync.ast.body.groupBy.some(
                  (item) =>
                    item !== current &&
                    item.expr.kind === 'Identifier' &&
                    item.expr.name === group.id,
                )
              );
            })
            .map((group) => (
              <button
                key={group.id}
                aria-pressed={
                  (card.node as GroupKey).expr.kind === 'Identifier' &&
                  ((card.node as GroupKey).expr as { readonly name: string }).name === group.id
                }
                title={group.descriptionKo}
                onClick={() => {
                  const value: GroupKey = {
                    ...(card.node as GroupKey),
                    expr: { kind: 'Identifier', name: group.id },
                  };
                  onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }));
                }}
              >
                {group.labelKo}
              </button>
            ))}
        </div>
      )}
      {card.type === 'compare' && compareArm && (
        <CompareCardEditor
          label={card.labelKo}
          arm={compareArm}
          events={events}
          regions={regions}
          onChange={(value) =>
            onChange(applyCardEdit(sync, { kind: 'replace', path: card.path, value }))
          }
        />
      )}
      {card.type === 'measure' && (
        <MeasureCardEditor
          card={card}
          sync={sync}
          events={events}
          champions={champions}
          onChange={onChange}
        />
      )}
      {card.type === 'advanced' && (
        <AdvancedCardEditor
          reason={card.advancedReasonKo}
          span={card.node.span}
          removable={card.removable}
          onOpenDsl={onOpenDsl}
          onRemove={() =>
            onChange(applyCardEdit(sync, { kind: 'removeCondition', path: card.path }))
          }
        />
      )}
      {coachText && <div className="coachmark">↳ {coachText}</div>}
    </article>
  );
}
