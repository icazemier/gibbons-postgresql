import { Gibbon } from '@icazemier/gibbons';
import type { Pool } from 'pg';
import { Config } from '../../src/interfaces/config.js';
import { quoteIdent } from '../../src/sql.js';
import {
  permissionsFixtures,
  usersFixtures,
  groupsFixtures,
} from './fixtures.js';

export const tearDownGroupTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  await pool.query(
    `DELETE FROM ${quoteIdent(config.dbStructure.group.tableName)}`
  );
};

export const tearDownPermissionTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  await pool.query(
    `DELETE FROM ${quoteIdent(config.dbStructure.permission.tableName)}`
  );
};

export const tearDownUserTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  await pool.query(
    `DELETE FROM ${quoteIdent(config.dbStructure.user.tableName)}`
  );
};

export const seedUserTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  const userTable = quoteIdent(config.dbStructure.user.tableName);
  for (const user of usersFixtures) {
    const groups = Gibbon.decode(user.groupsGibbon).getPositionsArray();
    const groupsFiltered = groupsFixtures.filter(({ gibbonGroupPosition }) =>
      groups.includes(gibbonGroupPosition)
    );

    const permissionGibbon = Gibbon.create(config.permissionByteLength);
    for (const group of groupsFiltered) {
      permissionGibbon.mergeWithGibbon(Gibbon.decode(group.permissionsGibbon));
    }
    user.permissionsGibbon = permissionGibbon.toBuffer();

    await pool.query(
      `INSERT INTO ${userTable} (groups_gibbon, permissions_gibbon, metadata)
       VALUES ($1, $2, $3::jsonb)`,
      [
        user.groupsGibbon,
        user.permissionsGibbon,
        JSON.stringify({ email: user.email, name: user.name }),
      ]
    );
  }
};

export const seedPermissionTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  const permissionTable = quoteIdent(config.dbStructure.permission.tableName);
  await Promise.all(
    permissionsFixtures.map(
      ({ name, gibbonPermissionPosition, gibbonIsAllocated }) =>
        pool.query(
          `UPDATE ${permissionTable}
           SET gibbon_is_allocated = $1,
               metadata = metadata || $2::jsonb
           WHERE gibbon_permission_position = $3`,
          [
            gibbonIsAllocated,
            JSON.stringify({ name }),
            gibbonPermissionPosition,
          ]
        )
    )
  );
};

export const seedGroupTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  const groupTable = quoteIdent(config.dbStructure.group.tableName);
  await Promise.all(
    groupsFixtures.map(
      ({ name, gibbonGroupPosition, permissionsGibbon, gibbonIsAllocated }) =>
        pool.query(
          `UPDATE ${groupTable}
           SET gibbon_is_allocated = $1,
               permissions_gibbon = $2,
               metadata = metadata || $3::jsonb
           WHERE gibbon_group_position = $4`,
          [
            gibbonIsAllocated,
            permissionsGibbon,
            JSON.stringify({ name }),
            gibbonGroupPosition,
          ]
        )
    )
  );
};

export const seedTestFixtures = async (
  pool: Pool,
  config: Config
): Promise<void> => {
  await seedPermissionTestFixtures(pool, config);
  await seedGroupTestFixtures(pool, config);
};
