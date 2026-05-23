import { Pool, PoolClient } from 'pg';
import { Gibbon } from '@icazemier/gibbons';
import { GibbonUser, GibbonGroup, GibbonPermission } from './models/index.js';
import { maskClause } from './models/gibbon-user.js';
import { IPermissionsResource } from './interfaces/permissions-resource.js';
import { GibbonLike } from './interfaces/gibbon-like.js';
import { IGibbonGroup } from './interfaces/gibbon-group.js';
import { IGibbonUser } from './interfaces/gibbon-user.js';
import { Config } from './interfaces/config.js';
import { IGibbonPermission } from './interfaces/gibbon-permission.js';
import { UserFilter } from './interfaces/user-filter.js';
import { withTransaction } from './utils.js';
import { PostgreSqlSeeder } from './seeder.js';
import { quoteIdent, buildUserWhere } from './sql.js';
import { queryRows } from './queryable.js';
import { PgCursor } from './cursor.js';

/**
 * Main class which does all the "heavy" lifting against PostgreSQL for managing
 * users, groups, and permissions with bitwise efficiency using Gibbons.
 *
 * All multi-step operations are wrapped in PostgreSQL transactions
 * for atomicity and consistency.
 *
 * @example Complete workflow
 * ```typescript
 * import { GibbonsPostgreSql, ConfigLoader } from '@icazemier/gibbons-postgresql';
 *
 * const config = await ConfigLoader.load();
 * const gibbonsDb = new GibbonsPostgreSql(
 *   'postgresql://user:pass@localhost:5432/mydb',
 *   config
 * );
 * await gibbonsDb.initialize();
 *
 * const editPerm = await gibbonsDb.allocatePermission({ name: 'posts.edit' });
 * const deletePerm = await gibbonsDb.allocatePermission({ name: 'posts.delete' });
 *
 * const adminGroup = await gibbonsDb.allocateGroup({ name: 'Admins' });
 * await gibbonsDb.subscribePermissionsToGroups(
 *   [adminGroup.gibbonGroupPosition],
 *   [editPerm.gibbonPermissionPosition, deletePerm.gibbonPermissionPosition]
 * );
 *
 * const user = await gibbonsDb.createUser({ name: 'John', email: 'john@example.com' });
 * await gibbonsDb.subscribeUsersToGroups(
 *   { id: user.id },
 *   [adminGroup.gibbonGroupPosition]
 * );
 *
 * const hasEdit = gibbonsDb.validateUserPermissionsForAnyPermissions(
 *   user.permissionsGibbon,
 *   [editPerm.gibbonPermissionPosition]
 * );
 * ```
 */
export class GibbonsPostgreSql implements IPermissionsResource {
  protected gibbonGroup!: GibbonGroup;
  protected gibbonPermission!: GibbonPermission;
  protected gibbonUser!: GibbonUser;
  protected pool!: Pool;
  private readonly poolOrUri: Pool | string;

  /**
   * Creates a new GibbonsPostgreSql instance.
   *
   * @param poolOrUri - A PostgreSQL connection URI **or** an existing `pg.Pool`.
   *   When a `Pool` is provided the adapter re-uses it (no extra pool is created),
   *   so clients borrowed from that pool work with all facade methods.
   * @param config - Configuration containing database structure and byte lengths
   *
   * @example Using a URI (adapter creates its own pool)
   * ```typescript
   * const gibbonsDb = new GibbonsPostgreSql('postgresql://localhost:5432/mydb', config);
   * await gibbonsDb.initialize();
   * ```
   *
   * @example Using an existing Pool (shared connection)
   * ```typescript
   * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
   * const gibbonsDb = new GibbonsPostgreSql(pool, config);
   * await gibbonsDb.initialize();
   *
   * // Clients from `pool` work directly with withTransaction
   * await withTransaction(pool, async (client) => {
   *   await gibbonsDb.allocatePermission({ name: 'edit' }, client);
   *   await gibbonsDb.allocateGroup({ name: 'admins' }, client);
   * });
   * ```
   */
  constructor(
    poolOrUri: Pool | string,
    protected config: Config
  ) {
    this.poolOrUri = poolOrUri;
  }

