import { Buffer } from 'node:buffer';
import { Gibbon } from '@icazemier/gibbons';
import type { Pool, PoolClient } from 'pg';
import { GibbonLike } from '../interfaces/index.js';
import { pickQueryable, Queryable } from '../queryable.js';

/**
 * Managed columns/keys that callers must not be able to overwrite through
 * arbitrary metadata.
 */
const MANAGED_KEYS = new Set([
  'id',
  'gibbonGroupPosition',
  'gibbonPermissionPosition',
  'gibbonIsAllocated',
  'groupsGibbon',
  'permissionsGibbon',
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Abstract base class for Gibbon PostgreSQL models.
 *
 * Provides shared functionality such as the `ensureGibbon` conversion utility,
 * managed-key stripping for caller-supplied metadata, and the configured byte
 * length used to size new Gibbons.
 */
export abstract class GibbonModel {
  /**
   * Fully qualified table name (already validated and quoted by the concrete
   * model in `initialize`). Set by `initialize(dbName, tableName)`.
   */
  protected tableName!: string;

  /**
   * @param pool - Connected PostgreSQL pool
   * @param byteLength - Number of bytes for Gibbon bitmasks (default: 256)
   */
  constructor(
    protected pool: Pool,
    protected byteLength: number = 256
  ) {}

  /**
   * Updates the internal byte length used by this model.
   * Use this after expand/shrink operations to keep newly created Gibbons sized
   * correctly.
   *
   * @param newByteLength - The new byte length (must be a positive integer)
   */
  public setByteLength(newByteLength: number): void {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('byteLength must be a positive integer');
    }
    this.byteLength = newByteLength;
  }

  /**
   * Initializes the model by binding it to a specific table name.
   *
   * @param dbName - Database name (kept for parity with the MongoDB adapter;
   *                 not used since the pool already targets the right database)
   * @param tableName - Table name to bind to
   */
  abstract initialize(dbName: string, tableName: string): Promise<void>;

  /**
   * Convenience function which accepts an Array of positions, a Gibbon or Buffer
   * and returns a Gibbon instance with the configured byte length.
   *
   * - If given an `Array<number>`, creates a new Gibbon and sets the positions.
   * - If given a `Buffer`, decodes it and merges into a new Gibbon.
   * - If given a `Gibbon` with matching byte length, returns it as-is.
   * - If given a `Gibbon` with a different byte length, merges it into a new one.
   *
   * @param positions - Gibbon, array of positions, or Buffer to convert
   * @returns A Gibbon instance with the configured byte length
   * @throws TypeError when `positions` is not a Gibbon, Array or Buffer
   */
  ensureGibbon(positions: GibbonLike): Gibbon {
    const { byteLength } = this;
    if (positions instanceof Gibbon) {
      if (positions.arrayBuffer.byteLength === byteLength) {
        return positions;
      }
      return Gibbon.create(byteLength).mergeWithGibbon(positions);
    } else if (Array.isArray(positions)) {
      const maxPosition = byteLength * 8;
      for (const pos of positions) {
        if (!Number.isInteger(pos) || pos < 1) {
          throw new RangeError(
            `Position must be a positive integer, got: ${pos}`
          );
        }
        if (pos > maxPosition) {
          throw new RangeError(
            `Position ${pos} exceeds capacity (max: ${maxPosition} for byteLength ${byteLength})`
          );
        }
      }
      return Gibbon.create(byteLength).setAllFromPositions(positions);
    } else if (Buffer.isBuffer(positions)) {
      return Gibbon.create(byteLength).mergeWithGibbon(
        Gibbon.decode(positions)
      );
    }
    throw new TypeError('`Gibbon`, `Array<number>` or `Buffer` expected');
  }

  /**
   * Strips managed keys (id, gibbon position fields, gibbon mask fields) from
   * user-provided metadata so callers can not overwrite columns that the
   * library owns.
   *
   * @param data - User-provided key-value pairs
   * @returns A shallow copy with managed keys removed
   */
  protected static sanitizeData<T extends Record<string, unknown>>(
    data: T
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      if (!MANAGED_KEYS.has(key)) {
        sanitized[key] = data[key];
      }
    }
    return sanitized;
  }

  /**
   * Resizes a Buffer-encoded Gibbon to a new byte length by creating a new
   * Gibbon and merging the old bits into it. Bits beyond the new length are
   * silently dropped when shrinking.
   *
   * @param buffer - Existing Gibbon buffer
   * @param newByteLength - Target byte length
   * @returns A Buffer with the resized Gibbon
   */
  protected static resizeGibbon(buffer: Buffer, newByteLength: number): Buffer {
    if (!Number.isInteger(newByteLength) || newByteLength < 1) {
      throw new RangeError('newByteLength must be a positive integer');
    }
    if (buffer.length <= newByteLength) {
      const oldGibbon = Gibbon.decode(buffer);
      return Gibbon.create(newByteLength).mergeWithGibbon(oldGibbon).toBuffer();
    }
    const truncated = buffer.subarray(0, newByteLength);
    return Gibbon.decode(Buffer.from(truncated)).toBuffer();
  }

  /**
   * Returns the queryable for a model method call: the supplied transactional
   * client when present, otherwise the pool.
   *
   * Protected extension point — subclass model methods should use this instead
   * of accessing `this.pool` directly so they automatically participate in
   * caller-supplied transactions.
   */
  protected runner(client?: PoolClient): Queryable {
    return pickQueryable(this.pool, client);
  }

  /**
   * Returns the cursor source for a `PgCursor`: uses the caller-supplied
   * transactional client when present so the cursor shares the transaction,
   * otherwise borrows a fresh client from the pool.
   *
   * Protected extension point — use this when constructing a `PgCursor` inside
   * a subclass method so the cursor automatically participates in any
   * caller-supplied transaction.
   */
  protected cursorSource(
    client?: PoolClient
  ): { pool: Pool } | { client: PoolClient } {
    return client ? { client } : { pool: this.pool };
  }
}
