import { describe, expect, it } from 'vitest';
import { quoteIdent, splitIdent } from './sql.js';

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
