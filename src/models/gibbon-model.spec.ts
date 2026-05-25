import { Buffer } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import { Gibbon } from '@icazemier/gibbons';
import type { Pool } from 'pg';
import { GibbonModel } from './gibbon-model.js';
import { GibbonUser } from './gibbon-user.js';
import { GibbonGroup } from './gibbon-group.js';
import { GibbonPermission } from './gibbon-permission.js';
import type { Config } from '../interfaces/index.js';
import type { IPermissionsResource } from '../interfaces/permissions-resource.js';
import type { WhereClause } from '../queryable.js';

/**
 * Minimal concrete subclass to access protected helpers. Pure unit tests —
 * never opens a database connection.
 */
class TestModel extends GibbonModel {
  public constructor(byteLength = 4) {
    super({} as Pool, byteLength);
  }

  async initialize(): Promise<void> {
    /* not used */
  }

  public sanitize<T extends Record<string, unknown>>(
    data: T
  ): Record<string, unknown> {
    return TestModel.sanitizeData(data);
  }

  public resize(buffer: Buffer, newByteLength: number): Buffer {
    return TestModel.resizeGibbon(buffer, newByteLength);
  }
}

describe('GibbonModel.setByteLength', () => {
  it('updates the configured length', () => {
    const m = new TestModel(4);
    m.setByteLength(8);
    const gibbon = m.ensureGibbon([1]);
    expect(gibbon.arrayBuffer.byteLength).toBe(8);
  });

  it('throws on zero or negative', () => {
    const m = new TestModel(4);
    expect(() => m.setByteLength(0)).toThrow(/positive integer/);
    expect(() => m.setByteLength(-1)).toThrow(/positive integer/);
  });

  it('throws on non-integer', () => {
    const m = new TestModel(4);
    expect(() => m.setByteLength(1.5)).toThrow(/positive integer/);
  });
});

describe('GibbonModel.ensureGibbon', () => {
  it('returns the same Gibbon when byte length already matches', () => {
    const m = new TestModel(2);
    const input = Gibbon.create(2).setPosition(3);
    const out = m.ensureGibbon(input);
    expect(out).toBe(input);
  });

  it('re-wraps a Gibbon when its byte length differs', () => {
    const m = new TestModel(4);
    const input = Gibbon.create(2).setPosition(3);
    const out = m.ensureGibbon(input);
    expect(out).not.toBe(input);
    expect(out.arrayBuffer.byteLength).toBe(4);
    expect(out.getPositionsArray()).toEqual([3]);
  });

  it('accepts an array of positions', () => {
    const m = new TestModel(4);
    const out = m.ensureGibbon([1, 4, 6]);
    expect(out.getPositionsArray()).toEqual([1, 4, 6]);
  });

  it('throws when an array contains zero', () => {
    const m = new TestModel(4);
    expect(() => m.ensureGibbon([0])).toThrow(/positive integer/);
  });

  it('throws when an array contains a negative', () => {
    const m = new TestModel(4);
    expect(() => m.ensureGibbon([1, -3])).toThrow(/positive integer/);
  });

  it('throws when an array contains a non-integer', () => {
    const m = new TestModel(4);
    expect(() => m.ensureGibbon([1.5])).toThrow(/positive integer/);
  });

  it('throws when a position exceeds byteLength * 8', () => {
    const m = new TestModel(4); // max = 32
    expect(() => m.ensureGibbon([33])).toThrow(/exceeds capacity/);
    expect(() => m.ensureGibbon([32])).not.toThrow();
  });

  it('accepts a Buffer', () => {
    const m = new TestModel(2);
    const buf = Gibbon.create(2).setPosition(5).toBuffer();
    const out = m.ensureGibbon(buf);
    expect(out.getPositionsArray()).toEqual([5]);
  });

  it('throws on unsupported input', () => {
    const m = new TestModel(4);
    expect(() => m.ensureGibbon('nope' as unknown as number[])).toThrow(
      /Gibbon.*Array.*Buffer/
    );
    expect(() => m.ensureGibbon(42 as unknown as number[])).toThrow(
      /Gibbon.*Array.*Buffer/
    );
    expect(() => m.ensureGibbon(null as unknown as number[])).toThrow(
      /Gibbon.*Array.*Buffer/
    );
  });
});

describe('GibbonModel.sanitizeData', () => {
  it('strips managed keys', () => {
    const m = new TestModel();
    const out = m.sanitize({
      id: 'leaked',
      gibbonGroupPosition: 99,
      gibbonPermissionPosition: 99,
      gibbonIsAllocated: true,
      groupsGibbon: Buffer.alloc(0),
      permissionsGibbon: Buffer.alloc(0),
      name: 'Alice',
      email: 'a@b.c',
    });
    expect(out).toEqual({ name: 'Alice', email: 'a@b.c' });
  });

  it('strips prototype pollution keys', () => {
    const m = new TestModel();
    const out = m.sanitize({
      __proto__: { isAdmin: true },
      constructor: 'bad',
      prototype: 'bad',
      name: 'safe',
    });
    expect(out).toEqual({ name: 'safe' });
    expect(out).not.toHaveProperty('__proto__');
    expect(out).not.toHaveProperty('constructor');
    expect(out).not.toHaveProperty('prototype');
  });

  it('keeps all non-managed keys verbatim', () => {
    const m = new TestModel();
    const data = { a: 1, b: 'two', c: true, d: null, nested: { x: 1 } };
    expect(m.sanitize(data)).toEqual(data);
  });
});

