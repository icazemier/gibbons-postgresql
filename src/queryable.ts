import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Anything that exposes a `query()` method compatible with both `pg.Pool` and
 * `pg.PoolClient`. Used so model methods can transparently run on a standalone
 * pool connection or on a transaction-bound client.
 */
export type Queryable = Pool | PoolClient;

/**
 * Compiled SQL `WHERE` fragment plus its parameter array.
 *
 * The `sql` field is everything that would appear *after* a `WHERE` keyword
 * (or after `AND` when concatenated into a larger clause). Placeholders use
 * the `$N` form starting from 1 and the corresponding values live in `params`.
 *
 * Use `combineClauses` to AND-combine two clauses while keeping the placeholder
 * numbering consistent.
 */
export interface WhereClause {
  sql: string;
  params: unknown[];
}

/**
 * AND-combines two prepared {@link WhereClause}s and renumbers the placeholders
 * in `right` so they continue after `left`'s parameters.
 */
export function combineClauses(
  left: WhereClause,
  right: WhereClause
): WhereClause {
  const offset = left.params.length;
  const renumbered = right.sql.replace(/\$(\d+)/g, (_, n) =>
    `$${Number(n) + offset}`
  );
  return {
    sql: `(${left.sql}) AND (${renumbered})`,
    params: [...left.params, ...right.params],
  };
}

/**
 * Returns the supplied client when present, otherwise falls back to the pool.
 * Used inside model methods to thread an optional transactional client.
 */
export function pickQueryable(pool: Pool, client?: PoolClient): Queryable {
  return client ?? pool;
}

/**
 * Convenience wrapper for `queryable.query(sql, params)` that returns the rows
 * already typed.
 */
export async function queryRows<T extends QueryResultRow>(
  queryable: Queryable,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result: QueryResult<T> = await queryable.query<T>(sql, params);
  return result.rows;
}
