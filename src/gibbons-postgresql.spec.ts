import { Buffer } from 'node:buffer';
import { pipeline, PassThrough } from 'node:stream';
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
import { writableNoopStream } from 'noop-stream';
import {
  usersFixtures,
  groupsFixtures,
  permissionsFixtures,
  PERMISSION_POSITIONS_FIXTURES,
  GROUP_POSITION_FIXTURES,
} from '../test/helper/fixtures.js';
import {
  TestUser,
  TestPermission,
  TestGroup,
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
import { quoteIdent } from './sql.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Happy flows', () => {
  let adapter: GibbonsPostgreSql;
  let pool: Pool;
  let config: Config;
  let userTable: string;
  let permissionTable: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    config = await ConfigLoader.load('gibbons-postgresql-sample');

    userTable = quoteIdent(config.dbStructure.user.tableName);
    permissionTable = quoteIdent(config.dbStructure.permission.tableName);

    adapter = new GibbonsPostgreSql(PostgreSqlTestServer.uri, config);
    await adapter.initialize();

    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize();

    await seedTestFixtures(pool, config);
  });

  beforeEach(async () => {
    await seedUserTestFixtures(pool, config);
  });

  afterEach(async () => {
    await tearDownUserTestFixtures(pool, config);
  });

  afterAll(async () => {
    await tearDownGroupTestFixtures(pool, config);
    await tearDownPermissionTestFixtures(pool, config);
    await pool.end();
    await adapter.getPool().end();
  });

  const findUserByName = async (name: string): Promise<TestUser | null> => {
    const users = (await adapter
      .findUsers({ metadata: { name } })
      .toArray()) as TestUser[];
    return users[0] ?? null;
  };

  const findUserByEmail = async (email: string): Promise<TestUser | null> => {
    const users = (await adapter
      .findUsers({ metadata: { email } })
      .toArray()) as TestUser[];
    return users[0] ?? null;
  };

  it('Find users by a group name with positions', async () => {
    const groupPositions = groupsFixtures
      .filter((g) => g.name === groupsFixtures[0].name)
      .map((g) => g.gibbonGroupPosition);

    const users = (await adapter
      .findUsersByGroups(groupPositions)
      .toArray()) as TestUser[];

    expect(users).toBeInstanceOf(Array);
    expect(users).toHaveLength(1);
    const [user] = users;
    expect(UUID_RE.test(user.id)).toBe(true);
    expect(user.name).toBe(usersFixtures[2].name);
    expect(user.email).toBe(usersFixtures[2].email);
    expect(
      Buffer.compare(
        (user.groupsGibbon as Gibbon).toBuffer(),
        usersFixtures[2].groupsGibbon
      )
    ).toBe(0);
  });

  it('Find users by a group name with Gibbon', async () => {
    const groupsGibbon = Gibbon.create(2).setAllFromPositions([
      groupsFixtures[0].gibbonGroupPosition,
    ]);
    const users = (await adapter
      .findUsersByGroups(groupsGibbon)
      .toArray()) as TestUser[];

    expect(users).toHaveLength(1);
    const [user] = users;
    expect(UUID_RE.test(user.id)).toBe(true);
    expect(user.name).toBe(usersFixtures[2].name);
    expect(user.email).toBe(usersFixtures[2].email);
  });

  it('Find users by permission name with positions', async () => {
    const permissionPositions = permissionsFixtures
      .filter((p) => p.name === permissionsFixtures[0].name)
      .map((p) => p.gibbonPermissionPosition);

    const users = (await adapter
      .findUsersByPermissions(permissionPositions)
      .toArray()) as TestUser[];

    expect(users).toHaveLength(1);
    const [user] = users;
    expect(UUID_RE.test(user.id)).toBe(true);
    expect(user.name).toBe(usersFixtures[2].name);
    expect(user.email).toBe(usersFixtures[2].email);
  });

  it('Find users by group positions using Node.js streams', async () => {
    const groupPositions = [groupsFixtures[2].gibbonGroupPosition];

    const readable = adapter.findUsersByGroups(groupPositions).stream();
    let assertions = 0;

    await new Promise<void>((resolve, reject) => {
      const through = new PassThrough({ objectMode: true });
      through.on('data', (user: TestUser) => {
        assertions++;
        expect(
          ['info@arnieslife.com', 'captain@planet.nl'].includes(user.email)
        ).toBe(true);
      });
      pipeline(
        readable,
        through,
        writableNoopStream({ objectMode: true }),
        (error) => (error ? reject(error) : resolve())
      );
    });

    expect(assertions).toBe(2);
  });

  it('Find users by groups gibbon using Node.js streams', async () => {
    const groupsGibbon = Gibbon.create(128).setAllFromPositions([
      groupsFixtures[2].gibbonGroupPosition,
    ]);
    const readable = adapter.findUsersByGroups(groupsGibbon).stream();
    let assertions = 0;

    await new Promise<void>((resolve, reject) => {
      const through = new PassThrough({ objectMode: true });
      through.on('data', (user: TestUser) => {
        assertions++;
        expect(
          ['info@arnieslife.com', 'captain@planet.nl'].includes(user.email)
        ).toBe(true);
      });
      pipeline(
        readable,
        through,
        writableNoopStream({ objectMode: true }),
        (error) => (error ? reject(error) : resolve())
      );
    });

    expect(assertions).toBe(2);
  });

  it('Find groups by permissions', async () => {
    const permissionPositions = permissionsFixtures
      .filter((p) => p.name === permissionsFixtures[0].name)
      .map((p) => p.gibbonPermissionPosition);

    const groups = (await adapter
      .findGroupsByPermissions(permissionPositions)
      .toArray()) as TestGroup[];

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.name).toBe(groupsFixtures[0].name);
    expect(
      Buffer.compare(
        (group.permissionsGibbon as Gibbon).toBuffer(),
        groupsFixtures[0].permissionsGibbon
      )
    ).toBe(0);
    expect(group.gibbonGroupPosition).toBe(
      groupsFixtures[0].gibbonGroupPosition
    );
    expect(group.gibbonIsAllocated).toBe(groupsFixtures[0].gibbonIsAllocated);
  });

  it('Allocate a permission, check before and after', async () => {
    const expectedPosition = PERMISSION_POSITIONS_FIXTURES.GOD_MODE + 1;

    const before = await pool.query<{
      gibbon_is_allocated: boolean;
      metadata: { name?: string };
    }>(
      `SELECT gibbon_is_allocated, metadata FROM ${permissionTable}
       WHERE gibbon_permission_position = $1`,
      [expectedPosition]
    );
    expect(before.rows[0].gibbon_is_allocated).toBe(false);
    expect(before.rows[0].metadata.name).toBeUndefined();

    const permission = (await adapter.allocatePermission<TestPermission>({
      name: 'Able to create a shopping basket',
    } as TestPermission)) as TestPermission;

    expect(permission.name).toBe('Able to create a shopping basket');
    expect(permission.gibbonIsAllocated).toBe(true);
    expect(permission.gibbonPermissionPosition).toBe(expectedPosition);
  });

  it('Allocate some permissions on groups, then deallocate them and check groups for permissions', async () => {
    const { gibbonPermissionPosition: position1 } =
      await adapter.allocatePermission({ name: 'permission 1' });
    const { gibbonPermissionPosition: position2 } =
      await adapter.allocatePermission({ name: 'permission 2' });
    const { gibbonPermissionPosition: position3 } =
      await adapter.allocatePermission({ name: 'permission 3' });
    const permissionPositions = [position1, position2, position3];

    await adapter.subscribePermissionsToGroups(
      [GROUP_POSITION_FIXTURES.GI_JOE],
      permissionPositions
    );

    const usersBefore = [
      {
        email: 'test1@test.com',
        name: 'Test 1',
      },
      {
        email: 'test2@test.com',
        name: 'Test 2',
      },
    ];
    for (const u of usersBefore) {
      await adapter.createUser(u);
      await adapter.subscribeUsersToGroups({ metadata: { email: u.email } }, [
        GROUP_POSITION_FIXTURES.GI_JOE,
      ]);
    }

    await adapter.deallocatePermissions(permissionPositions);

    const permissions = await pool.query<{
      gibbon_is_allocated: boolean;
      metadata: { name?: string };
    }>(
      `SELECT gibbon_is_allocated, metadata FROM ${permissionTable}
       WHERE gibbon_permission_position = ANY($1::int[])`,
      [permissionPositions]
    );
    expect(permissions.rows).toHaveLength(permissionPositions.length);
    permissions.rows.forEach((p) => {
      expect(p.gibbon_is_allocated).toBe(false);
      expect(p.metadata.name).toBeUndefined();
    });

    const [groupAfter] = (await adapter
      .findGroups([GROUP_POSITION_FIXTURES.GI_JOE])
      .toArray()) as TestGroup[];
    const positionsAfter = (
      groupAfter.permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(positionsAfter).toEqual([PERMISSION_POSITIONS_FIXTURES.GOD_MODE]);

    const usersAfter = (await adapter
      .findUsers({ metadata: { email: { ilike: '%@test.com' } } })
      .toArray()) as TestUser[];
    expect(usersAfter).toHaveLength(2);
    usersAfter.forEach((user) => {
      const permPositions = (
        user.permissionsGibbon as Gibbon
      ).getPositionsArray();
      const groupPositions = (user.groupsGibbon as Gibbon).getPositionsArray();
      expect(permissionPositions.some((p) => permPositions.includes(p))).toBe(
        false
      );
      expect(groupPositions).toContain(GROUP_POSITION_FIXTURES.GI_JOE);
    });
  });

  it('Allocate some groups on user, then deallocate them and check users for groups', async () => {
    const { gibbonGroupPosition: position1 } = await adapter.allocateGroup({
      name: 'My allocated test group 1 (should be position 3)',
    });
    const { gibbonGroupPosition: position2 } = await adapter.allocateGroup({
      name: 'My allocated test group 2 (should be position 4)',
    });

    expect(position1).toBe(3);
    expect(position2).toBe(4);

    const userBefore = await findUserByEmail('captain@planet.nl');
    expect(userBefore).not.toBeNull();
    if (!userBefore) return;

    const groupsBefore = (
      userBefore.groupsGibbon as Gibbon
    ).hasAnyFromPositions([position1, position2]);
    expect(groupsBefore).toBe(false);

    const merged = (userBefore.groupsGibbon as Gibbon).setAllFromPositions([
      position1,
      position2,
    ]);
    await pool.query(
      `UPDATE ${userTable} SET groups_gibbon = $1 WHERE id = $2::uuid`,
      [merged.toBuffer(), userBefore.id]
    );

    await adapter.deallocateGroups([position1, position2]);

    const userAfter = await findUserByEmail('captain@planet.nl');
    expect(userAfter).not.toBeNull();
    if (!userAfter) return;
    const hasGroupsAfter = (
      userAfter.groupsGibbon as Gibbon
    ).hasAnyFromPositions([position1, position2]);
    expect(hasGroupsAfter).toBe(false);
  });

  it('Find Groups By User', async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;

    const groupsFromDB = (await adapter
      .findGroups(user.groupsGibbon as Gibbon)
      .toArray()) as TestGroup[];
    expect(groupsFromDB).toHaveLength(1);

    const [groupFromDB] = groupsFromDB;
    const groupFromFixture = groupsFixtures[2];

    expect(
      Gibbon.fromBuffer(groupFromFixture.permissionsGibbon).equals(
        groupFromDB.permissionsGibbon as Gibbon
      )
    ).toBe(true);
    expect(groupFromDB.gibbonGroupPosition).toBe(
      groupFromFixture.gibbonGroupPosition
    );
    expect(groupFromDB.gibbonIsAllocated).toBe(true);
  });

  it('Validate a user on all mandatory permissions', async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAllPermissions(
      user.permissionsGibbon as Gibbon,
      [
        PERMISSION_POSITIONS_FIXTURES.USER,
        PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
      ]
    );
    expect(valid).toBe(true);
  });

  it(`Validate a user on all mandatory permissions, where Arnold hasn't got them all`, async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAllPermissions(
      user.permissionsGibbon as Gibbon,
      [
        PERMISSION_POSITIONS_FIXTURES.USER,
        PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
        PERMISSION_POSITIONS_FIXTURES.ADMIN,
      ]
    );
    expect(valid).toBe(false);
  });

  it(`Validate a user on all mandatory permissions, but user hasn't got any group membership`, async () => {
    const user = await findUserByEmail('john@doe.born');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAllPermissions(
      user.permissionsGibbon as Gibbon,
      [
        PERMISSION_POSITIONS_FIXTURES.USER,
        PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
      ]
    );
    expect(valid).toBe(false);
  });

  it('Validate a user on any permissions', async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAnyPermissions(
      user.permissionsGibbon as Gibbon,
      [PERMISSION_POSITIONS_FIXTURES.USER]
    );
    expect(valid).toBe(true);
  });

  it('Validate a user on any permissions and some', async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAnyPermissions(
      user.permissionsGibbon as Gibbon,
      [PERMISSION_POSITIONS_FIXTURES.USER, PERMISSION_POSITIONS_FIXTURES.ADMIN]
    );
    expect(valid).toBe(true);
  });

  it(`Validate a user on any permissions, but user hasn't got any group membership`, async () => {
    const user = await findUserByEmail('john@doe.born');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAnyPermissions(
      user.permissionsGibbon as Gibbon,
      [
        PERMISSION_POSITIONS_FIXTURES.USER,
        PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
      ]
    );
    expect(valid).toBe(false);
  });

  it(`Validate a user on any permissions, but this user hasn't even got this one set`, async () => {
    const user = await findUserByName('Arnold Schwarzenegger');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserPermissionsForAnyPermissions(
      user.permissionsGibbon as Gibbon,
      [PERMISSION_POSITIONS_FIXTURES.ADMIN]
    );
    expect(valid).toBe(false);
  });

  it('Validate a user on all mandatory groups', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserGroupsForAllGroups(
      user.groupsGibbon as Gibbon,
      [GROUP_POSITION_FIXTURES.GI_JOE, GROUP_POSITION_FIXTURES.A_TEAM]
    );
    expect(valid).toBe(true);
  });

  it('Validate a user on any group(s)', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserGroupsForAnyGroups(
      user.groupsGibbon as Gibbon,
      [GROUP_POSITION_FIXTURES.GI_JOE]
    );
    expect(valid).toBe(true);
  });

  it('Validate a user on another group (any)', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserGroupsForAnyGroups(
      user.groupsGibbon as Gibbon,
      [GROUP_POSITION_FIXTURES.A_TEAM]
    );
    expect(valid).toBe(true);
  });

  it('Validate a user on any group, but is not member of this groups', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserGroupsForAnyGroups(
      user.groupsGibbon as Gibbon,
      [GROUP_POSITION_FIXTURES.PLANETEERS]
    );
    expect(valid).toBe(false);
  });

  it('Validate a user on any group, but should not be member of no groups', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const valid = adapter.validateUserGroupsForAnyGroups(
      user.groupsGibbon as Gibbon,
      []
    );
    expect(valid).toBe(false);
  });

  it('Fetch aggregated permissions for user', async () => {
    const user = await findUserByName('Captain Planet');
    expect(user).not.toBeNull();
    if (!user) return;
    const gibbon = await adapter.getPermissionsGibbonForGroups(
      user.groupsGibbon as Gibbon
    );
    expect(gibbon.getPositionsArray()).toEqual([
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
      PERMISSION_POSITIONS_FIXTURES.USER,
      PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
    ]);
  });

  it('Validate some groups, which should be allocated in our database', async () => {
    const groupsGibbon = Gibbon.create(1024).setAllFromPositions([
      GROUP_POSITION_FIXTURES.GI_JOE,
    ]);
    expect(await adapter.validateAllocatedGroups(groupsGibbon)).toBe(true);
  });

  it('Validate some permissions, which should be allocated in our database', async () => {
    const permissionsGibbon = Gibbon.create(1024).setAllFromPositions([
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
      PERMISSION_POSITIONS_FIXTURES.THE_EDGE,
    ]);
    expect(await adapter.validateAllocatedPermissions(permissionsGibbon)).toBe(
      true
    );
  });

  it('Subscribe a user to an allocated Group', async () => {
    const userBefore = await findUserByName('Cooper');
    expect(userBefore).not.toBeNull();
    if (!userBefore) return;
    expect((userBefore.groupsGibbon as Gibbon).getPositionsArray()).toEqual([
      GROUP_POSITION_FIXTURES.PLANETEERS,
    ]);
    expect(
      (userBefore.permissionsGibbon as Gibbon).getPositionsArray()
    ).toEqual([
      PERMISSION_POSITIONS_FIXTURES.USER,
      PERMISSION_POSITIONS_FIXTURES.THE_EDGE,
    ]);

    await adapter.subscribeUsersToGroups(
      { metadata: { name: { ilike: '%Cooper%' } } },
      [GROUP_POSITION_FIXTURES.TRANSFORMERS]
    );

    const userAfter = await findUserByName('Cooper');
    expect(userAfter).not.toBeNull();
    if (!userAfter) return;
    const groupsAfter = (userAfter.groupsGibbon as Gibbon).getPositionsArray();
    const permsAfter = (
      userAfter.permissionsGibbon as Gibbon
    ).getPositionsArray();

    expect(groupsAfter.sort()).toEqual(
      [
        GROUP_POSITION_FIXTURES.PLANETEERS,
        GROUP_POSITION_FIXTURES.TRANSFORMERS,
      ].sort()
    );
    expect(permsAfter.sort()).toEqual(
      [
        PERMISSION_POSITIONS_FIXTURES.USER,
        PERMISSION_POSITIONS_FIXTURES.THE_EDGE,
        PERMISSION_POSITIONS_FIXTURES.ADMIN,
      ].sort()
    );
  });

  it('Subscribe Permissions To Groups', async () => {
    const userBefore = await findUserByName('Cooper');
    expect(userBefore).not.toBeNull();
    if (!userBefore) return;

    await adapter.subscribePermissionsToGroups(
      [GROUP_POSITION_FIXTURES.PLANETEERS],
      [PERMISSION_POSITIONS_FIXTURES.BACK_DOOR]
    );

    const userAfter = await findUserByName('Cooper');
    expect(userAfter).not.toBeNull();
    if (!userAfter) return;
    const groupsAfter = (userAfter.groupsGibbon as Gibbon).getPositionsArray();
    const permsAfter = (
      userAfter.permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(groupsAfter).toEqual([GROUP_POSITION_FIXTURES.PLANETEERS]);
    expect(permsAfter).toEqual([
      PERMISSION_POSITIONS_FIXTURES.USER,
      PERMISSION_POSITIONS_FIXTURES.BACK_DOOR,
      PERMISSION_POSITIONS_FIXTURES.THE_EDGE,
    ]);
  });

  it('Create a user with initial empty gibbons', async () => {
    const user = await adapter.createUser({
      name: 'New User',
      email: 'new@user.com',
    });
    expect(user.name).toBe('New User');
    expect(user.email).toBe('new@user.com');
    expect(user.permissionsGibbon).toBeInstanceOf(Gibbon);
    expect(user.groupsGibbon).toBeInstanceOf(Gibbon);
    expect((user.permissionsGibbon as Gibbon).getPositionsArray()).toHaveLength(
      0
    );
    expect((user.groupsGibbon as Gibbon).getPositionsArray()).toHaveLength(0);
  });

  it('Find users by arbitrary filter', async () => {
    const users = (await adapter
      .findUsers({ metadata: { name: { ilike: '%Arnold%' } } })
      .toArray()) as TestUser[];
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('Arnold Schwarzenegger');
    expect(users[0].permissionsGibbon).toBeInstanceOf(Gibbon);
  });

  it('Remove a user', async () => {
    await adapter.createUser({
      name: 'To Be Removed',
      email: 'remove@me.com',
    });
    const countBefore = (
      await adapter
        .findUsers({ metadata: { email: 'remove@me.com' } })
        .toArray()
    ).length;
    expect(countBefore).toBe(1);

    const removed = await adapter.removeUser({
      metadata: { email: 'remove@me.com' },
    });
    expect(removed).toBe(1);

    const countAfter = (
      await adapter
        .findUsers({ metadata: { email: 'remove@me.com' } })
        .toArray()
    ).length;
    expect(countAfter).toBe(0);
  });

  it('List all allocated groups', async () => {
    const groups = (await adapter
      .findAllAllocatedGroups()
      .toArray()) as TestGroup[];
    expect(groups.length).toBeGreaterThanOrEqual(4);
    groups.forEach((group) => {
      expect(group.gibbonIsAllocated).toBe(true);
      expect(group.permissionsGibbon).toBeInstanceOf(Gibbon);
    });
  });

  it('List all allocated permissions', async () => {
    const permissions = (await adapter
      .findAllAllocatedPermissions()
      .toArray()) as TestPermission[];
    expect(permissions.length).toBeGreaterThanOrEqual(5);
    permissions.forEach((p) => {
      expect(p.gibbonIsAllocated).toBe(true);
    });
  });

  it('Update group metadata', async () => {
    const updated = (await adapter.updateGroupMetadata(
      GROUP_POSITION_FIXTURES.GI_JOE,
      { name: 'GI Joe Updated' }
    )) as TestGroup;
    expect(updated).not.toBeNull();
    expect(updated.name).toBe('GI Joe Updated');
    expect(updated.gibbonGroupPosition).toBe(GROUP_POSITION_FIXTURES.GI_JOE);
    expect(updated.gibbonIsAllocated).toBe(true);
    expect(updated.permissionsGibbon).toBeInstanceOf(Gibbon);

    await adapter.updateGroupMetadata(GROUP_POSITION_FIXTURES.GI_JOE, {
      name: 'GI Joe',
    });
  });

  it('Update group metadata returns null for non-allocated group', async () => {
    const result = await adapter.updateGroupMetadata(9999, {
      name: 'Should not work',
    });
    expect(result).toBeNull();
  });

  it('Update permission metadata', async () => {
    const updated = (await adapter.updatePermissionMetadata(
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
      { name: 'God mode Updated' }
    )) as TestPermission;
    expect(updated).not.toBeNull();
    expect(updated.name).toBe('God mode Updated');
    expect(updated.gibbonPermissionPosition).toBe(
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE
    );
    expect(updated.gibbonIsAllocated).toBe(true);

    await adapter.updatePermissionMetadata(
      PERMISSION_POSITIONS_FIXTURES.GOD_MODE,
      { name: 'God mode' }
    );
  });

  it('Unsubscribe a user from a group', async () => {
    await adapter.subscribeUsersToGroups(
      { metadata: { name: { ilike: '%Cooper%' } } },
      [GROUP_POSITION_FIXTURES.TRANSFORMERS]
    );

    const userBefore = await findUserByName('Cooper');
    expect(userBefore).not.toBeNull();
    if (!userBefore) return;
    expect((userBefore.groupsGibbon as Gibbon).getPositionsArray()).toContain(
      GROUP_POSITION_FIXTURES.TRANSFORMERS
    );

    await adapter.unsubscribeUsersFromGroups(
      { metadata: { name: { ilike: '%Cooper%' } } },
      [GROUP_POSITION_FIXTURES.TRANSFORMERS]
    );

    const userAfter = await findUserByName('Cooper');
    expect(userAfter).not.toBeNull();
    if (!userAfter) return;
    const groupsAfter = (userAfter.groupsGibbon as Gibbon).getPositionsArray();
    const permsAfter = (
      userAfter.permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(groupsAfter).not.toContain(GROUP_POSITION_FIXTURES.TRANSFORMERS);
    expect(groupsAfter).toContain(GROUP_POSITION_FIXTURES.PLANETEERS);
    expect(permsAfter).toContain(PERMISSION_POSITIONS_FIXTURES.USER);
    expect(permsAfter).toContain(PERMISSION_POSITIONS_FIXTURES.THE_EDGE);
    expect(permsAfter).not.toContain(PERMISSION_POSITIONS_FIXTURES.ADMIN);
  });

  it('Unsubscribe permissions from groups and recalculate user permissions', async () => {
    const userBefore = await findUserByName('Cooper');
    expect(userBefore).not.toBeNull();
    if (!userBefore) return;
    expect(
      (userBefore.permissionsGibbon as Gibbon).getPositionsArray()
    ).toContain(PERMISSION_POSITIONS_FIXTURES.THE_EDGE);

    await adapter.unsubscribePermissionsFromGroups(
      [GROUP_POSITION_FIXTURES.PLANETEERS],
      [PERMISSION_POSITIONS_FIXTURES.THE_EDGE]
    );

    const groups = (await adapter
      .findGroups(
        Gibbon.create(1024).setPosition(GROUP_POSITION_FIXTURES.PLANETEERS)
      )
      .toArray()) as TestGroup[];
    const groupPerms = (
      groups[0].permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(groupPerms).not.toContain(PERMISSION_POSITIONS_FIXTURES.THE_EDGE);
    expect(groupPerms).toContain(PERMISSION_POSITIONS_FIXTURES.USER);

    const userAfter = await findUserByName('Cooper');
    expect(userAfter).not.toBeNull();
    if (!userAfter) return;
    const permsAfter = (
      userAfter.permissionsGibbon as Gibbon
    ).getPositionsArray();
    expect(permsAfter).not.toContain(PERMISSION_POSITIONS_FIXTURES.THE_EDGE);
    expect(permsAfter).toContain(PERMISSION_POSITIONS_FIXTURES.USER);
  });

  it('Find permissions by positions', async () => {
    const positions = [
      PERMISSION_POSITIONS_FIXTURES.USER,
      PERMISSION_POSITIONS_FIXTURES.THE_EDGE,
    ];
    const permissions = (await adapter
      .findPermissions(positions)
      .toArray()) as TestPermission[];
    expect(permissions).toHaveLength(2);
    const userPerm = permissions.find(
      (p) => p.gibbonPermissionPosition === PERMISSION_POSITIONS_FIXTURES.USER
    );
    const edgePerm = permissions.find(
      (p) =>
        p.gibbonPermissionPosition === PERMISSION_POSITIONS_FIXTURES.THE_EDGE
    );
    expect(userPerm?.name).toBe('User');
    expect(edgePerm?.name).toBe('C0ff3e MAcHiNe at the edge of sp@ce');
  });

  it('Update user metadata', async () => {
    const user = await findUserByName(usersFixtures[0].name);
    expect(user).not.toBeNull();
    if (!user) return;
    expect(user.email).toBe(usersFixtures[0].email);

    const updated = await adapter.updateUserMetadata(
      { id: user.id },
      { name: 'Updated Name', email: 'updated@example.com' }
    );
    expect(updated).not.toBeNull();
    expect(updated?.name).toBe('Updated Name');
    expect(updated?.email).toBe('updated@example.com');
    expect(updated?.groupsGibbon).toBeInstanceOf(Gibbon);
    expect(updated?.permissionsGibbon).toBeInstanceOf(Gibbon);

    const fetchedRows = await pool.query<{
      metadata: { name?: string; email?: string };
    }>(`SELECT metadata FROM ${userTable} WHERE id = $1::uuid`, [user.id]);
    expect(fetchedRows.rows[0].metadata.name).toBe('Updated Name');
    expect(fetchedRows.rows[0].metadata.email).toBe('updated@example.com');
  });

  it('Should throw error when subscribing invalid (unallocated) permissions to groups', async () => {
    await expect(
      adapter.subscribePermissionsToGroups(
        [GROUP_POSITION_FIXTURES.PLANETEERS],
        [999]
      )
    ).rejects.toThrow('Suggested permissions are not valid (not allocated)');
  });

  it('Should throw error when subscribing permissions to invalid (unallocated) groups', async () => {
    await expect(
      adapter.subscribePermissionsToGroups(
        [999],
        [PERMISSION_POSITIONS_FIXTURES.USER]
      )
    ).rejects.toThrow('Suggested groups are not valid (not allocated)');
  });

  it('Should throw error when subscribing users to invalid (unallocated) groups', async () => {
    await expect(
      adapter.subscribeUsersToGroups(
        { metadata: { name: { ilike: '%Cooper%' } } },
        [999]
      )
    ).rejects.toThrow("Suggested groups aren't valid (not allocated)");
  });
});
