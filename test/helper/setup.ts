import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';

loadEnv();

let pg: EmbeddedPostgres | undefined;
let dataDir: string | undefined;

const TEST_DB = 'gibbons_test';
const TEST_USER = 'postgres';
const TEST_PASSWORD = 'postgres';
const TEST_PORT = 54329;

/**
 * Global setup for the test suite: spins up an embedded PostgreSQL instance,
 * creates the test database, and exposes the connection URI through
 * `PG_URI` so individual test files can pick it up.
 */
export async function setup(): Promise<void> {
  console.info('Setting up embedded PostgreSQL server');

  dataDir = join(
    tmpdir(),
    `gibbons-postgresql-test-${process.pid}-${Date.now()}`
  );
  await mkdir(dataDir, { recursive: true });

  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: TEST_USER,
    password: TEST_PASSWORD,
    port: TEST_PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(TEST_DB);

  process.env.PG_URI = `postgresql://${TEST_USER}:${TEST_PASSWORD}@localhost:${TEST_PORT}/${TEST_DB}`;
}

export async function teardown(): Promise<void> {
  if (pg) {
    try {
      await pg.stop();
    } catch {
      // ignore stop errors
    }
  }
  if (dataDir) {
    try {
      await rm(dataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
