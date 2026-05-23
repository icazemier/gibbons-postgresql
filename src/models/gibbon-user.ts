import { Buffer } from 'node:buffer';
import { Gibbon } from '@icazemier/gibbons';
import type { Pool, PoolClient } from 'pg';
import { IGibbonUser, GibbonLike } from '../interfaces/index.js';
import { IPermissionsResource } from '../interfaces/permissions-resource.js';
import { GibbonModel } from './gibbon-model.js';
import { PgCursor } from '../cursor.js';
import { quoteIdent } from '../sql.js';
import { combineClauses, WhereClause } from '../queryable.js';
import { BYTEA_ANY_BIT_FN } from '../seeder.js';

interface UserRow {
  id: string;
  groups_gibbon: Buffer;
  permissions_gibbon: Buffer;
  metadata: Record<string, unknown>;
}

function rowToUser(row: UserRow): IGibbonUser {
  return {
    id: row.id,
    groupsGibbon: Gibbon.decode(row.groups_gibbon),
    permissionsGibbon: Gibbon.decode(row.permissions_gibbon),
    ...row.metadata,
  };
}

/**
 * Builds a `WhereClause` matching users whose `groups_gibbon` or
 * `permissions_gibbon` shares any bit with the given mask.
 *
 * @internal
 */
export function maskClause(
  column: 'groups_gibbon' | 'permissions_gibbon',
  mask: Buffer
): WhereClause {
  return {
    sql: `${BYTEA_ANY_BIT_FN}(${column}, $1) = TRUE`,
    params: [mask],
  };
}

const SELECT_COLUMNS = 'id, groups_gibbon, permissions_gibbon, metadata';

/**
 * Model for managing user rows in PostgreSQL.
 * Users hold bitwise masks for group memberships and aggregated permissions
 * along with a UUID primary key and a free-form JSONB metadata column.
 */
export class GibbonUser extends GibbonModel {
  constructor(pool: Pool, byteLength = 256) {
    super(pool, byteLength);
  }

  async initialize(_dbName: string, tableName: string): Promise<void> {
    this.tableName = quoteIdent(tableName);
  }

  /**
   * Finds users that have any of the given permissions set.
   *
   * @param permissions - Permission positions to search for
   * @returns A streaming cursor of matching user rows
   */
  findByPermissions(permissions: GibbonLike): PgCursor<IGibbonUser> {
    const mask = this.ensureGibbon(permissions).toBuffer();
    const clause = maskClause('permissions_gibbon', mask);
    return new PgCursor<IGibbonUser>(
      { pool: this.pool },
      {
        sql: `SELECT ${SELECT_COLUMNS} FROM ${this.tableName} WHERE ${clause.sql}`,
        params: clause.params,
      },
      (row) => rowToUser(row as UserRow)
    );
  }

  /**
   * Finds users that are subscribed to any of the given groups.
   *
   * @param groups - Group positions to search for
   * @returns A streaming cursor of matching user rows
   */
  findByGroups(groups: GibbonLike): PgCursor<IGibbonUser> {
    const mask = this.ensureGibbon(groups).toBuffer();
    const clause = maskClause('groups_gibbon', mask);
    return new PgCursor<IGibbonUser>(
      { pool: this.pool },
      {
        sql: `SELECT ${SELECT_COLUMNS} FROM ${this.tableName} WHERE ${clause.sql}`,
        params: clause.params,
      },
      (row) => rowToUser(row as UserRow)
    );
  }

  /**
   * Finds users matching a compiled `WhereClause`.
   *
   * The facade is responsible for converting the public `UserFilter` into a
   * `WhereClause` via `buildUserWhere`.
   */
  findByWhere(where: WhereClause): PgCursor<IGibbonUser> {
    return new PgCursor<IGibbonUser>(
      { pool: this.pool },
      {
        sql: `SELECT ${SELECT_COLUMNS} FROM ${this.tableName} WHERE ${where.sql}`,
        params: where.params,
      },
      (row) => rowToUser(row as UserRow)
    );
  }

