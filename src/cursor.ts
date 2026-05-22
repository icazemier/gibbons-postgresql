import { Readable } from 'node:stream';
import Cursor from 'pg-cursor';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

const DEFAULT_BATCH_SIZE = 100;

/**
 * Source from which to acquire the long-lived PostgreSQL client used by the
 * cursor. Either an existing pool (the cursor borrows a client and releases it
 * when consumption finishes) or a pre-bound client (the cursor uses it but does
 * NOT release it — the caller owns the lifecycle, e.g. inside a transaction).
 */
type CursorSource = { pool: Pool } | { client: PoolClient };

export interface PgCursorOptions {
  sql: string;
  params?: unknown[];
  batchSize?: number;
}

/**
 * A streaming cursor over a PostgreSQL query result, modelled after MongoDB's
 * `FindCursor`. Supports `.toArray()`, `.stream()`, async iteration and
 * lazy row mapping via `.map()`.
 *
 * Acquires a `PoolClient` on first read (or reuses a caller-provided client
 * for transactional use). The client is released back to the pool when
 * iteration completes, fails, or `.close()` is called explicitly.
 */
export class PgCursor<T> implements AsyncIterable<T> {
  private readonly source: CursorSource;
  private readonly sql: string;
  private readonly params: unknown[];
  private readonly batchSize: number;
  private readonly mapper: (row: QueryResultRow) => T;

  private client: PoolClient | null = null;
  private cursor: Cursor | null = null;
  private ownsClient = false;
  private closed = false;

  constructor(
    source: CursorSource,
    options: PgCursorOptions,
    mapper: (row: QueryResultRow) => T
  ) {
    this.source = source;
    this.sql = options.sql;
    this.params = options.params ?? [];
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.mapper = mapper;
  }

  /**
   * Returns a new cursor that yields `fn(row)` instead of `row`. Useful for
   * decoding binary columns into Gibbon instances or shaping output.
   */
  public map<U>(fn: (value: T) => U): PgCursor<U> {
    const previous = this.mapper;
    return new PgCursor<U>(
      this.source,
      {
        sql: this.sql,
        params: this.params,
        batchSize: this.batchSize,
      },
      (row) => fn(previous(row))
    );
  }

  /**
   * Consumes the cursor and resolves with all rows as an array.
   */
  public async toArray(): Promise<T[]> {
    const out: T[] = [];
    for await (const row of this) {
      out.push(row);
    }
    return out;
  }

  /**
   * Returns the cursor as a Node.js Readable stream (object mode).
   * Each emitted value is a mapped row.
   */
  public stream(): Readable {
    const iterator = this[Symbol.asyncIterator]();
    return Readable.from(
      (async function* () {
        let next = await iterator.next();
        while (!next.done) {
          yield next.value;
          next = await iterator.next();
        }
      })(),
      { objectMode: true }
    );
  }

  /**
   * Closes the cursor and releases the pooled client if owned.
   * Safe to call multiple times.
   *
   * Throws if `pg-cursor.close()` fails. The borrowed client is *always*
   * released regardless, because the release happens in a `finally` block.
   * Callers wrapping `close()` inside a `catch` should use `AggregateError`
   * (or equivalent) to preserve both the original error and any close failure.
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (this.cursor) {
        await this.cursor.close();
      }
    } finally {
      this.cursor = null;
      if (this.client && this.ownsClient) {
        this.client.release();
      }
      this.client = null;
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    let buffer: QueryResultRow[] = [];
    let exhausted = false;

    const ensureOpen = async (): Promise<void> => {
      if (this.closed) {
        throw new Error('Cursor has been closed');
      }
      if (this.cursor) {
        return;
      }
      if ('client' in this.source) {
        this.client = this.source.client;
        this.ownsClient = false;
      } else {
        this.client = await this.source.pool.connect();
        this.ownsClient = true;
      }
      this.cursor = this.client.query(new Cursor(this.sql, this.params));
    };

    const readBatch = (): Promise<QueryResultRow[]> => {
      return new Promise((resolve, reject) => {
        const c = this.cursor;
        if (!c) {
          resolve([]);
          return;
        }
        c.read(this.batchSize, (err, rows) => {
          /* v8 ignore next 4 — pg-cursor only errors here on a torn connection */
          if (err) {
            reject(err);
            return;
          }
          resolve(rows);
        });
      });
    };

    return {
      next: async (): Promise<IteratorResult<T>> => {
        try {
          await ensureOpen();
          while (buffer.length === 0 && !exhausted) {
            const rows = await readBatch();
            if (rows.length === 0) {
              exhausted = true;
            } else {
              buffer = rows;
            }
          }
          if (buffer.length === 0) {
            await this.close();
            return { value: undefined, done: true };
          }
          const row = buffer.shift();
          return { value: this.mapper(row as QueryResultRow), done: false };
        } catch (err) {
          try {
            await this.close();
          } catch (closeErr) {
            throw new AggregateError(
              [err, closeErr],
              'Cursor iteration failed and close() also failed',
              { cause: closeErr }
            );
          }
          throw err;
        }
      },
      return: async (): Promise<IteratorResult<T>> => {
        await this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
