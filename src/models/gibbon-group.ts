import { Buffer } from 'node:buffer';
import { Gibbon } from '@icazemier/gibbons';
import type { Pool, PoolClient } from 'pg';
import { Config, IGibbonGroup, GibbonLike } from '../interfaces/index.js';
import { GibbonModel } from './gibbon-model.js';
import { PgCursor } from '../cursor.js';
import { quoteIdent } from '../sql.js';
import { queryRows } from '../queryable.js';
import { BYTEA_ANY_BIT_FN } from '../seeder.js';

interface GroupRow {
  gibbon_group_position: number;
  gibbon_is_allocated: boolean;
  permissions_gibbon: Buffer;
  metadata: Record<string, unknown>;
}

function rowToGroup(row: GroupRow): IGibbonGroup {
  return {
    gibbonGroupPosition: row.gibbon_group_position,
    gibbonIsAllocated: row.gibbon_is_allocated,
    permissionsGibbon: Gibbon.decode(row.permissions_gibbon),
    ...row.metadata,
  };
}

/**
 * Model for managing group rows in PostgreSQL.
 * Groups are pre-populated slots that can be allocated and assigned permissions.
 */
export class GibbonGroup extends GibbonModel {
  constructor(pool: Pool, config: Config) {
    super(pool, config.groupByteLength);
  }

  async initialize(_dbName: string, tableName: string): Promise<void> {
    this.tableName = quoteIdent(tableName);
  }

  /**
   * Validates whether the given groups are allocated (or non-allocated) in the database.
   *
   * @param groups - Group positions to validate
   * @param allocated - When `true` (default), checks that groups are allocated; when `false`, checks they are not
   * @param client - Optional transactional client
   * @returns `true` if all given group positions match the expected allocation state
   */
  public async validate(
    groups: GibbonLike,
    allocated = true,
    client?: PoolClient
  ): Promise<boolean> {
    const positions = this.ensureGibbon(groups).getPositionsArray();
    if (positions.length === 0) {
      return false;
    }
    const rows = await queryRows<{ count: string }>(
      this.runner(client),
      `SELECT COUNT(*)::text AS count FROM ${this.tableName}
       WHERE gibbon_group_position = ANY($1::int[])
         AND gibbon_is_allocated = $2`,
      [positions, allocated]
    );
    return Number(rows[0].count) === positions.length;
  }

  /**
   * Fetches all given groups and merges their subscribed permissions into a
   * single Gibbon. Useful for computing a user's aggregated permissions from
   * their group memberships.
   *
   * @param groups - Group positions to collect permissions from
   * @param client - Optional transactional client
   * @returns A Gibbon with all permissions from the given groups merged together
   */
  async getPermissionsGibbonForGroups(
    groups: GibbonLike,
    client?: PoolClient
  ): Promise<Gibbon> {
    const positions = this.ensureGibbon(groups).getPositionsArray();
    const aggregate = Gibbon.create(this.byteLength);
    if (positions.length === 0) {
      return aggregate;
    }
    const rows = await queryRows<{ permissions_gibbon: Buffer }>(
      this.runner(client),
      `SELECT permissions_gibbon FROM ${this.tableName}
       WHERE gibbon_group_position = ANY($1::int[])`,
      [positions]
    );
    for (const row of rows) {
      aggregate.mergeWithGibbon(Gibbon.decode(row.permissions_gibbon));
    }
    return aggregate;
  }

  /**
   * Finds group rows matching the given positions.
   *
   * @param groups - Group positions to query for
   * @returns A streaming cursor of matching group rows
   */
  public find(groups: GibbonLike): PgCursor<IGibbonGroup> {
    const positions = this.ensureGibbon(groups).getPositionsArray();
    return new PgCursor<IGibbonGroup>(
      { pool: this.pool },
      {
        sql: `SELECT gibbon_group_position, gibbon_is_allocated, permissions_gibbon, metadata
              FROM ${this.tableName}
              WHERE gibbon_group_position = ANY($1::int[])`,
        params: [positions],
      },
      (row) => rowToGroup(row as GroupRow)
    );
  }

