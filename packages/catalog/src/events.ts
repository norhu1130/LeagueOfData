/**
 * Event definitions, the DSL's central primitive (§6).
 *
 * At startup, `/health/catalog` checks every `sqlBinding.columns` entry against DuckDB.
 * This exposes data-layer drift before a suggested event fails during execution.
 */
import type { EventDef } from './types.js';

const KILL_CONTEXT = [
  'time',
  'position',
  'team',
  'player',
  'champion',
  'role',
  'killer',
  'victim',
  'assistants',
  'assist_count',
];
const OBJECTIVE_CONTEXT = ['time', 'position', 'team', 'player', 'champion'];
const BUILDING_CONTEXT = ['time', 'position', 'team', 'player', 'lane'];
const SPAWN_CONTEXT = ['time', 'position'];

/** Columns shared by event rows that contain a position. */
const POSITION_COLUMNS = ['x_norm', 'y_norm', 'x_raw', 'y_raw', 'has_position'];
const BASE_COLUMNS = ['match_id', 'event_id', 'timestamp_ms', 'event_type', 'team_id'];
const ACTOR_COLUMNS = ['participant_id', 'champion_id', 'role'];

export const DRAGON_SUBTYPE_OPTIONS = [
  { value: 'FIRE_DRAGON', labelKo: '화염 용', eventId: 'infernal_dragon_kill' },
  { value: 'AIR_DRAGON', labelKo: '바람 용', eventId: 'cloud_dragon_kill' },
  { value: 'EARTH_DRAGON', labelKo: '대지 용', eventId: 'mountain_dragon_kill' },
  { value: 'WATER_DRAGON', labelKo: '바다 용', eventId: 'ocean_dragon_kill' },
  { value: 'HEXTECH_DRAGON', labelKo: '마법공학 용', eventId: 'hextech_dragon_kill' },
  { value: 'CHEMTECH_DRAGON', labelKo: '화학공학 용', eventId: 'chemtech_dragon_kill' },
  { value: 'ELDER_DRAGON', labelKo: '장로 드래곤', eventId: 'elder_dragon_kill' },
  { value: 'OTHER_DRAGON', labelKo: '기타 용', eventId: 'other_dragon_kill' },
] as const;

const DRAGON_VARIANTS = Object.fromEntries(
  DRAGON_SUBTYPE_OPTIONS.map((option, index) => {
    const knownValues = DRAGON_SUBTYPE_OPTIONS.filter((item) => item.value !== 'OTHER_DRAGON')
      .map((item) => `'${item.value}'`)
      .join(', ');
    const subtypeWhere =
      option.value === 'OTHER_DRAGON'
        ? `(event_subtype IS NULL OR event_subtype NOT IN (${knownValues}))`
        : `event_subtype = '${option.value}'`;
    return [
      option.eventId,
      {
        id: option.eventId,
        labelKo: `${option.labelKo} 처치`,
        descriptionKo: `${option.labelKo}을 처치한 사건입니다.`,
        available: true,
        atMostOncePerMatch: false,
        context: [...OBJECTIVE_CONTEXT, 'monster_subtype'],
        sqlBinding: {
          table: 'events',
          where: `event_type = 'dragon_kill' AND ${subtypeWhere}`,
          columns: [
            ...BASE_COLUMNS,
            ...ACTOR_COLUMNS,
            ...POSITION_COLUMNS,
            'event_subtype',
            'monster_type',
            'is_first_of_type',
          ],
        },
        variantOf: 'dragon_kill',
        qualifierValue: option.value,
        rank: 30 + index,
      } satisfies EventDef,
    ];
  }),
);

