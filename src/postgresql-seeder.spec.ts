import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  tearDownGroupTestFixtures,
  tearDownPermissionTestFixtures,
} from '../test/helper/seeders.js';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import { ConfigLoader } from './config.js';
import { PostgreSqlSeeder } from './seeder.js';
import { Config } from './interfaces/index.js';
import { quoteIdent } from './sql.js';

describe('PostgreSqlSeeder', () => {
  let pool: Pool;
  let seeder: PostgreSqlSeeder;
  let config: Config;
  let groupTable: string;
  let permissionTable: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    config = await ConfigLoader.load('gibbons-postgresql-sample');

    seeder = new PostgreSqlSeeder(pool, config);
    groupTable = quoteIdent(config.dbStructure.group.tableName);
    permissionTable = quoteIdent(config.dbStructure.permission.tableName);

    await seeder.initialize();
  });

  afterAll(async () => {
    await tearDownGroupTestFixtures(pool, config);
    await tearDownPermissionTestFixtures(pool, config);
    await pool.end();
  });

  it('creates the expected number of group slots', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    expect(Number(rows[0].count)).toBe(config.groupByteLength * 8);
  });

  it('creates the expected number of permission slots', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permissionTable}`
    );
    expect(Number(rows[0].count)).toBe(config.permissionByteLength * 8);
  });

  it('positions are enforced as the primary key', async () => {
    const groupKey = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_name = $1 AND constraint_name LIKE '%pkey%'`,
      [config.dbStructure.group.tableName]
    );
    expect(
      groupKey.rows.some((r) => r.column_name === 'gibbon_group_position')
    ).toBe(true);

    const permKey = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.key_column_usage
       WHERE table_name = $1 AND constraint_name LIKE '%pkey%'`,
      [config.dbStructure.permission.tableName]
    );
    expect(
      permKey.rows.some((r) => r.column_name === 'gibbon_permission_position')
    ).toBe(true);
  });

  it('initialize() is idempotent — calling it again does not duplicate or overwrite data', async () => {
    await pool.query(
      `UPDATE ${permissionTable}
       SET gibbon_is_allocated = TRUE,
           metadata = metadata || '{"name":"Existing"}'::jsonb
       WHERE gibbon_permission_position = 1`
    );

    await seeder.initialize();

    const groupCountRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${groupTable}`
    );
    const permCountRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${permissionTable}`
    );
    expect(Number(groupCountRes.rows[0].count)).toBe(
      config.groupByteLength * 8
    );
    expect(Number(permCountRes.rows[0].count)).toBe(
      config.permissionByteLength * 8
    );

    const perm = await pool.query<{
      gibbon_is_allocated: boolean;
      metadata: { name?: string };
    }>(
      `SELECT gibbon_is_allocated, metadata FROM ${permissionTable}
       WHERE gibbon_permission_position = 1`
    );
    expect(perm.rows[0].gibbon_is_allocated).toBe(true);
    expect(perm.rows[0].metadata.name).toBe('Existing');

    await pool.query(
      `UPDATE ${permissionTable}
       SET gibbon_is_allocated = FALSE,
           metadata = '{}'::jsonb
       WHERE gibbon_permission_position = 1`
    );
  });

  it('populateGroupsAndPermissions() throws when data already exists (deprecated)', async () => {
    await expect(seeder.populateGroupsAndPermissions()).rejects.toThrow(
      'Called populateGroupsAndPermissions, but permissions and groups seem to be populated already'
    );
  });
});
