import {
  FilterPrimitive,
  IdFilter,
  MetadataComparator,
  UserFilter,
} from './interfaces/user-filter.js';

const SIMPLE_IDENT = /^[A-Za-z0-9_]+$/;

/**
 * Safely quote a PostgreSQL identifier (table, column, schema name).
 *
 * Accepts either a single identifier (`users`) or a schema-qualified pair
 * (`gibbons.users`). For qualified names, each side is quoted independently
 * so the result is `"gibbons"."users"`. Useful for keeping the gibbons
 * tables in a dedicated schema alongside another tool (e.g. Prisma).
 *
 * @throws Error when the identifier contains characters outside
 *   `[A-Za-z0-9_]` or has more than one dot.
 */
export function quoteIdent(identifier: string): string {
  const parts = identifier.split('.');
  if (parts.length > 2 || !parts.every((p) => SIMPLE_IDENT.test(p))) {
    throw new Error(
      `Invalid SQL identifier: "${identifier}". Expected "table" or "schema.table" with only alphanumeric and underscore characters.`
    );
  }
  return parts.map((p) => `"${p}"`).join('.');
}

/**
 * Split a `schema.table` identifier into its parts. Returns the table name
 * with `schema: undefined` when no schema prefix is present.
 *
 * Validates each part the same way as {@link quoteIdent}.
 */
export function splitIdent(identifier: string): {
  schema?: string;
  table: string;
} {
  const parts = identifier.split('.');
  if (parts.length > 2 || !parts.every((p) => SIMPLE_IDENT.test(p))) {
    throw new Error(
      `Invalid SQL identifier: "${identifier}". Expected "table" or "schema.table" with only alphanumeric and underscore characters.`
    );
  }
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { table: parts[0] };
}

/**
 * Result of building a `WHERE` clause: the SQL fragment (with `$N` placeholders)
 * and the corresponding parameter array.
 */
export interface BuiltClause {
  sql: string;
  params: unknown[];
}

/**
 * Compile a {@link UserFilter} into a `WHERE` SQL fragment + parameter array.
 *
 * - `id` is matched against the `id` column.
 * - `metadata` keys are matched against `metadata->>'<key>'` (text comparison)
 *   except for `in`/`nin` which use ANY/ALL of an array.
 *
 * The resulting `sql` does **not** include the `WHERE` keyword and is safe to
 * concatenate after `WHERE`, `AND` or to use as `(...)` inside a larger clause.
 * If the filter is empty (`{}`), the returned `sql` is `TRUE`.
 *
 * @param filter - User filter to compile
 * @param paramOffset - Zero-based offset added to placeholder numbers (use when
 *                     combining with another already-parameterised clause)
 */
export function buildUserWhere(
  filter: UserFilter,
  paramOffset = 0
): BuiltClause {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const nextPlaceholder = (): string => `$${paramOffset + params.length + 1}`;

  if (filter.id !== undefined) {
    conditions.push(...buildIdConditions(filter.id, params, nextPlaceholder));
  }

  if (filter.metadata !== undefined) {
    for (const key of Object.keys(filter.metadata)) {
      conditions.push(
        ...buildMetadataConditions(
          key,
          filter.metadata[key],
          params,
          nextPlaceholder
        )
      );
    }
  }

  return {
    sql: conditions.length === 0 ? 'TRUE' : conditions.join(' AND '),
    params,
  };
}

function buildIdConditions(
  idFilter: IdFilter,
  params: unknown[],
  nextPlaceholder: () => string
): string[] {
  if (Array.isArray(idFilter)) {
    const placeholder = nextPlaceholder();
    params.push(idFilter);
    return [`id = ANY(${placeholder}::uuid[])`];
  }
  if (typeof idFilter === 'string') {
    const placeholder = nextPlaceholder();
    params.push(idFilter);
    return [`id = ${placeholder}::uuid`];
  }
  if ('in' in idFilter) {
    const placeholder = nextPlaceholder();
    params.push(idFilter.in);
    return [`id = ANY(${placeholder}::uuid[])`];
  }
  throw new Error('Invalid id filter');
}