export const EVENTS: Record<string, EventDef> = {
  victory: {
    id: 'victory',
    labelKo: '승리(게임 종료)',
    descriptionKo: '분석 대상 팀이 승리하며 게임이 종료된 사건입니다.',
    available: true,
    atMostOncePerMatch: true,
    context: ['time', 'team'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'game_end'",
      columns: BASE_COLUMNS,
    },
    rank: 1,
  },

  first_blood: {
    id: 'first_blood',
    labelKo: '퍼스트 블러드',
    descriptionKo: '경기에서 최초로 발생한 챔피언 처치입니다.',
    available: true,
    atMostOncePerMatch: true,
    context: KILL_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'kill' AND is_first_of_type",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'is_first_of_type',
        'victim_id',
        'victim_team_id',
        'assist_ids',
        'assist_count',
      ],
    },
    rank: 2,
  },

  kill: {
    id: 'kill',
    labelKo: '처치',
    descriptionKo: '챔피언을 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: KILL_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'kill'",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'victim_id',
        'victim_team_id',
        'assist_ids',
        'assist_count',
      ],
    },
    rank: 2,
  },

  death: {
    id: 'death',
    labelKo: '사망',
    descriptionKo: '챔피언이 처치당한 사건입니다. 처치와 같은 사건을 피해자 관점에서 본 것입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'position', 'team', 'player', 'champion', 'role', 'killer', 'assist_count'],
    teamPerspective: 'victim',
    sqlBinding: {
      table: 'v_deaths',
      where: 'TRUE',
      columns: [
        'match_id',
        'event_id',
        'timestamp_ms',
        'participant_id',
        'team_id',
        'champion_id',
        'role',
        'killer_id',
        'killer_team_id',
        'assist_count',
        ...POSITION_COLUMNS,
      ],
    },
    rank: 3,
  },

  solo_kill: {
    id: 'solo_kill',
    labelKo: '솔로킬',
    descriptionKo: '어시스트 없이 혼자 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: KILL_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'kill' AND coalesce(assist_count, 0) = 0",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'assist_count',
        'victim_id',
      ],
    },
    rank: 4,
  },

  turret_destroy: {
    id: 'turret_destroy',
    labelKo: '포탑 파괴',
    descriptionKo: '포탑을 파괴한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: [...BUILDING_CONTEXT, 'tower_type'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'turret_destroy'",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'tower_type',
        'lane_type',
        'is_first_of_type',
      ],
    },
    aliases: { first_turret_destroy: { ordinal: 'first' } },
    rank: 5,
  },

  turret_plate_destroy: {
    id: 'turret_plate_destroy',
    labelKo: '포탑 방패 파괴',
    descriptionKo: '14분 전까지 존재하는 포탑 방패를 파괴한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: BUILDING_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'turret_plate_destroy'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, ...POSITION_COLUMNS, 'lane_type'],
    },
    rank: 6,
  },

  inhibitor_destroy: {
    id: 'inhibitor_destroy',
    labelKo: '억제기 파괴',
    descriptionKo: '억제기를 파괴한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: BUILDING_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'inhibitor_destroy'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, ...POSITION_COLUMNS, 'lane_type'],
    },
    rank: 7,
  },

  turret_damage: {
    id: 'turret_damage',
    labelKo: '포탑 피해',
    descriptionKo: '포탑에 피해를 입힌 사건입니다.',
    available: false,
    unavailableReasonKo:
      'Riot 타임라인이 포탑 피해를 개별 사건으로 제공하지 않습니다. 포탑 방패 파괴나 포탑 파괴로 대신할 수 있습니다.',
    atMostOncePerMatch: false,
    context: BUILDING_CONTEXT,
    sqlBinding: { table: 'events', where: 'FALSE', columns: [...BASE_COLUMNS] },
    rank: 90,
  },

  dragon_kill: {
    id: 'dragon_kill',
    labelKo: '드래곤 처치',
    descriptionKo: '드래곤을 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: [...OBJECTIVE_CONTEXT, 'monster_subtype'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'dragon_kill'",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'event_subtype',
        'monster_type',
        'is_first_of_type',
      ],
    },
    qualifiers: [
      {
        field: 'monster_subtype',
        labelKo: '용 종류',
        options: DRAGON_SUBTYPE_OPTIONS,
      },
    ],
    aliases: { first_dragon_kill: { ordinal: 'first' } },
    rank: 8,
  },

  dragon_soul_acquired: {
    id: 'dragon_soul_acquired',
    labelKo: '용 영혼 획득',
    descriptionKo: '한 팀이 네 번째 원소 드래곤을 처치해 용 영혼을 획득한 사건입니다.',
    available: true,
    atMostOncePerMatch: true,
    context: [...OBJECTIVE_CONTEXT, 'monster_subtype'],
    sqlBinding: {
      table: 'v_dragon_soul_acquired',
      where: 'TRUE',
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'event_subtype',
        'monster_type',
        'is_first_of_type',
      ],
    },
    rank: 9,
  },

  team_aced: {
    id: 'team_aced',
    labelKo: '팀 전멸',
    descriptionKo: '팀원 다섯 명이 동시에 사망 상태가 된 사건입니다.',
    available: false,
    unavailableReasonKo:
      '현재 Riot 타임라인 정규화 데이터에는 정확한 부활 상태가 없어 전멸을 신뢰성 있게 판정할 수 없습니다.',
    atMostOncePerMatch: false,
    context: ['time', 'team'],
    teamPerspective: 'victim',
    sqlBinding: { table: 'events', where: 'FALSE', columns: [...BASE_COLUMNS] },
    rank: 91,
  },

  ...DRAGON_VARIANTS,

  dragon_spawn: {
    id: 'dragon_spawn',
    labelKo: '드래곤 생성',
    descriptionKo: '드래곤이 둥지에 나타난 시각입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: SPAWN_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'dragon_spawn'",
      columns: [...BASE_COLUMNS, ...POSITION_COLUMNS, 'monster_type'],
    },
    rank: 20,
  },

  baron_kill: {
    id: 'baron_kill',
    labelKo: '바론 처치',
    descriptionKo: '내셔 남작을 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: OBJECTIVE_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'baron_kill'",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'monster_type',
        'is_first_of_type',
      ],
    },
    rank: 9,
  },

  baron_spawn: {
    id: 'baron_spawn',
    labelKo: '바론 생성',
    descriptionKo: '내셔 남작이 나타난 시각입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: SPAWN_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'baron_spawn'",
      columns: [...BASE_COLUMNS, ...POSITION_COLUMNS, 'monster_type'],
    },
    rank: 21,
  },

  herald_kill: {
    id: 'herald_kill',
    labelKo: '전령 처치',
    descriptionKo: '협곡의 전령을 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: OBJECTIVE_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'herald_kill'",
      columns: [
        ...BASE_COLUMNS,
        ...ACTOR_COLUMNS,
        ...POSITION_COLUMNS,
        'monster_type',
        'is_first_of_type',
      ],
    },
    rank: 10,
  },

  herald_spawn: {
    id: 'herald_spawn',
    labelKo: '전령 생성',
    descriptionKo: '협곡의 전령이 나타난 시각입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: SPAWN_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'herald_spawn'",
      columns: [...BASE_COLUMNS, ...POSITION_COLUMNS, 'monster_type'],
    },
    rank: 22,
  },

  grub_kill: {
    id: 'grub_kill',
    labelKo: '공허충 처치',
    descriptionKo: '공허 유충을 처치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: OBJECTIVE_CONTEXT,
    sqlBinding: {
      table: 'events',
      where: "event_type = 'grub_kill'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, ...POSITION_COLUMNS, 'monster_type'],
    },
    rank: 11,
  },

  ward_placed: {
    id: 'ward_placed',
    labelKo: '와드 설치',
    descriptionKo: '시야 와드를 설치한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'position', 'team', 'player', 'champion', 'ward_type'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'ward_placed'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, ...POSITION_COLUMNS, 'ward_type'],
    },
    rank: 12,
  },

  ward_destroyed: {
    id: 'ward_destroyed',
    labelKo: '와드 제거',
    descriptionKo: '상대 와드를 제거한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'position', 'team', 'player', 'champion', 'ward_type'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'ward_destroyed'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, ...POSITION_COLUMNS, 'ward_type'],
    },
    rank: 13,
  },

  item_purchase: {
    id: 'item_purchase',
    labelKo: '아이템 구매',
    descriptionKo: '아이템을 구매한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'team', 'player', 'champion', 'role', 'item'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'item_purchase'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, 'item_id'],
    },
    rank: 14,
  },

  item_sell: {
    id: 'item_sell',
    labelKo: '아이템 판매',
    descriptionKo: '아이템을 판매한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'team', 'player', 'champion', 'item'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'item_sell'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, 'item_id'],
    },
    rank: 15,
  },

  recall: {
    id: 'recall',
    labelKo: '귀환',
    descriptionKo: '본진으로 귀환한 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'team', 'player', 'champion', 'role'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'recall'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS],
    },
    rank: 16,
  },

  champion_level_up: {
    id: 'champion_level_up',
    labelKo: '레벨업',
    descriptionKo: '챔피언 레벨이 올라간 사건입니다.',
    available: true,
    atMostOncePerMatch: false,
    context: ['time', 'team', 'player', 'champion', 'role', 'level'],
    sqlBinding: {
      table: 'events',
      where: "event_type = 'champion_level_up'",
      columns: [...BASE_COLUMNS, ...ACTOR_COLUMNS, 'level'],
    },
    rank: 17,
  },
};