describe('GibbonModel.resizeGibbon', () => {
  it('expands by merging the smaller into the larger', () => {
    const m = new TestModel();
    const original = Gibbon.create(2).setPosition(5).toBuffer();
    const resized = m.resize(original, 4);
    expect(resized.length).toBe(4);
    expect(Gibbon.decode(resized).getPositionsArray()).toEqual([5]);
  });

  it('returns the same length when sizes match', () => {
    const m = new TestModel();
    const original = Gibbon.create(2).setPosition(3).toBuffer();
    const resized = m.resize(original, 2);
    expect(resized.length).toBe(2);
    expect(Gibbon.decode(resized).getPositionsArray()).toEqual([3]);
  });

  it('shrinks by truncating then decoding', () => {
    const m = new TestModel();
    const original = Gibbon.create(4)
      .setAllFromPositions([3, 12, 28])
      .toBuffer();
    const resized = m.resize(original, 2);
    expect(resized.length).toBe(2);
    // positions 3 and 12 are within the first 16 bits; 28 is dropped
    const positions = Gibbon.decode(resized).getPositionsArray();
    expect(positions).toContain(3);
    expect(positions).toContain(12);
    expect(positions).not.toContain(28);
  });

  it('throws on zero / negative / non-integer target', () => {
    const m = new TestModel();
    const buf = Gibbon.create(2).toBuffer();
    expect(() => m.resize(buf, 0)).toThrow(/positive integer/);
    expect(() => m.resize(buf, -2)).toThrow(/positive integer/);
    expect(() => m.resize(buf, 1.5)).toThrow(/positive integer/);
  });
});

// ─── Empty-position guards ──────────────────────────────────────────────────
// These model methods have an early-exit when the caller passes an empty Gibbon
// (no bits set). The guards return before opening any database connection, so
// the tests below use a dummy pool and verify the call resolves without error.

const UNIT_CONFIG: Config = {
  dbName: 'test',
  permissionByteLength: 4,
  groupByteLength: 4,
  postgresqlMutationConcurrency: 1,
  dbStructure: {
    user: { tableName: 'users' },
    group: { tableName: 'groups' },
    permission: { tableName: 'permissions' },
  },
};

describe('GibbonUser empty-position guards', () => {
  let user: GibbonUser;

  beforeAll(async () => {
    user = new GibbonUser({} as Pool, 4);
    await user.initialize('test', 'users');
  });

  it('unsetPermissions is a no-op with an empty gibbon', async () => {
    await expect(
      user.unsetPermissions(Gibbon.create(4))
    ).resolves.toBeUndefined();
  });

  it('unsetGroups is a no-op with an empty gibbon', async () => {
    await expect(
      user.unsetGroups(Gibbon.create(4), {} as IPermissionsResource)
    ).resolves.toBeUndefined();
  });

  it('unsubscribeFromGroups is a no-op with empty groups', async () => {
    const where: WhereClause = { sql: 'TRUE', params: [] };
    await expect(
      user.unsubscribeFromGroups(
        where,
        Gibbon.create(4),
        {} as IPermissionsResource
      )
    ).resolves.toBeUndefined();
  });
});

describe('GibbonGroup empty-position guards', () => {
  let group: GibbonGroup;

  beforeAll(async () => {
    group = new GibbonGroup({} as Pool, UNIT_CONFIG);
    await group.initialize('test', 'groups');
  });

  it('unsetPermissions is a no-op with an empty gibbon', async () => {
    await expect(
      group.unsetPermissions(Gibbon.create(4))
    ).resolves.toBeUndefined();
  });

  it('deallocate is a no-op with empty positions', async () => {
    await expect(group.deallocate(Gibbon.create(4))).resolves.toBeUndefined();
  });

  it('subscribePermissions is a no-op with empty groups', async () => {
    await expect(
      group.subscribePermissions(
        Gibbon.create(4),
        Gibbon.create(4).setPosition(1)
      )
    ).resolves.toBeUndefined();
  });

  it('unsubscribePermissions is a no-op with empty groups', async () => {
    await expect(
      group.unsubscribePermissions(
        Gibbon.create(4),
        Gibbon.create(4).setPosition(1)
      )
    ).resolves.toBeUndefined();
  });

  it('unsubscribePermissions is a no-op with empty permissions', async () => {
    await expect(
      group.unsubscribePermissions(
        Gibbon.create(4).setPosition(1),
        Gibbon.create(4)
      )
    ).resolves.toBeUndefined();
  });
});

describe('GibbonPermission empty-position guards', () => {
  let permission: GibbonPermission;

  beforeAll(async () => {
    permission = new GibbonPermission({} as Pool, UNIT_CONFIG);
    await permission.initialize('test', 'permissions');
  });

  it('deallocate is a no-op with empty positions', async () => {
    await expect(
      permission.deallocate(Gibbon.create(4))
    ).resolves.toBeUndefined();
  });

  it('validate returns false with empty positions', async () => {
    await expect(permission.validate(Gibbon.create(4))).resolves.toBe(false);
  });
});