  /**
   * Finds groups where the given permissions are subscribed (any bit set).
   *
   * @param permissions - Permission positions to search for
   * @param allocated - When `true` (default), only returns allocated groups
   * @returns A streaming cursor of matching group rows
   */
  findByPermissions(
    permissions: GibbonLike,
    allocated = true
  ): PgCursor<IGibbonGroup> {
    const mask = this.ensureGibbon(permissions).toBuffer();
    const allocatedClause = allocated
      ? 'gibbon_is_allocated = TRUE'
      : 'gibbon_is_allocated <> TRUE';
    return new PgCursor<IGibbonGroup>(
      { pool: this.pool },
      {
        sql: `SELECT gibbon_group_position, gibbon_is_allocated, permissions_gibbon, metadata
              FROM ${this.tableName}
              WHERE ${allocatedClause}
                AND ${BYTEA_ANY_BIT_FN}(permissions_gibbon, $1) = TRUE`,
        params: [mask],
      },
      (row) => rowToGroup(row as GroupRow)
    );
  }

  /**
   * Finds the first available non-allocated group, allocates it,
   * and stores the given additional metadata.
   *
   * Concurrency-safe: uses `SELECT ... FOR UPDATE SKIP LOCKED`.
   *
   * @param data - Additional metadata to store on the group (e.g. name, description)
   * @param client - Optional transactional client
   * @returns The newly allocated group row
   * @throws Error when all group slots are already allocated
   */
  async allocate<T extends Record<string, unknown>>(
    data: T,
    client?: PoolClient
  ): Promise<IGibbonGroup> {
    const sanitized = GibbonGroup.sanitizeData(data);
    const emptyPerms = Gibbon.create(this.byteLength).toBuffer();
    const result = await this.runner(client).query<GroupRow>(
      `UPDATE ${this.tableName}
       SET gibbon_is_allocated = TRUE,
           metadata = $1::jsonb,
           permissions_gibbon = $2
       WHERE gibbon_group_position = (
         SELECT gibbon_group_position FROM ${this.tableName}
         WHERE gibbon_is_allocated = FALSE
         ORDER BY gibbon_group_position ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING gibbon_group_position, gibbon_is_allocated, permissions_gibbon, metadata`,
      [JSON.stringify(sanitized), emptyPerms]
    );
    if (result.rows.length === 0) {
      throw new Error(
        'Not able to allocate group, seems all groups are allocated'
      );
    }
    return rowToGroup(result.rows[0]);
  }

