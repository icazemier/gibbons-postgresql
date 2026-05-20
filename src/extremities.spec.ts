import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Pool } from 'pg';
import { GibbonsPostgreSql } from './gibbons-postgresql.js';
import { PostgreSqlSeeder } from './seeder.js';
import { ConfigLoader } from './config.js';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import {
  seedTestFixtures,
  seedUserTestFixtures,
  tearDownGroupTestFixtures,
  tearDownPermissionTestFixtures,
  tearDownUserTestFixtures,
} from '../test/helper/seeders.js';
import { Config } from './interfaces/index.js';
import { quoteIdent } from './sql.js';

describe('Explore the outer rims of permission / groups', () => {
  let adapter: GibbonsPostgreSql;
  let pool: Pool;
  let config: Config;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
    config = await ConfigLoader.load('gibbons-postgresql-sample');

    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize();

    adapter = new GibbonsPostgreSql(PostgreSqlTestServer.uri, config);
    await adapter.initialize();

    await seedTestFixtures(pool, config);
  });

  beforeEach(async () => {
    try {
      await seedUserTestFixtures(pool, config);
    } catch (error) {
      if (error instanceof Error) {
        console.error(error.message);
      }
    }
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

  describe('No permissions left', () => {
    beforeAll(async () => {
      await pool.query(
        `UPDATE ${quoteIdent(config.dbStructure.permission.tableName)}
         SET gibbon_is_allocated = TRUE`
      );
      await pool.query(
        `UPDATE ${quoteIdent(config.dbStructure.group.tableName)}
         SET gibbon_is_allocated = TRUE`
      );
    });

    it(`Try to allocate a permission, but there isn't any left`, async () => {
      await expect(
        adapter.allocatePermission({ name: 'Where no man has gone before' })
      ).rejects.toThrow(
        'Not able to allocate permission, seems all permissions are allocated'
      );
    });

    it(`Try to allocate a group, but there isn't any left`, async () => {
      await expect(
        adapter.allocateGroup({ name: 'Where no man has gone before' })
      ).rejects.toThrow(
        'Not able to allocate group, seems all groups are allocated'
      );
    });
  });
});
