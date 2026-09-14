/**
 * Type definitions for the semantic catalog.
 *
 * The catalog is the single source of truth for what the DSL can express. It has three consumers:
 *
 *   1. TypeScript validation and completion read labels, types, and localized descriptions.
 *   2. The Python compiler reads sqlBinding entries to produce SQL.
 *   3. The visual builder uses it to populate card slots.
 *
 * Separate event lists inevitably drift and produce suggestions that return empty results.
 * Therefore the compiler must contain zero hard-coded event names, and CI enforces that invariant.
 */

/** Analysis grain. This determines the denominator of `win_rate()` and is semantically critical. */
export type GrainId = 'match' | 'team' | 'player' | 'event';

/** DSL value type used to detect errors such as comparing a position with time. */
export type ValueType =
  | 'bool'
  | 'int'
  | 'float'
  | 'rate'
  | 'duration'
  | 'time'
  | 'category'
  | 'champion'
  | 'role'
  | 'team'
  | 'player'
  | 'player[]'
  | 'position'
  | 'region'
  | 'event'
  | 'string'
  | 'any';

/**
 * Whether a value is known at a point in the game or only after the game ends.
 * Using an `end_of_game` value as a condition leaks the outcome into the condition
 * (reverse causality in §23), so validation emits a warning.
 */
export type Temporality = 'in_game_at_t' | 'end_of_game' | 'static';

export interface TableContract {
  /** Name of this logical table in DuckDB. */
  readonly name: string;
  /** Whether this is a view rather than a physical Parquet directory. */
  readonly isView: boolean;
  readonly grain: GrainId;
  readonly keyColumns: readonly string[];
  readonly descriptionKo: string;
}

export interface GrainDef {
  readonly id: GrainId;
  readonly labelKo: string;
  /** Meaning of one row at this grain, used directly in denominator descriptions. */
  readonly unitKo: string;
  readonly keyColumns: readonly string[];
  readonly baseTable: string;
}

export interface EntityDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  /** Surface names that reference this entity in the DSL (`blue`, `red`, `team.blue`, and so on). */
  readonly surfaces: readonly string[];
}

/** Fixed map landmark used as a distance reference, such as `blue.top_outer_turret`. */
export interface LandmarkDef {
  readonly id: string;
  readonly labelKo: string;
  readonly xRaw: number;
  readonly yRaw: number;
}

/** SQL lowering information for an event. This is the only event definition read by the compiler. */
export interface EventSqlBinding {
  /** Table or view to read. */
  readonly table: string;
  /** Additional WHERE predicate. Every referenced column must exist in the physical schema. */
  readonly where: string;
  /** Every column referenced by this event; schema-drift checks validate this list. */
  readonly columns: readonly string[];
}

export interface EventQualifierOption {
  readonly value: string;
  readonly labelKo: string;
  readonly eventId: string;
}

export interface EventQualifierDef {
  readonly field: string;
  readonly labelKo: string;
  readonly options: readonly EventQualifierOption[];
}

export interface EventDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  /**
   * Whether the event exists in the data source. Events missing from Riot timelines,
   * such as `turret_damage`, remain unavailable and are excluded from completion.
   */
  readonly available: boolean;
  readonly unavailableReasonKo?: string;
  /** Whether at most one event can occur per match, used to validate events such as `first_blood`. */
  readonly atMostOncePerMatch: boolean;
  /** Context-field IDs available on this event. */
  readonly context: readonly string[];
  /** How `event.team` should be described in the visual builder. Defaults to the actor. */
  readonly teamPerspective?: 'actor' | 'victim' | 'owner' | 'affected';
  readonly sqlBinding: EventSqlBinding;
  /** Catalog-owned filters rendered as secondary slots on event cards. */
  readonly qualifiers?: readonly EventQualifierDef[];
  /** Variant events share one visual event family while retaining executable DSL names. */
  readonly variantOf?: string;
  readonly qualifierValue?: string;
  /** Surface names with ordinal qualifiers, such as `first_turret_destroy`. */
  readonly aliases?: Readonly<Record<string, { readonly ordinal: 'first' | 'last' }>>;
  /** Completion rank; lower values appear first. */
  readonly rank: number;
}