function buildMetadataConditions(
  key: string,
  comparator: MetadataComparator,
  params: unknown[],
  nextPlaceholder: () => string
): string[] {
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(
      `Invalid metadata key: "${key}". Only alphanumeric and underscore characters are allowed.`
    );
  }
  const col = `metadata->>'${key}'`;

  if (
    comparator === null ||
    typeof comparator === 'string' ||
    typeof comparator === 'number' ||
    typeof comparator === 'boolean'
  ) {
    return [equalityCondition(col, comparator, params, nextPlaceholder)];
  }
  if (Array.isArray(comparator)) {
    return [inCondition(col, comparator, params, nextPlaceholder)];
  }

  const conditions: string[] = [];
  if (comparator.eq !== undefined) {
    conditions.push(
      equalityCondition(col, comparator.eq, params, nextPlaceholder)
    );
  }
  if (comparator.ne !== undefined) {
    conditions.push(
      inequalityCondition(col, comparator.ne, params, nextPlaceholder)
    );
  }
  if (comparator.in !== undefined) {
    conditions.push(inCondition(col, comparator.in, params, nextPlaceholder));
  }
  if (comparator.nin !== undefined) {
    conditions.push(
      notInCondition(col, comparator.nin, params, nextPlaceholder)
    );
  }
  if (comparator.like !== undefined) {
    const placeholder = nextPlaceholder();
    params.push(comparator.like);
    conditions.push(`${col} LIKE ${placeholder}`);
  }
  if (comparator.ilike !== undefined) {
    const placeholder = nextPlaceholder();
    params.push(comparator.ilike);
    conditions.push(`${col} ILIKE ${placeholder}`);
  }
  if (comparator.gt !== undefined) {
    conditions.push(
      scalarCondition(col, '>', comparator.gt, params, nextPlaceholder)
    );
  }
  if (comparator.gte !== undefined) {
    conditions.push(
      scalarCondition(col, '>=', comparator.gte, params, nextPlaceholder)
    );
  }
  if (comparator.lt !== undefined) {
    conditions.push(
      scalarCondition(col, '<', comparator.lt, params, nextPlaceholder)
    );
  }
  if (comparator.lte !== undefined) {
    conditions.push(
      scalarCondition(col, '<=', comparator.lte, params, nextPlaceholder)
    );
  }
  if (comparator.isNull !== undefined) {
    conditions.push(
      comparator.isNull ? `${col} IS NULL` : `${col} IS NOT NULL`
    );
  }
  if (conditions.length === 0) {
    throw new Error(`Empty comparator object for metadata key "${key}"`);
  }
  return conditions;
}

function equalityCondition(
  col: string,
  value: FilterPrimitive,
  params: unknown[],
  nextPlaceholder: () => string
): string {
  if (value === null) {
    return `${col} IS NULL`;
  }
  const placeholder = nextPlaceholder();
  params.push(String(value));
  return `${col} = ${placeholder}`;
}

function inequalityCondition(
  col: string,
  value: FilterPrimitive,
  params: unknown[],
  nextPlaceholder: () => string
): string {
  if (value === null) {
    return `${col} IS NOT NULL`;
  }
  const placeholder = nextPlaceholder();
  params.push(String(value));
  return `(${col} IS DISTINCT FROM ${placeholder})`;
}

function inCondition(
  col: string,
  values: FilterPrimitive[],
  params: unknown[],
  nextPlaceholder: () => string
): string {
  if (values.length === 0) {
    return 'FALSE';
  }
  const placeholder = nextPlaceholder();
  params.push(values.map((v) => (v === null ? null : String(v))));
  return `${col} = ANY(${placeholder}::text[])`;
}

function notInCondition(
  col: string,
  values: FilterPrimitive[],
  params: unknown[],
  nextPlaceholder: () => string
): string {
  if (values.length === 0) {
    return 'TRUE';
  }
  const placeholder = nextPlaceholder();
  params.push(values.map((v) => (v === null ? null : String(v))));
  return `(${col} IS NULL OR ${col} <> ALL(${placeholder}::text[]))`;
}

function scalarCondition(
  col: string,
  operator: '>' | '>=' | '<' | '<=',
  value: FilterPrimitive,
  params: unknown[],
  nextPlaceholder: () => string
): string {
  if (value === null) {
    throw new Error(`Cannot use operator "${operator}" with null`);
  }
  const placeholder = nextPlaceholder();
  if (typeof value === 'number') {
    params.push(value);
    return `(${col})::numeric ${operator} ${placeholder}::numeric`;
  }
  params.push(String(value));
  return `${col} ${operator} ${placeholder}`;
}
