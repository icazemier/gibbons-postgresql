import { Buffer } from 'node:buffer';
import type { Pool, PoolClient } from 'pg';
import { Gibbon } from '@icazemier/gibbons';
import { Config } from './interfaces/index.js';
import { quoteIdent } from './sql.js';
import { pickQueryable } from './queryable.js';

const BATCH_SIZE = 1000;

/**
 * Name of the PostgreSQL helper function created by {@link PostgreSqlSeeder.initialize}
 * to evaluate "any bit set in mask" predicates on `BYTEA` columns.
 * Replaces MongoDB's `$bitsAnySet` operator.
 */
export const BYTEA_ANY_BIT_FN = 'gibbons_bytea_any_bit';

/**
 * Prepares a PostgreSQL database with the schema and pre-allocated slot rows
 * required by {@link GibbonsPostgreSql}.
 *
 * @example
 * ```typescript
 * import { Pool } from 'pg';
 * import { PostgreSqlSeeder } from '@icazemier/gibbons-postgresql';
 *
 * const pool = new Pool({ connectionString: 'postgresql://localhost/mydb' });
 * const config = {
 *   dbName: 'mydb',
 *   permissionByteLength: 256,
 *   groupByteLength: 256,
 *   postgresqlMutationConcurrency: 10,
 *   dbStructure: {
 *     user: { tableName: 'users' },
 *     group: { tableName: 'groups' },
 *     permission: { tableName: 'permissions' }
 *   }
 * };
 *
 * const seeder = new PostgreSqlSeeder(pool, config);
 * await seeder.initialize();
 * // Database now has the schema and contains 2048 groups + 2048 permissions
 * // ready for allocation.
 * ```
 */
export class PostgreSqlSeeder {
  public readonly config: Config;
  public readonly pool: Pool;

  constructor(pool: Pool, config: Config) {
    this.pool = pool;
    this.config = config;
  }

