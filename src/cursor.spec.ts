import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgreSqlTestServer } from '../test/helper/postgresql-memory-server.js';
import { PgCursor } from './cursor.js';

/**
 * Targeted tests for the cursor lifecycle paths the integration tests don't
 * naturally hit: early `break` (invokes the async iterator's `return`),
 * mapper-throw rethrow, double `close()`, and the `close()` short-circuit.
 */
describe('PgCursor lifecycle', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PostgreSqlTestServer.uri });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('releases the client when iteration is broken early', async () => {
    const cursor = new PgCursor<{ n: number }>(
      { pool },
      { sql: 'SELECT generate_series(1, 100) AS n', batchSize: 10 },
      (row) => ({ n: Number((row as { n: number }).n) })
    );

    let count = 0;
    for await (const row of cursor) {
      count++;
      if (row.n === 3) break;
    }
    expect(count).toBe(3);

    // After breaking out, the pool should still have all clients available
    // (the cursor must have released its borrowed client via the `return:` path).
    const probe = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(probe.rows[0].ok).toBe(1);
  });

  it('rethrows a mapper error and closes the cursor', async () => {
    const cursor = new PgCursor<{ n: number }>(
      { pool },
      { sql: 'SELECT generate_series(1, 5) AS n' },
      () => {
        throw new Error('mapper exploded');
      }
    );

    await expect(async () => {
      for await (const row of cursor) {
        void row; // never reached
      }
    }).rejects.toThrow('mapper exploded');

    // close() is idempotent — calling it again is a no-op
    await cursor.close();
  });

  it('close() is a no-op when called before any read', async () => {
    const cursor = new PgCursor<{ n: number }>(
      { pool },
      { sql: 'SELECT 1 AS n' },
      (row) => ({ n: Number((row as { n: number }).n) })
    );
    await cursor.close();
    await cursor.close(); // double close still fine
  });

  it('iterating after close throws', async () => {
    const cursor = new PgCursor<{ n: number }>(
      { pool },
      { sql: 'SELECT 1 AS n' },
      (row) => ({ n: Number((row as { n: number }).n) })
    );
    await cursor.close();
    await expect(cursor.toArray()).rejects.toThrow('Cursor has been closed');
  });

  it('map() lifts the row type and stacks transformations', async () => {
    const base = new PgCursor<{ n: number }>(
      { pool },
      { sql: 'SELECT generate_series(1, 3) AS n' },
      (row) => ({ n: Number((row as { n: number }).n) })
    );
    const doubled = base.map((row) => row.n * 2);
    const out = await doubled.toArray();
    expect(out).toEqual([2, 4, 6]);
  });
});
