import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Gibbon } from '@icazemier/gibbons';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import { GibbonsPostgreSql } from './gibbons-postgresql.js';
import { PostgreSqlSeeder, BYTEA_ANY_BIT_FN } from './seeder.js';
import { Config } from './interfaces/index.js';
import { quoteIdent } from './sql.js';

/**
 * Verifies the seeder works in the same mode a Prisma user would adopt:
 * the caller (Prisma migrations) creates the three tables; the seeder only
 * installs the helper SQL function and inserts the slot rows.
 */
describe('Prisma compatibility — skipSchema', () => {
  let pool: Pool;
  let config: Config;

  const userTable = 'prisma_users';
  const groupTable = 'prisma_groups';
  const permissionTable = 'prisma_permissions';

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    config = {
      dbName: 'prisma_compat',
      permissionByteLength: 2,
      groupByteLength: 2,
      postgresqlMutationConcurrency: 5,
      dbStructure: {
        user: { tableName: userTable },
        group: { tableName: groupTable },
        permission: { tableName: permissionTable },
      },
    };

    await pool.query(
      `DROP TABLE IF EXISTS ${quoteIdent(userTable)}, ${quoteIdent(
        groupTable
      )}, ${quoteIdent(permissionTable)} CASCADE`
    );

    // Simulate Prisma migrations having already created the tables.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await pool.query(`
      CREATE TABLE ${quoteIdent(userTable)} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        groups_gibbon BYTEA NOT NULL,
        permissions_gibbon BYTEA NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE TABLE ${quoteIdent(groupTable)} (
        gibbon_group_position INTEGER PRIMARY KEY,
        gibbon_is_allocated BOOLEAN NOT NULL DEFAULT FALSE,
        permissions_gibbon BYTEA NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE TABLE ${quoteIdent(permissionTable)} (
        gibbon_permission_position INTEGER PRIMARY KEY,
        gibbon_is_allocated BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    // The Prisma user runs the seeder once with skipSchema after their
    // migrations have created the tables.
    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize({ skipSchema: true });
  });

  afterAll(async () => {
    await pool.query(
      `DROP TABLE IF EXISTS ${quoteIdent(userTable)}, ${quoteIdent(
        groupTable
      )}, ${quoteIdent(permissionTable)} CASCADE`
    );
    await pool.end();
  });

  it('skipSchema seeds rows without re-creating tables', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${quoteIdent(permissionTable)}`
    );
    expect(Number(rows[0].count)).toBe(config.permissionByteLength * 8);
  });

  it('skipSchema installs the helper SQL function', async () => {
    const helper = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM pg_proc WHERE proname = $1
       ) AS exists`,
      [BYTEA_ANY_BIT_FN]
    );
    expect(helper.rows[0].exists).toBe(true);
  });

  it('full lifecycle works against externally-managed tables', async () => {
    const adapter = new GibbonsPostgreSql(pool, config);
    await adapter.initialize();

    const perm = await adapter.allocatePermission({ name: 'prisma.read' });
    const group = await adapter.allocateGroup({ name: 'PrismaReaders' });
    await adapter.subscribePermissionsToGroups(
      [group.gibbonGroupPosition],
      [perm.gibbonPermissionPosition]
    );

    const user = await adapter.createUser({
      name: 'Alice (Prisma)',
      email: 'alice@prisma.example',
    });
    await adapter.subscribeUsersToGroups({ id: user.id }, [
      group.gibbonGroupPosition,
    ]);

    const userRow = await pool.query<{
      id: string;
      permissions_gibbon: Buffer;
      metadata: { email?: string; name?: string };
    }>(
      `SELECT id, permissions_gibbon, metadata FROM ${quoteIdent(
        userTable
      )} WHERE id = $1::uuid`,
      [user.id]
    );
    expect(userRow.rows).toHaveLength(1);
    expect(userRow.rows[0].metadata.email).toBe('alice@prisma.example');
    expect(
      Gibbon.decode(userRow.rows[0].permissions_gibbon).hasAllFromPositions([
        perm.gibbonPermissionPosition,
      ])
    ).toBe(true);

    // Re-fetch — the local `user` reference is stale after subscribeUsersToGroups.
    const [fresh] = await adapter.findUsers({ id: user.id }).toArray();
    const canRead = adapter.validateUserPermissionsForAnyPermissions(
      fresh.permissionsGibbon,
      [perm.gibbonPermissionPosition]
    );
    expect(canRead).toBe(true);
  });
});
