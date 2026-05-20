import type { Pool, PoolClient } from 'pg';
import { Config, IGibbonPermission, GibbonLike } from '../interfaces/index.js';
import { GibbonModel } from './gibbon-model.js';
import { PgCursor } from '../cursor.js';
import { quoteIdent } from '../sql.js';
import { queryRows } from '../queryable.js';

interface PermissionRow {
  gibbon_permission_position: number;
  gibbon_is_allocated: boolean;
  metadata: Record<string, unknown>;
}

function rowToPermission(row: PermissionRow): IGibbonPermission {
  return {
    gibbonPermissionPosition: row.gibbon_permission_position,
    gibbonIsAllocated: row.gibbon_is_allocated,
    ...row.metadata,
  };
}

/**
 * Model for managing permission rows in PostgreSQL.
 * Permissions are pre-populated slots that can be allocated and assigned to groups.
 */
export class GibbonPermission extends GibbonModel {
  constructor(pool: Pool, config: Config) {
    super(pool, config.permissionByteLength);
  }

  async initialize(_dbName: string, tableName: string): Promise<void> {
    this.tableName = quoteIdent(tableName);
  }

  /**
   * Allocates a new permission with any desirable row metadata.
   * Atomically claims the lowest-numbered non-allocated slot using
   * `SELECT ... FOR UPDATE SKIP LOCKED` so concurrent allocations don't collide.
   *
   * @param data - Additional metadata to store on the permission (e.g. name, description)
   * @param client - Optional transactional client
   * @returns The newly allocated permission row
   * @throws Error when all permission slots are already allocated
   */
  async allocate<T extends Record<string, unknown>>(
    data: T,
    client?: PoolClient
  ): Promise<IGibbonPermission> {
    const sanitized = GibbonPermission.sanitizeData(data);
    const result = await this.runner(client).query<PermissionRow>(
      `UPDATE ${this.tableName}
       SET gibbon_is_allocated = TRUE,
           metadata = $1::jsonb
       WHERE gibbon_permission_position = (
         SELECT gibbon_permission_position FROM ${this.tableName}
         WHERE gibbon_is_allocated = FALSE
         ORDER BY gibbon_permission_position ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING gibbon_permission_position, gibbon_is_allocated, metadata`,
      [JSON.stringify(sanitized)]
    );
    if (result.rows.length === 0) {
      throw new Error(
        'Not able to allocate permission, seems all permissions are allocated'
      );
    }
    return rowToPermission(result.rows[0]);
  }

  /**
   * Deallocates permission(s) by resetting them to their default (non-allocated)
   * state. Clears metadata and marks slots as available for re-allocation.
   *
   * Note: removing permissions from groups and users is handled by the facade.
   *
   * @param permissions - Permission positions to deallocate
   * @param client - Optional transactional client
   */
  async deallocate(
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    const positions = this.ensureGibbon(permissions).getPositionsArray();
    if (positions.length === 0) {
      return;
    }
    await this.runner(client).query(
      `UPDATE ${this.tableName}
       SET gibbon_is_allocated = FALSE,
           metadata = '{}'::jsonb
       WHERE gibbon_permission_position = ANY($1::int[])`,
      [positions]
    );
  }

  /**
   * Validates whether the given permissions are allocated (or non-allocated) in the database.
   *
   * @param permissions - Permission positions to validate
   * @param allocated - When `true` (default), checks that permissions are allocated; when `false`, checks they are not
   * @param client - Optional transactional client
   * @returns `true` if all given permission positions match the expected allocation state
   */
  public async validate(
    permissions: GibbonLike,
    allocated = true,
    client?: PoolClient
  ): Promise<boolean> {
    const positions = this.ensureGibbon(permissions).getPositionsArray();
    if (positions.length === 0) {
      return false;
    }
    const rows = await queryRows<{ count: string }>(
      this.runner(client),
      `SELECT COUNT(*)::text AS count FROM ${this.tableName}
       WHERE gibbon_permission_position = ANY($1::int[])
         AND gibbon_is_allocated = $2`,
      [positions, allocated]
    );
    return Number(rows[0].count) === positions.length;
  }

  /**
   * Finds permission rows matching the given positions.
   *
   * @param permissions - Permission positions to retrieve
   * @returns A streaming cursor of matching permission rows
   */
  public find(permissions: GibbonLike): PgCursor<IGibbonPermission> {
    const positions = this.ensureGibbon(permissions).getPositionsArray();
    return new PgCursor<IGibbonPermission>(
      { pool: this.pool },
      {
        sql: `SELECT gibbon_permission_position, gibbon_is_allocated, metadata
              FROM ${this.tableName}
              WHERE gibbon_permission_position = ANY($1::int[])`,
        params: [positions],
      },
      (row) => rowToPermission(row as PermissionRow)
    );
  }

  /**
   * Returns a cursor over all allocated permission rows.
   *
   * @returns A streaming cursor of all allocated permission rows
   */
  public findAllocated(): PgCursor<IGibbonPermission> {
    return new PgCursor<IGibbonPermission>(
      { pool: this.pool },
      {
        sql: `SELECT gibbon_permission_position, gibbon_is_allocated, metadata
              FROM ${this.tableName}
              WHERE gibbon_is_allocated = TRUE`,
      },
      (row) => rowToPermission(row as PermissionRow)
    );
  }

  /**
   * Updates custom metadata on an allocated permission (e.g. name, description).
   * Merges the supplied fields into the existing `metadata` JSONB column —
   * existing fields not in `data` are preserved.
   *
   * @param permissionPosition - The position of the permission to update
   * @param data - Key-value pairs to merge into the metadata column
   * @param client - Optional transactional client
   * @returns The updated permission row, or `null` if no allocated permission was found at that position
   */
  public async updateMetadata<T extends Record<string, unknown>>(
    permissionPosition: number,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonPermission | null> {
    const sanitized = GibbonPermission.sanitizeData(data);
    const result = await this.runner(client).query<PermissionRow>(
      `UPDATE ${this.tableName}
       SET metadata = metadata || $1::jsonb
       WHERE gibbon_permission_position = $2
         AND gibbon_is_allocated = TRUE
       RETURNING gibbon_permission_position, gibbon_is_allocated, metadata`,
      [JSON.stringify(sanitized), permissionPosition]
    );
    return result.rows.length === 0
      ? null
      : rowToPermission(result.rows[0]);
  }
}
