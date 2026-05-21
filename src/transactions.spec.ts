import {
  beforeAll,
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';
import { Gibbon } from '@icazemier/gibbons';
import { Pool } from 'pg';
import {
  PERMISSION_POSITIONS_FIXTURES,
  GROUP_POSITION_FIXTURES,
} from '../test/helper/fixtures.js';
import {
  TestUser,
  TestGroup,
  TestPermission,
} from '../test/interfaces/test-interfaces.js';
import {
  seedTestFixtures,
  seedUserTestFixtures,
  tearDownGroupTestFixtures,
  tearDownPermissionTestFixtures,
  tearDownUserTestFixtures,
} from '../test/helper/seeders.js';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import { GibbonsPostgreSql } from './gibbons-postgresql.js';
import { PostgreSqlSeeder } from './seeder.js';
import { ConfigLoader } from './config.js';
import { Config } from './interfaces/index.js';
import { withTransaction } from './utils.js';
import { quoteIdent } from './sql.js';

describe('External session / transaction support', () => {
  let adapter: GibbonsPostgreSql;
  let seedPool: Pool;
  let adapterPool: Pool;
  let config: Config;
  let userTable: string;
  let groupTable: string;
  let permissionTable: string;

  beforeAll(async () => {
    seedPool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    adapterPool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    config = await ConfigLoader.load('gibbons-postgresql-sample');

    userTable = quoteIdent(config.dbStructure.user.tableName);
    groupTable = quoteIdent(config.dbStructure.group.tableName);
    permissionTable = quoteIdent(config.dbStructure.permission.tableName);

    adapter = new GibbonsPostgreSql(adapterPool, config);
    await adapter.initialize();

    const seeder = new PostgreSqlSeeder(seedPool, config);
    await seeder.initialize();
    await seedTestFixtures(seedPool, config);
  });

  beforeEach(async () => {
    await seedUserTestFixtures(seedPool, config);
  });

  afterEach(async () => {
    await tearDownUserTestFixtures(seedPool, config);
  });

  afterAll(async () => {
    await tearDownGroupTestFixtures(seedPool, config);
    await tearDownPermissionTestFixtures(seedPool, config);
    await seedPool.end();
    await adapterPool.end();
  });

  it('getPool returns the injected pool', () => {
    expect(adapter.getPool()).toBe(adapterPool);
  });

  it('constructor with URI creates a separate internal pool', async () => {
    const uriAdapter = new GibbonsPostgreSql(PostgreSqlTestServer.uri, config);
    await uriAdapter.initialize();
    const internalPool = uriAdapter.getPool();
    expect(internalPool).not.toBe(adapterPool);
    expect(internalPool).toBeInstanceOf(Pool);
    await internalPool.end();
  });

  it('allocatePermission with external client commits atomically', async () => {
    const permission = await withTransaction(adapterPool, async (client) => {
      return adapter.allocatePermission<TestPermission>(
        { name: 'Tx Permission' } as TestPermission,
        client
      );
    });

    expect(permission.gibbonIsAllocated).toBe(true);
    expect((permission as unknown as TestPermission).name).toBe(
      'Tx Permission'
    );

    const { rows } = await adapterPool.query<{
      gibbon_is_allocated: boolean;
    }>(
      `SELECT gibbon_is_allocated FROM ${permissionTable}
       WHERE gibbon_permission_position = $1`,
      [permission.gibbonPermissionPosition]
    );
    expect(rows[0].gibbon_is_allocated).toBe(true);
  });

  it('allocateGroup with external client commits atomically', async () => {
    const group = await withTransaction(adapterPool, async (client) => {
      return adapter.allocateGroup<TestGroup>(
        { name: 'Tx Group' } as TestGroup,
        client
      );
    });
    expect(group.gibbonIsAllocated).toBe(true);
    expect((group as unknown as TestGroup).name).toBe('Tx Group');
  });

  it('createUser with external client commits atomically', async () => {
    const user = await withTransaction(adapterPool, async (client) => {
      return adapter.createUser(
        { name: 'Tx User', email: 'tx@user.com' },
        client
      );
    });
    expect((user as unknown as TestUser).name).toBe('Tx User');
    expect(user.groupsGibbon).toBeInstanceOf(Gibbon);
    expect(user.permissionsGibbon).toBeInstanceOf(Gibbon);

    const { rows } = await adapterPool.query<{ id: string }>(
      `SELECT id FROM ${userTable} WHERE metadata->>'email' = $1`,
      ['tx@user.com']
    );
    expect(rows.length).toBe(1);
  });

  it('multiple operations in a single external transaction commit together', async () => {
    await withTransaction(adapterPool, async (client) => {
      await adapter.createUser(
        { name: 'Multi-Op User', email: 'multi@op.com' },
        client
      );
      await adapter.subscribeUsersToGroups(
        { metadata: { email: 'multi@op.com' } },
        [GROUP_POSITION_FIXTURES.GI_JOE],
        client
      );
    });

    const users = (await adapter
      .findUsers({ metadata: { email: 'multi@op.com' } })
      .toArray()) as TestUser[];
    expect(users.length).toBe(1);
    const [user] = users;
    const groupPositions = (user.groupsGibbon as Gibbon).getPositionsArray();
    expect(groupPositions).toContain(GROUP_POSITION_FIXTURES.GI_JOE);
    const permissionPositions = (
      user.permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(permissionPositions).toContain(
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE
    );
  });

  it('external transaction rollback leaves no changes', async () => {
    const { rows: beforeRows } = await adapterPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${userTable}`
    );
    const userCountBefore = Number(beforeRows[0].count);

    try {
      await withTransaction(adapterPool, async (client) => {
        await adapter.createUser(
          { name: 'Rollback User', email: 'rollback@test.com' },
          client
        );

        const { rows: midRows } = await client.query<{ id: string }>(
          `SELECT id FROM ${userTable} WHERE metadata->>'email' = $1`,
          ['rollback@test.com']
        );
        expect(midRows.length).toBe(1);

        throw new Error('Intentional abort');
      });
    } catch (error) {
      expect((error as Error).message).toBe('Intentional abort');
    }

    const { rows: afterRows } = await adapterPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${userTable}`
    );
    expect(Number(afterRows[0].count)).toBe(userCountBefore);

    const { rows: rollbackRows } = await adapterPool.query<{ id: string }>(
      `SELECT id FROM ${userTable} WHERE metadata->>'email' = $1`,
      ['rollback@test.com']
    );
    expect(rollbackRows.length).toBe(0);
  });

  it('subscribePermissionsToGroups with external client', async () => {
    await withTransaction(adapterPool, async (client) => {
      await adapter.subscribePermissionsToGroups(
        [GROUP_POSITION_FIXTURES.A_TEAM],
        [PERMISSION_POSITIONS_FIXTURES.ADMIN],
        client
      );
    });

    const groupRows = await adapterPool.query<{
      permissions_gibbon: Buffer;
    }>(
      `SELECT permissions_gibbon FROM ${groupTable}
       WHERE gibbon_group_position = $1`,
      [GROUP_POSITION_FIXTURES.A_TEAM]
    );
    const positions = Gibbon.decode(
      groupRows.rows[0].permissions_gibbon
    ).getPositionsArray();
    expect(positions).toContain(PERMISSION_POSITIONS_FIXTURES.ADMIN);
    expect(positions).toContain(PERMISSION_POSITIONS_FIXTURES.USER);
    expect(positions).toContain(PERMISSION_POSITIONS_FIXTURES.BACK_DOOR);
  });

  it('unsubscribeUsersFromGroups with external client', async () => {
    await adapter.subscribeUsersToGroups(
      { metadata: { name: { ilike: '%Cooper%' } } },
      [GROUP_POSITION_FIXTURES.TRANSFORMERS]
    );

    await withTransaction(adapterPool, async (client) => {
      await adapter.unsubscribeUsersFromGroups(
        { metadata: { name: { ilike: '%Cooper%' } } },
        [GROUP_POSITION_FIXTURES.TRANSFORMERS],
        client
      );
    });

    const users = (await adapter
      .findUsers({ metadata: { name: 'Cooper' } })
      .toArray()) as TestUser[];
    const groupsAfter = (users[0].groupsGibbon as Gibbon).getPositionsArray();
    expect(groupsAfter).not.toContain(GROUP_POSITION_FIXTURES.TRANSFORMERS);
    expect(groupsAfter).toContain(GROUP_POSITION_FIXTURES.PLANETEERS);
  });

  it('unsubscribePermissionsFromGroups with external client', async () => {
    await withTransaction(adapterPool, async (client) => {
      await adapter.unsubscribePermissionsFromGroups(
        [GROUP_POSITION_FIXTURES.PLANETEERS],
        [PERMISSION_POSITIONS_FIXTURES.THE_EDGE],
        client
      );
    });

    const groupRows = await adapterPool.query<{
      permissions_gibbon: Buffer;
    }>(
      `SELECT permissions_gibbon FROM ${groupTable}
       WHERE gibbon_group_position = $1`,
      [GROUP_POSITION_FIXTURES.PLANETEERS]
    );
    const groupPositions = Gibbon.decode(
      groupRows.rows[0].permissions_gibbon
    ).getPositionsArray();
    expect(groupPositions).not.toContain(
      PERMISSION_POSITIONS_FIXTURES.THE_EDGE
    );
    expect(groupPositions).toContain(PERMISSION_POSITIONS_FIXTURES.USER);

    const users = (await adapter
      .findUsers({ metadata: { name: 'Cooper' } })
      .toArray()) as TestUser[];
    const userPositions = (
      users[0].permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(userPositions).not.toContain(PERMISSION_POSITIONS_FIXTURES.THE_EDGE);
  });

  it('removeUser with external client', async () => {
    await adapter.createUser({
      name: 'To Remove',
      email: 'remove-tx@test.com',
    });
    const removed = await withTransaction(adapterPool, async (client) => {
      return adapter.removeUser(
        { metadata: { email: 'remove-tx@test.com' } },
        client
      );
    });
    expect(removed).toBe(1);
    const { rows } = await adapterPool.query<{ id: string }>(
      `SELECT id FROM ${userTable} WHERE metadata->>'email' = $1`,
      ['remove-tx@test.com']
    );
    expect(rows.length).toBe(0);
  });

  it('updateGroupMetadata with external client', async () => {
    const updated = await withTransaction(adapterPool, async (client) => {
      return adapter.updateGroupMetadata(
        GROUP_POSITION_FIXTURES.GI_JOE,
        { name: 'GI Joe Tx' },
        client
      );
    });
    expect(updated).not.toBeNull();
    expect((updated as unknown as TestGroup).name).toBe('GI Joe Tx');

    await adapter.updateGroupMetadata(GROUP_POSITION_FIXTURES.GI_JOE, {
      name: 'GI Joe',
    });
  });

  it('updatePermissionMetadata with external client', async () => {
    const updated = await withTransaction(adapterPool, async (client) => {
      return adapter.updatePermissionMetadata(
        PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
        { name: 'God Mode Tx' },
        client
      );
    });
    expect(updated).not.toBeNull();
    expect((updated as unknown as TestPermission).name).toBe('God Mode Tx');

    await adapter.updatePermissionMetadata(
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
      { name: 'God mode' }
    );
  });

  it('updateUserMetadata with external client', async () => {
    const updated = await withTransaction(adapterPool, async (client) => {
      return adapter.updateUserMetadata(
        { metadata: { name: 'Cooper' } },
        { email: 'cooper-tx@test.com' },
        client
      );
    });
    expect(updated).not.toBeNull();
    expect((updated as unknown as TestUser).email).toBe('cooper-tx@test.com');
  });

  it('deallocatePermissions with external client', async () => {
    const perm = await adapter.allocatePermission<TestPermission>({
      name: 'To Deallocate',
    } as TestPermission);
    const pos = perm.gibbonPermissionPosition;
    await withTransaction(adapterPool, async (client) => {
      await adapter.deallocatePermissions([pos], client);
    });
    const { rows } = await adapterPool.query<{
      gibbon_is_allocated: boolean;
    }>(
      `SELECT gibbon_is_allocated FROM ${permissionTable}
       WHERE gibbon_permission_position = $1`,
      [pos]
    );
    expect(rows[0].gibbon_is_allocated).toBe(false);
  });

  it('deallocateGroups with external client', async () => {
    const group = await adapter.allocateGroup<TestGroup>({
      name: 'To Deallocate',
    } as TestGroup);
    const pos = group.gibbonGroupPosition;
    await withTransaction(adapterPool, async (client) => {
      await adapter.deallocateGroups([pos], client);
    });
    const { rows } = await adapterPool.query<{
      gibbon_is_allocated: boolean;
    }>(
      `SELECT gibbon_is_allocated FROM ${groupTable}
       WHERE gibbon_group_position = $1`,
      [pos]
    );
    expect(rows[0].gibbon_is_allocated).toBe(false);
  });
});