  /**
   * Finds all groups that have any of the given permissions set,
   * and unsets those permission bits.
   *
   * @param permissions - Permission positions to unset from groups
   * @param client - Optional transactional client
   */
  async unsetPermissions(
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    const permissionsToUnset = this.ensureGibbon(permissions);
    const mask = permissionsToUnset.toBuffer();
    const positionsToUnset = permissionsToUnset.getPositionsArray();
    if (positionsToUnset.length === 0) {
      return;
    }

    const queryable = this.runner(client);
    const rows = await queryRows<{
      gibbon_group_position: number;
      permissions_gibbon: Buffer;
    }>(
      queryable,
      `SELECT gibbon_group_position, permissions_gibbon FROM ${this.tableName}
       WHERE ${BYTEA_ANY_BIT_FN}(permissions_gibbon, $1) = TRUE`,
      [mask]
    );

    for (const row of rows) {
      const updated = Gibbon.decode(row.permissions_gibbon)
        .unsetAllFromPositions(positionsToUnset)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE gibbon_group_position = $2`,
        [updated, row.gibbon_group_position]
      );
    }
  }

  /**
   * Resets the given groups to their default (non-allocated) state.
   * Clears their permissions and marks them as available for re-allocation.
   *
   * Note: removing group membership from users is handled by the facade.
   *
   * @param groups - Group positions to deallocate
   * @param client - Optional transactional client
   */
  async deallocate(groups: GibbonLike, client?: PoolClient): Promise<void> {
    const positions = this.ensureGibbon(groups).getPositionsArray();
    if (positions.length === 0) {
      return;
    }
    const emptyPerms = Gibbon.create(this.byteLength).toBuffer();
    await this.runner(client).query(
      `UPDATE ${this.tableName}
       SET gibbon_is_allocated = FALSE,
           metadata = '{}'::jsonb,
           permissions_gibbon = $1
       WHERE gibbon_group_position = ANY($2::int[])`,
      [emptyPerms, positions]
    );
  }

  /**
   * Merges the given permissions into each of the specified groups.
   *
   * Note: updating user permissions is handled by the facade.
   *
   * @param groups - Gibbon representing groups to update
   * @param permissions - Gibbon representing permissions to subscribe
   * @param client - Optional transactional client
   */
  async subscribePermissions(
    groups: Gibbon,
    permissions: Gibbon,
    client?: PoolClient
  ): Promise<void> {
    const positions = groups.getPositionsArray();
    if (positions.length === 0) {
      return;
    }
    const queryable = this.runner(client);
    const rows = await queryRows<{
      gibbon_group_position: number;
      permissions_gibbon: Buffer;
    }>(
      queryable,
      `SELECT gibbon_group_position, permissions_gibbon FROM ${this.tableName}
       WHERE gibbon_group_position = ANY($1::int[])`,
      [positions]
    );

    for (const row of rows) {
      const merged = Gibbon.decode(row.permissions_gibbon)
        .mergeWithGibbon(permissions)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE gibbon_group_position = $2`,
        [merged, row.gibbon_group_position]
      );
    }
  }

  /**
   * Returns a cursor over all allocated group rows.
   *
   * @returns A streaming cursor of all allocated group rows
   */
  public findAllocated(): PgCursor<IGibbonGroup> {
    return new PgCursor<IGibbonGroup>(
      { pool: this.pool },
      {
        sql: `SELECT gibbon_group_position, gibbon_is_allocated, permissions_gibbon, metadata
              FROM ${this.tableName}
              WHERE gibbon_is_allocated = TRUE`,
      },
      (row) => rowToGroup(row as GroupRow)
    );
  }

  /**
   * Updates custom metadata on an allocated group (e.g. name, description).
   * Merges the supplied fields into the existing `metadata` JSONB column —
   * existing fields not in `data` are preserved.
   *
   * @param groupPosition - The position of the group to update
   * @param data - Key-value pairs to merge into the metadata column
   * @param client - Optional transactional client
   * @returns The updated group row, or `null` if no allocated group was found at that position
   */
  public async updateMetadata<T extends Record<string, unknown>>(
    groupPosition: number,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonGroup | null> {
    const sanitized = GibbonGroup.sanitizeData(data);
    const result = await this.runner(client).query<GroupRow>(
      `UPDATE ${this.tableName}
       SET metadata = metadata || $1::jsonb
       WHERE gibbon_group_position = $2
         AND gibbon_is_allocated = TRUE
       RETURNING gibbon_group_position, gibbon_is_allocated, permissions_gibbon, metadata`,
      [JSON.stringify(sanitized), groupPosition]
    );
    return result.rows.length === 0 ? null : rowToGroup(result.rows[0]);
  }

  /**
   * Resizes the `permissions_gibbon` column in every group row to the given
   * byte length and updates the model's internal byte length.
   *
   * @param newByteLength - Target byte length for permission gibbons
   * @param client - Optional transactional client
   */
  async resizePermissions(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    const queryable = this.runner(client);
    const rows = await queryRows<{
      gibbon_group_position: number;
      permissions_gibbon: Buffer;
    }>(
      queryable,
      `SELECT gibbon_group_position, permissions_gibbon FROM ${this.tableName}`
    );
    for (const row of rows) {
      const resized = GibbonGroup.resizeGibbon(
        row.permissions_gibbon,
        newByteLength
      );
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE gibbon_group_position = $2`,
        [resized, row.gibbon_group_position]
      );
    }
  }

  /**
   * Unsets the given permission bits from the specified groups.
   * This is the reverse of {@link subscribePermissions}.
   *
   * Note: recalculating user permissions is handled by the facade.
   *
   * @param groups - Gibbon representing groups to update
   * @param permissions - Gibbon representing permissions to unsubscribe
   * @param client - Optional transactional client
   */
  async unsubscribePermissions(
    groups: Gibbon,
    permissions: Gibbon,
    client?: PoolClient
  ): Promise<void> {
    const positions = groups.getPositionsArray();
    const permissionPositions = permissions.getPositionsArray();
    if (positions.length === 0 || permissionPositions.length === 0) {
      return;
    }
    const queryable = this.runner(client);
    const rows = await queryRows<{
      gibbon_group_position: number;
      permissions_gibbon: Buffer;
    }>(
      queryable,
      `SELECT gibbon_group_position, permissions_gibbon FROM ${this.tableName}
       WHERE gibbon_group_position = ANY($1::int[])`,
      [positions]
    );

    for (const row of rows) {
      const updated = Gibbon.decode(row.permissions_gibbon)
        .unsetAllFromPositions(permissionPositions)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE gibbon_group_position = $2`,
        [updated, row.gibbon_group_position]
      );
    }
  }
}