  /**
   * Finds all users that have any of the given permissions set,
   * and unsets those permission bits.
   *
   * @param permissions - Permission positions to unset from users
   * @param client - Optional transactional client
   */
  async unsetPermissions(
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    const permissionsToUnset = this.ensureGibbon(permissions);
    const positionsToUnset = permissionsToUnset.getPositionsArray();
    if (positionsToUnset.length === 0) {
      return;
    }
    const mask = permissionsToUnset.toBuffer();
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; permissions_gibbon: Buffer }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, permissions_gibbon FROM ${this.tableName}
              WHERE ${BYTEA_ANY_BIT_FN}(permissions_gibbon, $1) = TRUE`,
        params: [mask],
      },
      (row) => row as { id: string; permissions_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const updated = Gibbon.decode(row.permissions_gibbon)
        .unsetAllFromPositions(positionsToUnset)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE id = $2::uuid`,
        [updated, row.id]
      );
    }
  }

  /**
   * Finds users subscribed to the given groups, unsets those group bits,
   * and recalculates their permissions from remaining group memberships.
   *
   * @param groups - Group positions to unset from users
   * @param permissionsResource - Resource used to recalculate permissions from remaining groups
   * @param client - Optional transactional client
   */
  async unsetGroups(
    groups: GibbonLike,
    permissionsResource: IPermissionsResource,
    client?: PoolClient
  ): Promise<void> {
    const groupsToUnset = this.ensureGibbon(groups);
    const positionsToUnset = groupsToUnset.getPositionsArray();
    if (positionsToUnset.length === 0) {
      return;
    }
    const mask = groupsToUnset.toBuffer();
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; groups_gibbon: Buffer }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, groups_gibbon FROM ${this.tableName}
              WHERE ${BYTEA_ANY_BIT_FN}(groups_gibbon, $1) = TRUE`,
        params: [mask],
      },
      (row) => row as { id: string; groups_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const groupsGibbon = Gibbon.decode(
        row.groups_gibbon
      ).unsetAllFromPositions(positionsToUnset);
      const permissionGibbon =
        await permissionsResource.getPermissionsGibbonForGroups(groupsGibbon);
      await queryable.query(
        `UPDATE ${this.tableName}
         SET groups_gibbon = $1,
             permissions_gibbon = $2
         WHERE id = $3::uuid`,
        [groupsGibbon.toBuffer(), permissionGibbon.toBuffer(), row.id]
      );
    }
  }

  /**
   * Finds users matching the where clause, merges the given groups and
   * permissions into their existing memberships.
   *
   * @param where - Compiled where clause selecting users
   * @param groups - Gibbon representing groups to subscribe
   * @param permissions - Gibbon representing permissions to subscribe
   * @param client - Optional transactional client
   */
  async subscribeToGroupsAndPermissions(
    where: WhereClause,
    groups: Gibbon,
    permissions: Gibbon,
    client?: PoolClient
  ): Promise<void> {
    const queryable = this.runner(client);
    const cursor = new PgCursor<{
      id: string;
      groups_gibbon: Buffer;
      permissions_gibbon: Buffer;
    }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, groups_gibbon, permissions_gibbon FROM ${this.tableName}
              WHERE ${where.sql}`,
        params: where.params,
      },
      (row) =>
        row as { id: string; groups_gibbon: Buffer; permissions_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const groupsMerged = Gibbon.decode(row.groups_gibbon)
        .mergeWithGibbon(groups)
        .toBuffer();
      const permissionsMerged = Gibbon.decode(row.permissions_gibbon)
        .mergeWithGibbon(permissions)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET groups_gibbon = $1,
             permissions_gibbon = $2
         WHERE id = $3::uuid`,
        [groupsMerged, permissionsMerged, row.id]
      );
    }
  }

  /**
   * Finds all users subscribed to the given groups and merges the given
   * permissions into their existing permissions.
   *
   * @param groups - Gibbon representing groups to match users against
   * @param permissions - Gibbon representing permissions to subscribe
   * @param client - Optional transactional client
   */
  async subscribeToPermissionsForGroups(
    groups: Gibbon,
    permissions: Gibbon,
    client?: PoolClient
  ): Promise<void> {
    const groupsMask = groups.toBuffer();
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; permissions_gibbon: Buffer }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, permissions_gibbon FROM ${this.tableName}
              WHERE ${BYTEA_ANY_BIT_FN}(groups_gibbon, $1) = TRUE`,
        params: [groupsMask],
      },
      (row) => row as { id: string; permissions_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const merged = Gibbon.decode(row.permissions_gibbon)
        .mergeWithGibbon(permissions)
        .toBuffer();
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE id = $2::uuid`,
        [merged, row.id]
      );
    }
  }

  /**
   * Updates custom metadata on a user row.
   * Merges the supplied fields into the existing `metadata` JSONB column —
   * existing fields not in `data` are preserved.
   *
   * Returns the first updated user. If multiple users match the where clause,
   * only one is returned (mirrors MongoDB's `findOneAndUpdate` semantics).
   *
   * @param where - Compiled where clause selecting users
   * @param data - Key-value pairs to merge into the metadata column
   * @param client - Optional transactional client
   * @returns The updated user row, or null if no user matched
   */
  public async updateMetadata<T extends Record<string, unknown>>(
    where: WhereClause,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonUser | null> {
    const sanitized = GibbonUser.sanitizeData(data);
    const placeholder = `$${where.params.length + 1}`;
    const result = await this.runner(client).query<UserRow>(
      `UPDATE ${this.tableName}
       SET metadata = metadata || ${placeholder}::jsonb
       WHERE id = (
         SELECT id FROM ${this.tableName}
         WHERE ${where.sql}
         LIMIT 1
       )
       RETURNING ${SELECT_COLUMNS}`,
      [...where.params, JSON.stringify(sanitized)]
    );
    return result.rows.length === 0 ? null : rowToUser(result.rows[0]);
  }

  /**
   * Resizes the `permissions_gibbon` column in every user row to the given byte length.
   *
   * @param newByteLength - Target byte length for permission gibbons
   * @param client - Optional transactional client
   */
  async resizePermissions(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; permissions_gibbon: Buffer }>(
      this.cursorSource(client),
      { sql: `SELECT id, permissions_gibbon FROM ${this.tableName}` },
      (row) => row as { id: string; permissions_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const resized = GibbonUser.resizeGibbon(
        row.permissions_gibbon,
        newByteLength
      );
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE id = $2::uuid`,
        [resized, row.id]
      );
    }
  }

  /**
   * Resizes the `groups_gibbon` column in every user row to the given byte length.
   *
   * @param newByteLength - Target byte length for group gibbons
   * @param client - Optional transactional client
   */
  async resizeGroups(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; groups_gibbon: Buffer }>(
      this.cursorSource(client),
      { sql: `SELECT id, groups_gibbon FROM ${this.tableName}` },
      (row) => row as { id: string; groups_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const resized = GibbonUser.resizeGibbon(row.groups_gibbon, newByteLength);
      await queryable.query(
        `UPDATE ${this.tableName}
         SET groups_gibbon = $1
         WHERE id = $2::uuid`,
        [resized, row.id]
      );
    }
  }

  /**
   * Creates a new user row with empty group and permission gibbons.
   *
   * @param data - Additional metadata to store on the user (e.g. name, email)
   * @param groupByteLength - Byte length for the groups Gibbon
   * @param permissionByteLength - Byte length for the permissions Gibbon
   * @param client - Optional transactional client
   * @returns The newly created user row
   */
  async create<T extends Record<string, unknown>>(
    data: T,
    groupByteLength: number,
    permissionByteLength: number,
    client?: PoolClient
  ): Promise<IGibbonUser> {
    const sanitized = GibbonUser.sanitizeData(data);
    const emptyGroups = Gibbon.create(groupByteLength).toBuffer();
    const emptyPermissions = Gibbon.create(permissionByteLength).toBuffer();
    const result = await this.runner(client).query<UserRow>(
      `INSERT INTO ${this.tableName} (groups_gibbon, permissions_gibbon, metadata)
       VALUES ($1, $2, $3::jsonb)
       RETURNING ${SELECT_COLUMNS}`,
      [emptyGroups, emptyPermissions, JSON.stringify(sanitized)]
    );
    return rowToUser(result.rows[0]);
  }

  /**
   * Remove user(s) matching the given where clause.
   *
   * @param where - Compiled where clause selecting users to remove
   * @param client - Optional transactional client
   * @returns Number of deleted users
   */
  async remove(where: WhereClause, client?: PoolClient): Promise<number> {
    const result = await this.runner(client).query(
      `DELETE FROM ${this.tableName} WHERE ${where.sql}`,
      where.params
    );
    return result.rowCount ?? 0;
  }

  /**
   * Unsubscribe users matching `where` from specific groups, then recalculate
   * their permissions from remaining groups.
   *
   * Internally combines `where` with a `groups_gibbon` mask predicate so users
   * who are not actually in the groups are skipped.
   *
   * @param where - Compiled where clause selecting users
   * @param groups - Groups to unsubscribe from
   * @param permissionsResource - Resource used to recalculate permissions
   * @param client - Optional transactional client
   */
  async unsubscribeFromGroups(
    where: WhereClause,
    groups: Gibbon,
    permissionsResource: IPermissionsResource,
    client?: PoolClient
  ): Promise<void> {
    const positionsToUnset = groups.getPositionsArray();
    if (positionsToUnset.length === 0) {
      return;
    }
    const combined = combineClauses(
      where,
      maskClause('groups_gibbon', groups.toBuffer())
    );
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; groups_gibbon: Buffer }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, groups_gibbon FROM ${this.tableName} WHERE ${combined.sql}`,
        params: combined.params,
      },
      (row) => row as { id: string; groups_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const groupsGibbon = Gibbon.decode(
        row.groups_gibbon
      ).unsetAllFromPositions(positionsToUnset);
      const permissionsGibbon =
        await permissionsResource.getPermissionsGibbonForGroups(groupsGibbon);
      await queryable.query(
        `UPDATE ${this.tableName}
         SET groups_gibbon = $1,
             permissions_gibbon = $2
         WHERE id = $3::uuid`,
        [groupsGibbon.toBuffer(), permissionsGibbon.toBuffer(), row.id]
      );
    }
  }

  /**
   * Recalculate permissions for users matching the where clause based on their
   * current group memberships.
   *
   * @param where - Compiled where clause selecting users
   * @param permissionsResource - Resource used to fetch permissions from groups
   * @param client - Optional transactional client
   */
  async recalculatePermissions(
    where: WhereClause,
    permissionsResource: IPermissionsResource,
    client?: PoolClient
  ): Promise<void> {
    const queryable = this.runner(client);
    const cursor = new PgCursor<{ id: string; groups_gibbon: Buffer }>(
      this.cursorSource(client),
      {
        sql: `SELECT id, groups_gibbon FROM ${this.tableName} WHERE ${where.sql}`,
        params: where.params,
      },
      (row) => row as { id: string; groups_gibbon: Buffer }
    );
    for await (const row of cursor) {
      const groupsGibbon = Gibbon.decode(row.groups_gibbon);
      const permissionsGibbon =
        await permissionsResource.getPermissionsGibbonForGroups(groupsGibbon);
      await queryable.query(
        `UPDATE ${this.tableName}
         SET permissions_gibbon = $1
         WHERE id = $2::uuid`,
        [permissionsGibbon.toBuffer(), row.id]
      );
    }
  }
}
