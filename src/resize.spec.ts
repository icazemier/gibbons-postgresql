import { Buffer } from 'node:buffer';
import {
  beforeAll,
  describe,
  expect,
  it,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { Gibbon } from '@icazemier/gibbons';
import { Pool } from 'pg';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import { GibbonsPostgreSql } from './gibbons-postgresql.js';
import { PostgreSqlSeeder } from './seeder.js';
import { Config } from './interfaces/index.js';
import { TestUser, TestGroup } from '../test/interfaces/test-interfaces.js';
import { withTransaction } from './utils.js';
import { quoteIdent } from './sql.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    dbName: 'gibbons_resize_test',
    permissionByteLength: 2,
    groupByteLength: 2,
    postgresqlMutationConcurrency: 10,
    dbStructure: {
      user: { tableName: 'resize_users' },
      group: { tableName: 'resize_groups' },
      permission: { tableName: 'resize_permissions' },
    },
    ...overrides,
  };
}

describe('Resize: expand and shrink', () => {
  let pool: Pool;
  let config: Config;
  let adapter: GibbonsPostgreSql;
  let groupTable: string;
  let permTable: string;
  let userTable: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    config = makeConfig();
    groupTable = quoteIdent(config.dbStructure.group.tableName);
    permTable = quoteIdent(config.dbStructure.permission.tableName);
    userTable = quoteIdent(config.dbStructure.user.tableName);

    await pool.query(
      `DROP TABLE IF EXISTS ${userTable}, ${groupTable}, ${permTable} CASCADE`
    );

    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize();

    adapter = new GibbonsPostgreSql(pool, config);
    await adapter.initialize();
  });

  afterEach(async () => {
    await pool.query(
      `DROP TABLE IF EXISTS ${userTable}, ${groupTable}, ${permTable} CASCADE`
    );
  });

  // ---------- expandPermissions ----------

  it('expandPermissions — seeds new slots and pads BYTEA fields', async () => {
    const perm = await adapter.allocatePermission({ name: 'perm1' });
    const group = await adapter.allocateGroup({ name: 'group1' });
    await adapter.subscribePermissionsToGroups(
      [group.gibbonGroupPosition],
      [perm.gibbonPermissionPosition]
    );
    const user = await adapter.createUser({
      name: 'Alice',
      email: 'alice@test.com',
    });
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    const oldPermCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permTable}`
    );
    expect(Number(oldPermCount.rows[0].count)).toBe(16);

    await adapter.expandPermissions(4);

    const newPermCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permTable}`
    );
    expect(Number(newPermCount.rows[0].count)).toBe(32);

    const permAfter = await pool.query<{
      gibbon_is_allocated: boolean;
      metadata: { name?: string };
    }>(
      `SELECT gibbon_is_allocated, metadata FROM ${permTable}
       WHERE gibbon_permission_position = $1`,
      [perm.gibbonPermissionPosition]
    );
    expect(permAfter.rows[0].gibbon_is_allocated).toBe(true);
    expect(permAfter.rows[0].metadata.name).toBe('perm1');

    const groupAfter = await pool.query<{ permissions_gibbon: Buffer }>(
      `SELECT permissions_gibbon FROM ${groupTable}
       WHERE gibbon_group_position = $1`,
      [group.gibbonGroupPosition]
    );
    const groupBuf = groupAfter.rows[0].permissions_gibbon;
    expect(groupBuf.length).toBe(4);
    expect(
      Gibbon.decode(groupBuf).hasAllFromPositions([perm.gibbonPermissionPosition])
    ).toBe(true);

    const userAfter = await pool.query<{ permissions_gibbon: Buffer }>(
      `SELECT permissions_gibbon FROM ${userTable} WHERE id = $1::uuid`,
      [user.id]
    );
    const userBuf = userAfter.rows[0].permissions_gibbon;
    expect(userBuf.length).toBe(4);
    expect(
      Gibbon.decode(userBuf).hasAllFromPositions([perm.gibbonPermissionPosition])
    ).toBe(true);

    expect(config.permissionByteLength).toBe(4);

    const newPerm = await adapter.allocatePermission({ name: 'newPerm' });
    expect(newPerm.gibbonPermissionPosition).toBeGreaterThan(0);
  });

  it('expandPermissions — throws when newByteLength <= current', async () => {
    await expect(adapter.expandPermissions(2)).rejects.toThrow(
      'must be greater than'
    );
    await expect(adapter.expandPermissions(1)).rejects.toThrow(
      'must be greater than'
    );
  });

  // ---------- expandGroups ----------

  it('expandGroups — seeds new group slots and pads user groups_gibbon', async () => {
    const group = await adapter.allocateGroup({ name: 'group1' });
    const user = await adapter.createUser({
      name: 'Bob',
      email: 'bob@test.com',
    });
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    const oldGroupCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(oldGroupCount.rows[0].count)).toBe(16);

    await adapter.expandGroups(4);

    const newGroupCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(newGroupCount.rows[0].count)).toBe(32);

    const userAfter = await pool.query<{ groups_gibbon: Buffer }>(
      `SELECT groups_gibbon FROM ${userTable} WHERE id = $1::uuid`,
      [user.id]
    );
    const userBuf = userAfter.rows[0].groups_gibbon;
    expect(userBuf.length).toBe(4);
    expect(
      Gibbon.decode(userBuf).hasAllFromPositions([group.gibbonGroupPosition])
    ).toBe(true);

    expect(config.groupByteLength).toBe(4);
  });

  it('expandGroups — throws when newByteLength <= current', async () => {
    await expect(adapter.expandGroups(2)).rejects.toThrow(
      'must be greater than'
    );
  });

  // ---------- shrinkPermissions ----------

  it('shrinkPermissions — removes trailing slots and truncates BYTEAs', async () => {
    const perm = await adapter.allocatePermission({
      name: 'lowPerm',
    });
    expect(perm.gibbonPermissionPosition).toBeLessThanOrEqual(16);

    const group = await adapter.allocateGroup({ name: 'g1' });
    await adapter.subscribePermissionsToGroups(
      [group.gibbonGroupPosition],
      [perm.gibbonPermissionPosition]
    );
    const user = await adapter.createUser({
      name: 'Carol',
      email: 'carol@test.com',
    });
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    await adapter.expandPermissions(4);
    await adapter.shrinkPermissions(2);

    const permCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permTable}`
    );
    expect(Number(permCount.rows[0].count)).toBe(16);

    const groupAfter = await pool.query<{ permissions_gibbon: Buffer }>(
      `SELECT permissions_gibbon FROM ${groupTable}
       WHERE gibbon_group_position = $1`,
      [group.gibbonGroupPosition]
    );
    expect(groupAfter.rows[0].permissions_gibbon.length).toBe(2);
    expect(
      Gibbon.decode(
        groupAfter.rows[0].permissions_gibbon
      ).hasAllFromPositions([perm.gibbonPermissionPosition])
    ).toBe(true);

    const userAfter = await pool.query<{ permissions_gibbon: Buffer }>(
      `SELECT permissions_gibbon FROM ${userTable} WHERE id = $1::uuid`,
      [user.id]
    );
    expect(userAfter.rows[0].permissions_gibbon.length).toBe(2);
    expect(
      Gibbon.decode(
        userAfter.rows[0].permissions_gibbon
      ).hasAllFromPositions([perm.gibbonPermissionPosition])
    ).toBe(true);

    expect(config.permissionByteLength).toBe(2);
  });

  it('shrinkPermissions — throws when allocated permissions exist beyond boundary', async () => {
    for (let i = 0; i < 16; i++) {
      await adapter.allocatePermission({ name: `p${i}` });
    }
    await expect(adapter.shrinkPermissions(1)).rejects.toThrow(
      'Cannot shrink: allocated permissions exist beyond the new boundary'
    );
  });

  it('shrinkPermissions — throws when newByteLength >= current', async () => {
    await expect(adapter.shrinkPermissions(2)).rejects.toThrow(
      'must be less than'
    );
    await expect(adapter.shrinkPermissions(3)).rejects.toThrow(
      'must be less than'
    );
  });

  // ---------- shrinkGroups ----------

  it('shrinkGroups — removes trailing slots and truncates user groups_gibbon', async () => {
    const group = await adapter.allocateGroup({ name: 'g1' });
    expect(group.gibbonGroupPosition).toBeLessThanOrEqual(16);

    const user = await adapter.createUser({
      name: 'Dave',
      email: 'dave@test.com',
    });
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    await adapter.expandGroups(4);
    await adapter.shrinkGroups(2);

    const groupCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(groupCount.rows[0].count)).toBe(16);

    const userAfter = await pool.query<{ groups_gibbon: Buffer }>(
      `SELECT groups_gibbon FROM ${userTable} WHERE id = $1::uuid`,
      [user.id]
    );
    expect(userAfter.rows[0].groups_gibbon.length).toBe(2);
    expect(
      Gibbon.decode(userAfter.rows[0].groups_gibbon).hasAllFromPositions([
        group.gibbonGroupPosition,
      ])
    ).toBe(true);

    expect(config.groupByteLength).toBe(2);
  });

  it('shrinkGroups — throws when allocated groups exist beyond boundary', async () => {
    for (let i = 0; i < 16; i++) {
      await adapter.allocateGroup({ name: `g${i}` });
    }
    await expect(adapter.shrinkGroups(1)).rejects.toThrow(
      'Cannot shrink: allocated groups exist beyond the new boundary'
    );
  });

  it('shrinkGroups — throws when newByteLength >= current', async () => {
    await expect(adapter.shrinkGroups(2)).rejects.toThrow('must be less than');
  });

  // ---------- External transaction ----------

  it('expand + shrink within an external transaction', async () => {
    const perm = await adapter.allocatePermission({ name: 'txPerm' });
    const group = await adapter.allocateGroup({ name: 'txGroup' });
    await adapter.subscribePermissionsToGroups(
      [group.gibbonGroupPosition],
      [perm.gibbonPermissionPosition]
    );
    const user = await adapter.createUser({
      name: 'Eve',
      email: 'eve@test.com',
    } as TestUser);
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    await withTransaction(pool, async (client) => {
      await adapter.expandPermissions(4, client);
      await adapter.expandGroups(4, client);
    });

    expect(config.permissionByteLength).toBe(4);
    expect(config.groupByteLength).toBe(4);

    const permCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permTable}`
    );
    expect(Number(permCount.rows[0].count)).toBe(32);
    const groupCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(groupCount.rows[0].count)).toBe(32);

    const userAfter = await pool.query<{
      permissions_gibbon: Buffer;
      groups_gibbon: Buffer;
    }>(
      `SELECT permissions_gibbon, groups_gibbon FROM ${userTable}
       WHERE id = $1::uuid`,
      [user.id]
    );
    expect(userAfter.rows[0].permissions_gibbon.length).toBe(4);
    expect(userAfter.rows[0].groups_gibbon.length).toBe(4);
    expect(
      Gibbon.decode(
        userAfter.rows[0].permissions_gibbon
      ).hasAllFromPositions([perm.gibbonPermissionPosition])
    ).toBe(true);
    expect(
      Gibbon.decode(userAfter.rows[0].groups_gibbon).hasAllFromPositions([
        group.gibbonGroupPosition,
      ])
    ).toBe(true);

    await withTransaction(pool, async (client) => {
      await adapter.shrinkPermissions(2, client);
      await adapter.shrinkGroups(2, client);
    });

    expect(config.permissionByteLength).toBe(2);
    expect(config.groupByteLength).toBe(2);

    const permCountAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permTable}`
    );
    expect(Number(permCountAfter.rows[0].count)).toBe(16);
    const groupCountAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(groupCountAfter.rows[0].count)).toBe(16);
  });
});