  /**
   * Creates tables, the helper SQL function and required extensions.
   *
   * Uses `CREATE TABLE IF NOT EXISTS` so the call is idempotent.
   * @private
   */
  private async ensureSchema(client?: PoolClient): Promise<void> {
    const queryable = pickQueryable(this.pool, client);
    const { user, group, permission } = this.config.dbStructure;

    await queryable.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    await queryable.query(`
      CREATE OR REPLACE FUNCTION ${BYTEA_ANY_BIT_FN}(a BYTEA, b BYTEA)
      RETURNS BOOLEAN AS $$
      DECLARE
        i INT;
        len INT := LEAST(octet_length(a), octet_length(b));
      BEGIN
        IF len = 0 THEN RETURN FALSE; END IF;
        FOR i IN 0..len-1 LOOP
          IF (get_byte(a, i) & get_byte(b, i)) <> 0 THEN
            RETURN TRUE;
          END IF;
        END LOOP;
        RETURN FALSE;
      END;
      $$ LANGUAGE plpgsql IMMUTABLE
    `);

    await queryable.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(user.tableName)} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        groups_gibbon BYTEA NOT NULL,
        permissions_gibbon BYTEA NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await queryable.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(group.tableName)} (
        gibbon_group_position INTEGER PRIMARY KEY,
        gibbon_is_allocated BOOLEAN NOT NULL DEFAULT FALSE,
        permissions_gibbon BYTEA NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    await queryable.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(permission.tableName)} (
        gibbon_permission_position INTEGER PRIMARY KEY,
        gibbon_is_allocated BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  }

  /**
   * Populates the group table with non-allocated group slots.
   * Uses `ON CONFLICT DO NOTHING` so already-seeded positions are silently skipped.
   * @private
   */
  protected async populateGroups(client?: PoolClient): Promise<void> {
    const total = this.config.groupByteLength * 8;
    const emptyPermissions = Gibbon.create(
      this.config.permissionByteLength
    ).toBuffer();
    const table = quoteIdent(this.config.dbStructure.group.tableName);
    const queryable = pickQueryable(this.pool, client);

    for (let start = 1; start <= total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, total);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (let pos = start; pos <= end; pos++) {
        placeholders.push(`($${idx++}, FALSE, $${idx++})`);
        params.push(pos, emptyPermissions);
      }
      await queryable.query(
        `INSERT INTO ${table} (gibbon_group_position, gibbon_is_allocated, permissions_gibbon)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (gibbon_group_position) DO NOTHING`,
        params
      );
    }
  }

  /**
   * Populates the permission table with non-allocated permission slots.
   * Uses `ON CONFLICT DO NOTHING` so already-seeded positions are silently skipped.
   * @private
   */
  private async populatePermissions(client?: PoolClient): Promise<void> {
    const total = this.config.permissionByteLength * 8;
    const table = quoteIdent(this.config.dbStructure.permission.tableName);
    const queryable = pickQueryable(this.pool, client);

    for (let start = 1; start <= total; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, total);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (let pos = start; pos <= end; pos++) {
        placeholders.push(`($${idx++}, FALSE)`);
        params.push(pos);
      }
      await queryable.query(
        `INSERT INTO ${table} (gibbon_permission_position, gibbon_is_allocated)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (gibbon_permission_position) DO NOTHING`,
        params
      );
    }
  }

  /**
   * Initialize: ensure schema/helper function exist and populate groups + permissions.
   * Safe to call multiple times — existing data is never overwritten.
   */
  async initialize(client?: PoolClient): Promise<void> {
    await this.ensureSchema(client);
    await Promise.all([
      this.populateGroups(client),
      this.populatePermissions(client),
    ]);
  }

  /**
   * Seeds a range of new slots into the permission or group table.
   * Uses the same batch insert + `ON CONFLICT DO NOTHING` pattern as {@link initialize}.
   *
   * @param collection - Which table to seed ('group' or 'permission')
   * @param fromPosition - Start position (inclusive)
   * @param toPosition - End position (inclusive)
   */
  async seedRange(
    collection: 'group' | 'permission',
    fromPosition: number,
    toPosition: number,
    client?: PoolClient
  ): Promise<void> {
    if (
      !Number.isInteger(fromPosition) ||
      !Number.isInteger(toPosition) ||
      fromPosition < 1 ||
      toPosition < fromPosition
    ) {
      throw new RangeError(
        `Invalid range: fromPosition (${fromPosition}) and toPosition (${toPosition}) must be positive integers with fromPosition <= toPosition`
      );
    }
    const queryable = pickQueryable(this.pool, client);
    if (collection === 'permission') {
      const table = quoteIdent(this.config.dbStructure.permission.tableName);
      for (let start = fromPosition; start <= toPosition; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, toPosition);
        const placeholders: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        for (let pos = start; pos <= end; pos++) {
          placeholders.push(`($${idx++}, FALSE)`);
          params.push(pos);
        }
        await queryable.query(
          `INSERT INTO ${table} (gibbon_permission_position, gibbon_is_allocated)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (gibbon_permission_position) DO NOTHING`,
          params
        );
      }
      return;
    }

    const table = quoteIdent(this.config.dbStructure.group.tableName);
    const emptyPermissions = Gibbon.create(
      this.config.permissionByteLength
    ).toBuffer();
    for (let start = fromPosition; start <= toPosition; start += BATCH_SIZE) {
      const end = Math.min(start + BATCH_SIZE - 1, toPosition);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      for (let pos = start; pos <= end; pos++) {
        placeholders.push(`($${idx++}, FALSE, $${idx++})`);
        params.push(pos, emptyPermissions);
      }
      await queryable.query(
        `INSERT INTO ${table} (gibbon_group_position, gibbon_is_allocated, permissions_gibbon)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (gibbon_group_position) DO NOTHING`,
        params
      );
    }
  }

  /**
   * @deprecated Use {@link initialize} instead. This method throws when data
   * already exists; `initialize()` is idempotent and safe to call repeatedly.
   */
  async populateGroupsAndPermissions(client?: PoolClient): Promise<void> {
    await this.ensureSchema(client);
    const queryable = pickQueryable(this.pool, client);
    const groupTable = quoteIdent(this.config.dbStructure.group.tableName);
    const permissionTable = quoteIdent(
      this.config.dbStructure.permission.tableName
    );

    const groupCount = await queryable.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable} LIMIT 1`
    );
    const permissionCount = await queryable.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permissionTable} LIMIT 1`
    );

    if (
      Number(groupCount.rows[0].count) > 0 ||
      Number(permissionCount.rows[0].count) > 0
    ) {
      throw new Error(
        `Called populateGroupsAndPermissions, but permissions and groups seem to be populated already`
      );
    }

    await Promise.all([
      this.populateGroups(client),
      this.populatePermissions(client),
    ]);
  }

  /**
   * Returns a `Buffer` of the configured length filled with zero bytes,
   * used as the default value for fresh group/user gibbons.
   *
   * @internal
   */
  public static emptyBuffer(byteLength: number): Buffer {
    return Buffer.alloc(byteLength);
  }
}
