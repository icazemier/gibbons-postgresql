import { Pool } from 'pg';
import { ConfigLoader } from '../config.js';
import { PostgreSqlSeeder } from '../seeder.js';

/**
 * Command arguments for the init command.
 */
export interface InitCommandArgs {
  /** PostgreSQL connection URI */
  uri: string;
  /** Optional path to custom configuration file */
  config?: string;
}

/**
 * Initializes a PostgreSQL database by creating the gibbons schema and
 * pre-populating groups and permissions. Connects to the database, loads
 * configuration, and runs the seeding process.
 *
 * @param argv - Command-line arguments containing URI and optional config path
 * @throws Error when configuration cannot be loaded or seeding fails
 */
export const init = async (argv: InitCommandArgs): Promise<void> => {
  const { uri, config: configFile } = argv;
  const pool = new Pool({ connectionString: uri });
  try {
    const config = await ConfigLoader.load('gibbons-postgresql', configFile);
    const seeder = new PostgreSqlSeeder(pool, config);
    await seeder.initialize();
  } finally {
    await pool.end();
  }
};