  /**
   * Returns the underlying `pg.Pool` used by this instance.
   *
   * When a `Pool` was injected via the constructor this returns the same
   * instance, so clients borrowed from it work seamlessly with all facade
   * methods (e.g. inside `withTransaction`).
   *
   * @throws Error if called before {@link initialize}
   *
   * @example
   * ```typescript
   * const pool = gibbonsDb.getPool();
   * await withTransaction(pool, async (client) => {
   *   await gibbonsDb.allocatePermission({ name: 'edit' }, client);
   * });
   * ```
   */
  public getPool(): Pool {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this.pool) {
      throw new Error(
        'GibbonsPostgreSql is not initialized. Call initialize() first.'
      );
    }
    return this.pool;
  }

  /**
   * Initialize the GibbonsPostgreSql instance.
   *
   * When constructed with a URI a new `Pool` is created. When constructed with
   * an existing `Pool` the pool is re-used.
   *
   * Must be called before using any other methods.
   */
  public async initialize(): Promise<void> {
    const { poolOrUri, config } = this;

    this.pool =
      typeof poolOrUri === 'string'
        ? new Pool({ connectionString: poolOrUri })
        : poolOrUri;

    const { pool } = this;
    this.gibbonUser = new GibbonUser(pool, config.permissionByteLength);
    this.gibbonPermission = new GibbonPermission(pool, config);
    this.gibbonGroup = new GibbonGroup(pool, config);

    const {
      dbName,
      dbStructure: { group, permission, user },
    } = config;

    await Promise.all([
      this.gibbonUser.initialize(dbName, user.tableName),
      this.gibbonPermission.initialize(dbName, permission.tableName),
      this.gibbonGroup.initialize(dbName, group.tableName),
    ]);
  }

  /**
   * Creates a session-aware {@link IPermissionsResource} that threads the
   * transaction client into the underlying group query, so reads inside the
   * transaction see uncommitted writes.
   */
  private sessionAwarePermissionsResource(
    client: PoolClient
  ): IPermissionsResource {
    return {
      getPermissionsGibbonForGroups: (groups: Gibbon) =>
        this.gibbonGroup.getPermissionsGibbonForGroups(groups, client),
    };
  }

  /**
   * Runs `fn` inside a transaction when no external client is provided,
   * or uses the provided client directly (caller owns the transaction).
   */
  private async executeInSession<T>(
    client: PoolClient | undefined,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    if (client) {
      return fn(client);
    }
    return withTransaction(this.pool, fn);
  }

  /**
   * Fetches aggregated permissions from groups.
   * Useful to store at the user itself for fast permission checks.
   *
   * @param groups - Group positions or Gibbon representing groups
   * @returns A Gibbon with all permissions merged from the specified groups
   *
   * @example
   * ```typescript
   * // Get all permissions from admin and editor groups
   * const permissionsGibbon = await gibbonsDb.getPermissionsGibbonForGroups([1, 2]);
   * const permissionPositions = permissionsGibbon.getPositionsArray();
   * console.log(permissionPositions); // e.g., [1, 2, 5, 6, 10]
   * ```
   */
  public async getPermissionsGibbonForGroups(
    groups: GibbonLike
  ): Promise<Gibbon> {
    return this.gibbonGroup.getPermissionsGibbonForGroups(groups);
  }

  /**
   * Convenience function to retrieve group rows by positions.
   *
   * @param groups - Group positions to query for
   * @returns A streaming cursor of matching group rows
   *
   * @example
   * ```typescript
   * const cursor = gibbonsDb.findGroups([1, 2, 3]);
   * for await (const group of cursor) {
   *   console.log(group.name, group.permissionsGibbon);
   * }
   * ```
   */
  public findGroups(groups: GibbonLike): PgCursor<IGibbonGroup> {
    return this.gibbonGroup.find(groups);
  }

  /**
   * Convenience function to retrieve permission rows by positions.
   *
   * @param permissions - Permission positions to query for
   * @returns A streaming cursor of matching permission rows
   *
   * @example
   * ```typescript
   * const cursor = gibbonsDb.findPermissions([5, 6, 7]);
   * for await (const perm of cursor) {
   *   console.log(perm.name, perm.gibbonPermissionPosition);
   * }
   * ```
   */
  public findPermissions(permissions: GibbonLike): PgCursor<IGibbonPermission> {
    return this.gibbonPermission.find(permissions);
  }

  /**
   * Find allocated groups where permissions are subscribed.
   *
   * @param permissions - Permission positions to query for
   * @param allocated - Match for allocated (default) or non-allocated groups
   * @returns A streaming cursor of matching group rows
   *
   * @example
   * ```typescript
   * // Find all groups that have edit or delete permissions
   * const cursor = gibbonsDb.findGroupsByPermissions([5, 6]);
   * for await (const group of cursor) {
   *   console.log(`Group ${group.name} has edit/delete permissions`);
   * }
   * ```
   */
  public findGroupsByPermissions(
    permissions: GibbonLike,
    allocated = true
  ): PgCursor<IGibbonGroup> {
    return this.gibbonGroup.findByPermissions(permissions, allocated);
  }

  /**
   * Find users where permissions are subscribed.
   *
   * @param permissions - Permission positions to query for
   * @returns A streaming cursor of matching user rows
   *
   * @example
   * ```typescript
   * // Find all users with delete permission
   * const cursor = gibbonsDb.findUsersByPermissions([6]);
   * const usersWithDelete = await cursor.toArray();
   * ```
   */
  public findUsersByPermissions(
    permissions: GibbonLike
  ): PgCursor<IGibbonUser> {
    return this.gibbonUser.findByPermissions(permissions);
  }

  /**
   * Find users where groups are subscribed.
   *
   * @param groups - Group positions to query for
   * @returns A streaming cursor of matching user rows
   *
   * @example
   * ```typescript
   * // Find all users in admin or moderator groups
   * const cursor = gibbonsDb.findUsersByGroups([1, 2]);
   * for await (const user of cursor) {
   *   console.log(`${user.name} is admin or moderator`);
   * }
   * ```
   */
  public findUsersByGroups(groups: GibbonLike): PgCursor<IGibbonUser> {
    return this.gibbonUser.findByGroups(groups);
  }

  /**
   * Allocates a new permission with arbitrary metadata fields.
   * Searches for the first available non-allocated permission, allocates it,
   * and stores the given metadata as JSONB.
   */
  async allocatePermission<T extends Record<string, unknown>>(
    data: T,
    client?: PoolClient
  ): Promise<IGibbonPermission> {
    return this.gibbonPermission.allocate(data, client);
  }

  /**
   * Deallocates permission(s):
   * - Resets permissions to default values
   * - Removes related permissions from groups and users
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   */
  async deallocatePermissions(
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      await this.gibbonPermission.deallocate(permissions, c);
      await this.gibbonGroup.unsetPermissions(permissions, c);
      await this.gibbonUser.unsetPermissions(permissions, c);
    });
  }

  /**
   * Search for the first available non-allocated group, then allocates it
   * and stores the given additional metadata.
   */
  public async allocateGroup<T extends Record<string, unknown>>(
    data: T,
    client?: PoolClient
  ): Promise<IGibbonGroup> {
    return this.gibbonGroup.allocate(data, client);
  }

  /**
   * Resets default values to each given group, then removes membership from
   * each user for these groups.
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   */
  public async deallocateGroups(
    groups: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      const permissionsResource = this.sessionAwarePermissionsResource(c);
      await this.gibbonGroup.deallocate(groups, c);
      await this.gibbonUser.unsetGroups(groups, permissionsResource, c);
    });
  }

  /**
   * Given a set of user groups, validate they have ALL given groups set.
   */
  public validateUserGroupsForAllGroups(
    userGroups: GibbonLike,
    groups: GibbonLike
  ): boolean {
    const userGroupsGibbon = this.gibbonGroup.ensureGibbon(userGroups);
    const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
    return userGroupsGibbon.hasAllFromGibbon(groupsGibbon);
  }

  /**
   * Given a set of user groups, validate they have ANY of given groups set.
   */
  public validateUserGroupsForAnyGroups(
    userGroups: GibbonLike,
    groups: GibbonLike
  ): boolean {
    const userGroupsGibbon = this.gibbonGroup.ensureGibbon(userGroups);
    const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
    return userGroupsGibbon.hasAnyFromGibbon(groupsGibbon);
  }

  /**
   * Given a set of user permissions, validate they have ALL of given permissions set.
   */
  public validateUserPermissionsForAllPermissions(
    userPermissions: GibbonLike,
    permissions: GibbonLike
  ): boolean {
    const userPermissionsGibbon =
      this.gibbonPermission.ensureGibbon(userPermissions);
    const permissionsGibbon = this.gibbonPermission.ensureGibbon(permissions);
    return userPermissionsGibbon.hasAllFromGibbon(permissionsGibbon);
  }

  /**
   * Given a set of user permissions, validate it has ANY of given permissions set.
   */
  public validateUserPermissionsForAnyPermissions(
    userPermissions: GibbonLike,
    permissions: GibbonLike
  ): boolean {
    const userPermissionsGibbon =
      this.gibbonPermission.ensureGibbon(userPermissions);
    const permissionsGibbon = this.gibbonPermission.ensureGibbon(permissions);
    return userPermissionsGibbon.hasAnyFromGibbon(permissionsGibbon);
  }

  /**
   * Queries database if given groups are indeed allocated
   * (possible to validate the non-allocated ones).
   */
  public async validateAllocatedGroups(
    groups: GibbonLike,
    allocated = true
  ): Promise<boolean> {
    return this.gibbonGroup.validate(groups, allocated);
  }

  /**
   * Queries database if given permissions are indeed allocated
   * (possible to validate the non-allocated ones).
   */
  public async validateAllocatedPermissions(
    permissions: GibbonLike,
    allocated = true
  ): Promise<boolean> {
    return this.gibbonPermission.validate(permissions, allocated);
  }

  /**
   * Retrieve users and their current group membership, patch given groups and
   * update their aggregated permissions.
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   */
  async subscribeUsersToGroups(
    filter: UserFilter,
    groups: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
      const valid = await this.gibbonGroup.validate(groupsGibbon, true, c);
      if (!valid) {
        throw new Error(
          `Suggested groups aren't valid (not allocated): ${groupsGibbon.getPositionsArray()}`
        );
      }
      const permissionsGibbon =
        await this.gibbonGroup.getPermissionsGibbonForGroups(groupsGibbon, c);
      const where = buildUserWhere(filter);
      await this.gibbonUser.subscribeToGroupsAndPermissions(
        where,
        groupsGibbon,
        permissionsGibbon,
        c
      );
    });
  }

  /**
   * Subscribe (set) permissions to given groups.
   * Users subscribed to these groups are updated with these additional permissions.
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   *
   * @throws Error when given groups or permissions are not allocated
   */
  async subscribePermissionsToGroups(
    groups: GibbonLike,
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
      const permissionGibbon = this.gibbonPermission.ensureGibbon(permissions);

      const [permissionsValid, groupsValid] = await Promise.all([
        this.gibbonPermission.validate(permissionGibbon, true, c),
        this.gibbonGroup.validate(groupsGibbon, true, c),
      ]);

      if (!permissionsValid) {
        throw new Error(
          `Suggested permissions are not valid (not allocated): ${permissionGibbon.getPositionsArray()}`
        );
      }
      if (!groupsValid) {
        throw new Error(
          `Suggested groups are not valid (not allocated): ${groupsGibbon.getPositionsArray()}`
        );
      }

      await this.gibbonGroup.subscribePermissions(
        groupsGibbon,
        permissionGibbon,
        c
      );
      await this.gibbonUser.subscribeToPermissionsForGroups(
        groupsGibbon,
        permissionGibbon,
        c
      );
    });
  }

  /**
   * Create a new user with initial empty gibbons.
   * Additional custom data can be passed (e.g. name, email) and is persisted
   * as JSONB in the `metadata` column.
   */
  async createUser<T extends Record<string, unknown>>(
    data: T,
    client?: PoolClient
  ): Promise<IGibbonUser> {
    const { groupByteLength, permissionByteLength } = this.config;
    return this.gibbonUser.create(
      data,
      groupByteLength,
      permissionByteLength,
      client
    );
  }

  /**
   * Remove user(s) matching the given filter.
   *
   * @returns Number of removed users
   * @throws Error when filter is empty — requires at least `id` or `metadata` to prevent accidental mass deletion
   */
  async removeUser(filter: UserFilter, client?: PoolClient): Promise<number> {
    if (filter.id === undefined && filter.metadata === undefined) {
      throw new Error(
        'removeUser requires at least one filter condition (id or metadata) to prevent accidental mass deletion'
      );
    }
    const where = buildUserWhere(filter);
    return this.gibbonUser.remove(where, client);
  }

  /**
   * Find users by arbitrary {@link UserFilter}.
   */
  public findUsers(filter: UserFilter): PgCursor<IGibbonUser> {
    return this.gibbonUser.findByWhere(buildUserWhere(filter));
  }

  /**
   * List all allocated groups.
   */
  public findAllAllocatedGroups(): PgCursor<IGibbonGroup> {
    return this.gibbonGroup.findAllocated();
  }

  /**
   * List all allocated permissions.
   */
  public findAllAllocatedPermissions(): PgCursor<IGibbonPermission> {
    return this.gibbonPermission.findAllocated();
  }

  /**
   * Update metadata on an allocated group (e.g. name, description).
   * Does not modify `gibbonGroupPosition`, `gibbonIsAllocated` or `permissionsGibbon`.
   */
  public async updateGroupMetadata<T extends Record<string, unknown>>(
    groupPosition: number,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonGroup | null> {
    return this.gibbonGroup.updateMetadata(groupPosition, data, client);
  }

  /**
   * Update metadata on an allocated permission (e.g. name, description).
   * Does not modify `gibbonPermissionPosition` or `gibbonIsAllocated`.
   */
  public async updatePermissionMetadata<T extends Record<string, unknown>>(
    permissionPosition: number,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonPermission | null> {
    return this.gibbonPermission.updateMetadata(
      permissionPosition,
      data,
      client
    );
  }

  /**
   * Update metadata on a user (e.g. name, email).
   * Does not modify `groupsGibbon` or `permissionsGibbon`.
   */
  public async updateUserMetadata<T extends Record<string, unknown>>(
    filter: UserFilter,
    data: T,
    client?: PoolClient
  ): Promise<IGibbonUser | null> {
    return this.gibbonUser.updateMetadata(buildUserWhere(filter), data, client);
  }

  /**
   * Unsubscribe users matching filter from specific groups.
   * Recalculates their permissions from remaining groups.
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   */
  async unsubscribeUsersFromGroups(
    filter: UserFilter,
    groups: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
      const permissionsResource = this.sessionAwarePermissionsResource(c);
      await this.gibbonUser.unsubscribeFromGroups(
        buildUserWhere(filter),
        groupsGibbon,
        permissionsResource,
        c
      );
    });
  }

  /**
   * Remove specific permissions from specific groups.
   * Recalculates permissions for all users in affected groups.
   *
   * Runs inside a transaction for atomicity when no client is supplied.
   */
  async unsubscribePermissionsFromGroups(
    groups: GibbonLike,
    permissions: GibbonLike,
    client?: PoolClient
  ): Promise<void> {
    await this.executeInSession(client, async (c) => {
      const groupsGibbon = this.gibbonGroup.ensureGibbon(groups);
      const permissionsGibbon = this.gibbonPermission.ensureGibbon(permissions);
      const permissionsResource = this.sessionAwarePermissionsResource(c);

      await this.gibbonGroup.unsubscribePermissions(
        groupsGibbon,
        permissionsGibbon,
        c
      );

      await this.gibbonUser.recalculatePermissions(
        maskClause('groups_gibbon', groupsGibbon.toBuffer()),
        permissionsResource,
        c
      );
    });
  }

  /**
   * Expands the permission byte length, seeding new permission slots and
   * resizing all `permissions_gibbon` columns in groups and users.
   *
   * @param newByteLength - Must be greater than the current `permissionByteLength`
   * @param client - Optional external client (caller owns the transaction)
   */
  async expandPermissions(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('newByteLength must be a positive integer');
    }
    const oldByteLength = this.config.permissionByteLength;
    if (newByteLength <= oldByteLength) {
      throw new Error(
        `newByteLength (${newByteLength}) must be greater than current permissionByteLength (${oldByteLength})`
      );
    }

    await this.executeInSession(client, async (c) => {
      const seeder = new PostgreSqlSeeder(this.pool, this.config);
      await seeder.seedRange(
        'permission',
        oldByteLength * 8 + 1,
        newByteLength * 8,
        c
      );
      await this.gibbonGroup.resizePermissions(newByteLength, c);
      await this.gibbonUser.resizePermissions(newByteLength, c);
      this.config.permissionByteLength = newByteLength;
      this.gibbonPermission.setByteLength(newByteLength);
    });
  }

  /**
   * Expands the group byte length, seeding new group slots and resizing all
   * `groups_gibbon` columns in users.
   *
   * @param newByteLength - Must be greater than the current `groupByteLength`
   * @param client - Optional external client (caller owns the transaction)
   */
  async expandGroups(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('newByteLength must be a positive integer');
    }
    const oldByteLength = this.config.groupByteLength;
    if (newByteLength <= oldByteLength) {
      throw new Error(
        `newByteLength (${newByteLength}) must be greater than current groupByteLength (${oldByteLength})`
      );
    }

    await this.executeInSession(client, async (c) => {
      const seeder = new PostgreSqlSeeder(this.pool, this.config);
      await seeder.seedRange(
        'group',
        oldByteLength * 8 + 1,
        newByteLength * 8,
        c
      );
      await this.gibbonUser.resizeGroups(newByteLength, c);
      this.config.groupByteLength = newByteLength;
      this.gibbonGroup.setByteLength(newByteLength);
    });
  }

  /**
   * Shrinks the permission byte length, removing trailing permission slots
   * and truncating all `permissions_gibbon` columns in groups and users.
   *
   * @throws Error if allocated permissions exist beyond the new boundary
   */
  async shrinkPermissions(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('newByteLength must be a positive integer');
    }
    const oldByteLength = this.config.permissionByteLength;
    if (newByteLength >= oldByteLength) {
      throw new Error(
        `newByteLength (${newByteLength}) must be less than current permissionByteLength (${oldByteLength})`
      );
    }

    await this.executeInSession(client, async (c) => {
      const permTable = quoteIdent(
        this.config.dbStructure.permission.tableName
      );
      const beyondRows = await queryRows<{ count: string }>(
        c,
        `SELECT COUNT(*)::text AS count FROM ${permTable}
         WHERE gibbon_permission_position > $1
           AND gibbon_is_allocated = TRUE`,
        [newByteLength * 8]
      );
      if (Number(beyondRows[0].count) > 0) {
        throw new Error(
          'Cannot shrink: allocated permissions exist beyond the new boundary'
        );
      }
      await c.query(
        `DELETE FROM ${permTable}
         WHERE gibbon_permission_position > $1`,
        [newByteLength * 8]
      );
      await this.gibbonGroup.resizePermissions(newByteLength, c);
      await this.gibbonUser.resizePermissions(newByteLength, c);
      this.config.permissionByteLength = newByteLength;
      this.gibbonPermission.setByteLength(newByteLength);
    });
  }

  /**
   * Shrinks the group byte length, removing trailing group slots and
   * truncating all `groups_gibbon` columns in users.
   *
   * @throws Error if allocated groups exist beyond the new boundary
   */
  async shrinkGroups(
    newByteLength: number,
    client?: PoolClient
  ): Promise<void> {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('newByteLength must be a positive integer');
    }
    const oldByteLength = this.config.groupByteLength;
    if (newByteLength >= oldByteLength) {
      throw new Error(
        `newByteLength (${newByteLength}) must be less than current groupByteLength (${oldByteLength})`
      );
    }

    await this.executeInSession(client, async (c) => {
      const groupTable = quoteIdent(this.config.dbStructure.group.tableName);
      const beyondRows = await queryRows<{ count: string }>(
        c,
        `SELECT COUNT(*)::text AS count FROM ${groupTable}
         WHERE gibbon_group_position > $1
           AND gibbon_is_allocated = TRUE`,
        [newByteLength * 8]
      );
      if (Number(beyondRows[0].count) > 0) {
        throw new Error(
          'Cannot shrink: allocated groups exist beyond the new boundary'
        );
      }
      await c.query(
        `DELETE FROM ${groupTable} WHERE gibbon_group_position > $1`,
        [newByteLength * 8]
      );
      await this.gibbonUser.resizeGroups(newByteLength, c);
      this.config.groupByteLength = newByteLength;
      this.gibbonGroup.setByteLength(newByteLength);
    });
  }
}
