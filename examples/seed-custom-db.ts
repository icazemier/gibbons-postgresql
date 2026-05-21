/**
 * Example: Programmatically seed a custom PostgreSQL database with gibbons-postgresql.
 *
 * Usage:
 *   npx tsx examples/seed-custom-db.ts
 *
 * Prerequisites:
 *   - A running PostgreSQL instance (default: postgresql://localhost:5432/postgres)
 */
import { Pool } from 'pg';
import { PostgreSqlSeeder, Config } from '../src/index.js';

async function main() {
  const uri = process.env.PG_URI ?? 'postgresql://localhost:5432/postgres';

  const config: Config = {
    dbName: 'my_custom_db',
    permissionByteLength: 128,
    groupByteLength: 128,
    postgresqlMutationConcurrency: 5,
    dbStructure: {
      user: { tableName: 'users' },
      group: { tableName: 'groups' },
      permission: { tableName: 'permissions' },
    },
  };

  const pool = new Pool({ connectionString: uri });

  try {
    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize();

    const totalGroups = config.groupByteLength * 8;
    const totalPermissions = config.permissionByteLength * 8;
    console.log(
      `Seeded ${totalGroups} groups and ${totalPermissions} permissions into "${config.dbName}".`
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
