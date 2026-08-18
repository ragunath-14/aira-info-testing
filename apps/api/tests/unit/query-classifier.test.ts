import { describe, expect, it } from 'vitest';
import {
  classify,
  isDestructive,
  isReadOnly,
  splitStatements,
  stripLiteralsAndComments,
} from '../../src/providers/databases/query-classifier.js';

/**
 * The classifier is the gate that decides whether a statement may run at all
 * (spec sections 22, 23), so these tests focus on the ways an attacker or a
 * distracted operator could get a write past a READ classification.
 */

describe('stripLiteralsAndComments', () => {
  it('removes line comments but leaves the statement itself intact', () => {
    // Literals are only neutralised, not placeholdered — that is redactSqlLiterals'
    // job, and it runs on the history path rather than here.
    expect(stripLiteralsAndComments('SELECT 1 -- DROP TABLE users').trim()).toBe('SELECT 1');
  });

  it('removes block comments, including nested ones', () => {
    const stripped = stripLiteralsAndComments('SELECT /* outer /* inner */ still */ 1');
    expect(stripped).not.toContain('inner');
    expect(stripped).toContain('SELECT');
  });

  it('neutralises string literals so keywords inside them are inert', () => {
    const stripped = stripLiteralsAndComments("SELECT 'DROP TABLE users' AS payload");
    expect(stripped).not.toContain('DROP TABLE users');
  });

  it('handles escaped quotes without losing the rest of the statement', () => {
    const stripped = stripLiteralsAndComments("SELECT 'it''s fine' AS quote, id FROM t");
    expect(stripped).toContain('FROM t');
  });

  it('neutralises dollar-quoted blocks', () => {
    const stripped = stripLiteralsAndComments('SELECT $$ DROP TABLE users $$ AS body');
    expect(stripped).not.toContain('DROP TABLE users');
  });

  it('neutralises quoted identifiers', () => {
    const stripped = stripLiteralsAndComments('SELECT "drop table" FROM t');
    expect(stripped).not.toContain('drop table');
  });
});

describe('splitStatements', () => {
  it('splits on semicolons and drops empties', () => {
    expect(splitStatements('SELECT 1; SELECT 2;;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe('classify — reads', () => {
  it.each([
    'SELECT * FROM customers LIMIT 10',
    'select id from orders',
    'EXPLAIN SELECT * FROM t',
    'SHOW search_path',
    'TABLE customers',
    'VALUES (1), (2)',
    'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
  ])('classifies %s as READ', (sql) => {
    expect(classify(sql).classification).toBe('READ');
  });

  it('treats a comment-only DROP as READ because it never executes', () => {
    expect(classify('SELECT 1 /* DROP TABLE users */').classification).toBe('READ');
  });
});

describe('classify — writes and schema changes', () => {
  it.each([
    ['INSERT INTO t (a) VALUES (1)', 'WRITE'],
    ['UPDATE t SET a = 1', 'WRITE'],
    ['DELETE FROM t WHERE id = 1', 'WRITE'],
    ['COPY t FROM STDIN', 'WRITE'],
    ['CREATE TABLE t (id int)', 'DDL'],
    ['ALTER TABLE t ADD COLUMN b int', 'DDL'],
    ['DROP TABLE t', 'DESTRUCTIVE'],
    ['TRUNCATE t', 'DESTRUCTIVE'],
  ])('classifies %s as %s', (sql, expected) => {
    expect(classify(sql).classification).toBe(expected);
  });

  it('classifies a writing CTE as WRITE, not READ', () => {
    const result = classify('WITH removed AS (DELETE FROM t RETURNING *) SELECT * FROM removed');
    expect(result.classification).toBe('WRITE');
  });

  it('classifies a destructive CTE as DESTRUCTIVE', () => {
    expect(
      classify('WITH x AS (SELECT 1) SELECT 1; DROP TABLE users').classification,
    ).toBe('DESTRUCTIVE');
  });

  it('sees through a comment inserted between DROP and TABLE', () => {
    expect(classify('DROP/**/TABLE users').classification).toBe('DESTRUCTIVE');
  });
});

describe('classify — the strictest statement wins', () => {
  it('escalates a batch to its most dangerous member', () => {
    const result = classify('SELECT 1; DELETE FROM t');
    expect(result.classification).toBe('WRITE');
    expect(result.multiStatement).toBe(true);
    expect(result.statements).toHaveLength(2);
  });

  it('does not let a recognised statement downgrade an unknown one', () => {
    expect(classify('SELECT 1; GRANT ALL ON t TO bob').classification).toBe('UNKNOWN');
  });

  it('can reject multi-statement submissions outright', () => {
    const result = classify('SELECT 1; SELECT 2', { rejectMultiStatement: true });
    expect(result.classification).toBe('UNKNOWN');
  });
});

describe('classify — refuses privilege and filesystem access', () => {
  it.each([
    'GRANT ALL ON t TO bob',
    'REVOKE SELECT ON t FROM bob',
    'SET ROLE postgres',
    'ALTER SYSTEM SET log_statement = none',
    'CREATE ROLE attacker LOGIN SUPERUSER',
    'ALTER ROLE postgres PASSWORD $$x$$',
    'DO $$ BEGIN PERFORM 1; END $$',
    'CALL some_procedure()',
    'VACUUM FULL t',
    'CHECKPOINT',
    'LOCK TABLE t',
    'COMMIT',
  ])('refuses %s as UNKNOWN', (sql) => {
    expect(classify(sql).classification).toBe('UNKNOWN');
  });

  it.each([
    "SELECT pg_read_file('/etc/passwd')",
    'SELECT pg_ls_dir($$/$$)',
    'SELECT lo_import($$/etc/shadow$$)',
    'SELECT pg_terminate_backend(1)',
    'SELECT pg_sleep(100)',
  ])('refuses filesystem or control function %s', (sql) => {
    const result = classify(sql);
    expect(result.classification).toBe('UNKNOWN');
    expect(result.notes.join(' ')).toMatch(/not permitted/i);
  });

  it('does not flag a column whose name merely contains a forbidden function name', () => {
    // "dblinks" is a plausible column name; only a call should be refused.
    expect(classify('SELECT dblinks FROM t').classification).toBe('READ');
  });
});

describe('classify — EXPLAIN ANALYZE executes what it wraps', () => {
  it('inherits the wrapped classification', () => {
    expect(classify('EXPLAIN ANALYZE DELETE FROM t').classification).toBe('WRITE');
    expect(classify('EXPLAIN (ANALYZE, VERBOSE) UPDATE t SET a = 1').classification).toBe('WRITE');
  });

  it('leaves a plain EXPLAIN as READ', () => {
    expect(classify('EXPLAIN DELETE FROM t').classification).toBe('READ');
  });
});

describe('classify — empty and unrecognised input', () => {
  it('treats an empty statement as UNKNOWN with an explanation', () => {
    const result = classify('   ');
    expect(result.classification).toBe('UNKNOWN');
    expect(result.notes[0]).toMatch(/no executable statement/i);
  });

  it('treats a nonsense verb as UNKNOWN', () => {
    expect(classify('FLARGLE t').classification).toBe('UNKNOWN');
  });
});

describe('helpers', () => {
  it('isReadOnly is true only for READ', () => {
    expect(isReadOnly('READ')).toBe(true);
    expect(isReadOnly('WRITE')).toBe(false);
    expect(isReadOnly('UNKNOWN')).toBe(false);
  });

  it('isDestructive flags only DESTRUCTIVE', () => {
    expect(isDestructive('DESTRUCTIVE')).toBe(true);
    expect(isDestructive('DDL')).toBe(false);
  });
});
