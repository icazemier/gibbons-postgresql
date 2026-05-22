import { describe, expect, it } from 'vitest';
import { buildUserWhere, quoteIdent, splitIdent } from './sql.js';

describe('quoteIdent', () => {
  it('quotes a simple identifier', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('quotes a schema-qualified identifier', () => {
    expect(quoteIdent('gibbons.users')).toBe('"gibbons"."users"');
  });

  it('quotes underscores and digits', () => {
    expect(quoteIdent('gibbon_user_42')).toBe('"gibbon_user_42"');
    expect(quoteIdent('schema_1.table_2')).toBe('"schema_1"."table_2"');
  });

  it('throws on more than one dot', () => {
    expect(() => quoteIdent('a.b.c')).toThrow(/Invalid SQL identifier/);
  });

  it('throws on illegal characters', () => {
    expect(() => quoteIdent('users; DROP TABLE x')).toThrow(
      /Invalid SQL identifier/
    );
    expect(() => quoteIdent('"users"')).toThrow(/Invalid SQL identifier/);
    expect(() => quoteIdent('schema."table"')).toThrow(
      /Invalid SQL identifier/
    );
  });

  it('throws on an empty segment', () => {
    expect(() => quoteIdent('.users')).toThrow(/Invalid SQL identifier/);
    expect(() => quoteIdent('users.')).toThrow(/Invalid SQL identifier/);
    expect(() => quoteIdent('')).toThrow(/Invalid SQL identifier/);
  });
});

describe('splitIdent', () => {
  it('returns table only for an unqualified name', () => {
    expect(splitIdent('users')).toEqual({ table: 'users' });
  });

  it('returns schema + table for a qualified name', () => {
    expect(splitIdent('gibbons.users')).toEqual({
      schema: 'gibbons',
      table: 'users',
    });
  });

  it('throws on illegal input', () => {
    expect(() => splitIdent('a.b.c')).toThrow(/Invalid SQL identifier/);
    expect(() => splitIdent('drop table')).toThrow(/Invalid SQL identifier/);
  });
});

describe('buildUserWhere', () => {
  it('returns TRUE for an empty filter', () => {
    expect(buildUserWhere({})).toEqual({ sql: 'TRUE', params: [] });
  });

  describe('id filter', () => {
    it('compiles a single uuid string', () => {
      const out = buildUserWhere({ id: 'aaaa' });
      expect(out.sql).toBe('id = $1::uuid');
      expect(out.params).toEqual(['aaaa']);
    });

    it('compiles a uuid array shortcut', () => {
      const out = buildUserWhere({ id: ['a', 'b'] });
      expect(out.sql).toBe('id = ANY($1::uuid[])');
      expect(out.params).toEqual([['a', 'b']]);
    });

    it('compiles { in: [...] }', () => {
      const out = buildUserWhere({ id: { in: ['a', 'b'] } });
      expect(out.sql).toBe('id = ANY($1::uuid[])');
      expect(out.params).toEqual([['a', 'b']]);
    });
  });

  describe('metadata operators', () => {
    it('eq via bare-value shorthand', () => {
      const out = buildUserWhere({ metadata: { email: 'a@b.c' } });
      expect(out.sql).toBe(`metadata->>'email' = $1`);
      expect(out.params).toEqual(['a@b.c']);
    });

    it('eq via explicit { eq: ... }', () => {
      const out = buildUserWhere({ metadata: { email: { eq: 'a@b.c' } } });
      expect(out.sql).toBe(`metadata->>'email' = $1`);
      expect(out.params).toEqual(['a@b.c']);
    });

    it('eq with null becomes IS NULL', () => {
      expect(buildUserWhere({ metadata: { foo: null } })).toEqual({
        sql: `metadata->>'foo' IS NULL`,
        params: [],
      });
      expect(buildUserWhere({ metadata: { foo: { eq: null } } })).toEqual({
        sql: `metadata->>'foo' IS NULL`,
        params: [],
      });
    });

    it('ne', () => {
      const out = buildUserWhere({ metadata: { role: { ne: 'admin' } } });
      expect(out.sql).toBe(`(metadata->>'role' IS DISTINCT FROM $1)`);
      expect(out.params).toEqual(['admin']);
    });

    it('ne with null becomes IS NOT NULL', () => {
      expect(buildUserWhere({ metadata: { foo: { ne: null } } })).toEqual({
        sql: `metadata->>'foo' IS NOT NULL`,
        params: [],
      });
    });

    it('in via bare array shorthand', () => {
      const out = buildUserWhere({ metadata: { role: ['admin', 'editor'] } });
      expect(out.sql).toBe(`metadata->>'role' = ANY($1::text[])`);
      expect(out.params).toEqual([['admin', 'editor']]);
    });

    it('in via explicit { in: ... }', () => {
      const out = buildUserWhere({
        metadata: { role: { in: ['admin', 'editor'] } },
      });
      expect(out.sql).toBe(`metadata->>'role' = ANY($1::text[])`);
    });

    it('in with empty array short-circuits to FALSE', () => {
      const out = buildUserWhere({ metadata: { role: { in: [] } } });
      expect(out.sql).toBe('FALSE');
      expect(out.params).toEqual([]);
    });

    it('nin', () => {
      const out = buildUserWhere({
        metadata: { role: { nin: ['banned', 'archived'] } },
      });
      expect(out.sql).toBe(
        `(metadata->>'role' IS NULL OR metadata->>'role' <> ALL($1::text[]))`
      );
      expect(out.params).toEqual([['banned', 'archived']]);
    });

    it('nin with empty array short-circuits to TRUE', () => {
      const out = buildUserWhere({ metadata: { role: { nin: [] } } });
      expect(out.sql).toBe('TRUE');
      expect(out.params).toEqual([]);
    });

    it('like (case-sensitive)', () => {
      const out = buildUserWhere({ metadata: { name: { like: '%foo%' } } });
      expect(out.sql).toBe(`metadata->>'name' LIKE $1`);
      expect(out.params).toEqual(['%foo%']);
    });

    it('ilike (case-insensitive)', () => {
      const out = buildUserWhere({ metadata: { name: { ilike: '%foo%' } } });
      expect(out.sql).toBe(`metadata->>'name' ILIKE $1`);
      expect(out.params).toEqual(['%foo%']);
    });

    it('gt with number coerces both sides to numeric', () => {
      const out = buildUserWhere({ metadata: { age: { gt: 18 } } });
      expect(out.sql).toBe(`(metadata->>'age')::numeric > $1::numeric`);
      expect(out.params).toEqual([18]);
    });

    it('gte with string uses text comparison', () => {
      const out = buildUserWhere({
        metadata: { createdAt: { gte: '2026-01-01' } },
      });
      expect(out.sql).toBe(`metadata->>'createdAt' >= $1`);
      expect(out.params).toEqual(['2026-01-01']);
    });

    it('lt and lte', () => {
      expect(buildUserWhere({ metadata: { x: { lt: 10 } } }).sql).toBe(
        `(metadata->>'x')::numeric < $1::numeric`
      );
      expect(buildUserWhere({ metadata: { x: { lte: 'z' } } }).sql).toBe(
        `metadata->>'x' <= $1`
      );
    });

    it('gt with null throws', () => {
      expect(() => buildUserWhere({ metadata: { x: { gt: null } } })).toThrow(
        /Cannot use operator/
      );
    });

    it('isNull true', () => {
      expect(
        buildUserWhere({ metadata: { deleted_at: { isNull: true } } })
      ).toEqual({
        sql: `metadata->>'deleted_at' IS NULL`,
        params: [],
      });
    });

    it('isNull false', () => {
      expect(
        buildUserWhere({ metadata: { deleted_at: { isNull: false } } })
      ).toEqual({
        sql: `metadata->>'deleted_at' IS NOT NULL`,
        params: [],
      });
    });

    it('combines multiple operators on one key with AND', () => {
      const out = buildUserWhere({
        metadata: { age: { gte: 18, lt: 65 } },
      });
      expect(out.sql).toBe(
        `(metadata->>'age')::numeric >= $1::numeric AND (metadata->>'age')::numeric < $2::numeric`
      );
      expect(out.params).toEqual([18, 65]);
    });

    it('combines multiple metadata keys with AND', () => {
      const out = buildUserWhere({
        metadata: { role: 'admin', active: true },
      });
      expect(out.sql).toBe(
        `metadata->>'role' = $1 AND metadata->>'active' = $2`
      );
      expect(out.params).toEqual(['admin', 'true']);
    });

    it('combines id and metadata', () => {
      const out = buildUserWhere({
        id: 'abc',
        metadata: { role: 'admin' },
      });
      expect(out.sql).toBe(`id = $1::uuid AND metadata->>'role' = $2`);
      expect(out.params).toEqual(['abc', 'admin']);
    });

    it('throws on illegal metadata key', () => {
      expect(() => buildUserWhere({ metadata: { "bad'key": 'x' } })).toThrow(
        /Invalid metadata key/
      );
    });

    it('throws on empty comparator object', () => {
      expect(() => buildUserWhere({ metadata: { foo: {} } })).toThrow(
        /Empty comparator object/
      );
    });
  });

  it('paramOffset shifts placeholders', () => {
    const out = buildUserWhere({ id: 'abc' }, 5);
    expect(out.sql).toBe('id = $6::uuid');
    expect(out.params).toEqual(['abc']);
  });
});