/** Event attribute, such as `position` in `first_blood.position`. */
export interface ContextFieldDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly type: ValueType;
  readonly temporality: Temporality;
  /** Closed set accepted by categorical fields. Omitted for open or numeric values. */
  readonly allowedValues?: readonly string[];
  /**
   * SQL representation. Positions use an object because they span multiple columns.
   * Both normalized and raw coordinates are exposed: regions use normalized coordinates,
   * while distances use raw game units.
   */
  readonly sql:
    | string
    | {
        readonly xNorm: string;
        readonly yNorm: string;
        readonly xRaw: string;
        readonly yRaw: string;
      };
  readonly rank: number;
}

export interface FunctionParam {
  readonly name: string;
  readonly labelKo: string;
  readonly type: ValueType;
  readonly optional?: boolean;
}

export type FunctionKind = 'aggregate' | 'scalar' | 'frame-measure';

export interface FunctionDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly kind: FunctionKind;
  readonly params: readonly FunctionParam[];
  readonly returns: ValueType | 'same-as-arg';
  /** Analysis grains where this function is meaningful. */
  readonly validGrains: readonly GrainId[];
  /** Clause required by this function. */
  readonly requiresClause?: 'chain';
  /** Aggregate SQL template; `{0}` and `{1}` are argument slots. */
  readonly sqlTemplate?: string;
  /** Result display format. */
  readonly resultFormat?: {
    readonly unit?: 'percent' | 'seconds' | 'gold' | 'count';
    readonly decimals?: number;
  };
  /** Column read by a frame-based measure. */
  readonly frameColumn?: string;
  readonly rank: number;
}

export interface SubjectFieldDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly type: ValueType;
  readonly validGrains: readonly GrainId[];
  readonly table: string;
  readonly columns: readonly string[];
  readonly sql: string;
  readonly resultFormat: {
    readonly unit: 'percent' | 'seconds' | 'gold' | 'count';
    readonly decimals: number;
  };
  readonly rank: number;
}

/** Key available to `GROUP BY`. */
export interface GroupKeyDef {
  readonly id: string;
  readonly labelKo: string;
  readonly descriptionKo: string;
  readonly type: ValueType;
  /** Grains at which this key may be used. */
  readonly validGrains: readonly GrainId[];
  readonly sql: string;
  /** Minimum sample count per group; smaller groups are collected into a separate bucket. */
  readonly minSample?: number;
  readonly rank: number;
}

export type VisualBuilderSupport = 'full' | 'partial' | 'none';

export interface DslConstructCapability {
  readonly id: string;
  readonly syntax: readonly string[];
  readonly parser: boolean;
  readonly engine: boolean;
  readonly visualBuilder: VisualBuilderSupport;
  /** Whether the AI author may emit this construct for an executable analysis. */
  readonly aiGenerate: boolean;
  readonly constraints: readonly string[];
}

export interface DslLanguageSpec {
  readonly version: string;
  readonly ebnf: readonly string[];
  readonly precedence: readonly {
    readonly level: number;
    readonly associativity: 'left' | 'right' | 'none';
    readonly operators: readonly string[];
  }[];
  readonly constructs: readonly DslConstructCapability[];
  readonly generationRules: readonly string[];
}

/** Localized diagnostic message, defined in exactly one place per code. */
export interface DiagnosticDef {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'hint';
  readonly titleKo: string;
  readonly bodyKo: string;
}

export interface AiRecipeDef {
  readonly id: string;
  readonly intentKo: string;
  readonly dsl: string;
}

export interface Catalog {
  readonly catalogVersion: string;
  /** Content hash. Requests are rejected when frontend and backend catalog hashes differ. */
  readonly hash: string;
  readonly map: { readonly min: number; readonly span: number };
  readonly tables: Readonly<Record<string, TableContract>>;
  readonly grains: Readonly<Record<GrainId, GrainDef>>;
  readonly entities: Readonly<Record<string, EntityDef>>;
  readonly landmarks: Readonly<Record<string, LandmarkDef>>;
  readonly events: Readonly<Record<string, EventDef>>;
  readonly contextFields: Readonly<Record<string, ContextFieldDef>>;
  readonly subjectFields: Readonly<Record<string, SubjectFieldDef>>;
  readonly functions: Readonly<Record<string, FunctionDef>>;
  readonly groupKeys: Readonly<Record<string, GroupKeyDef>>;
  readonly dslLanguage: DslLanguageSpec;
  readonly aiRecipes: readonly AiRecipeDef[];
  readonly diagnostics: Readonly<Record<string, DiagnosticDef>>;
  /** Causal phrases that must never appear in result copy (§23). */
  readonly forbiddenPhrases: readonly string[];
}
