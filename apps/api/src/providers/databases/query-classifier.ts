import type { SqlClassification, SqlClassificationResult } from '@airaos/types';

/**
 * SQL classification (spec sections 22, 23).
 *
 * This is the backend gate that decides whether a statement may run at all. Its
 * design rules:
 *
 *  - Fail closed. Anything the classifier does not positively recognise is
 *    UNKNOWN, and UNKNOWN is refused unless a policy explicitly allows it.
 *  - The overall classification is the most dangerous statement in the batch,
 *    so `SELECT 1; DROP TABLE users` classifies as DESTRUCTIVE.
 *  - Comments and string literals are stripped before verb detection, so a DROP
 *    hidden inside a block comment stays READ, while a comment inserted between
 *    DROP and TABLE does not disguise a destructive statement.
 *  - No attempt is made to detect malicious intent inside a legitimate verb.
 *    That is what the read-only session and write windows are for: this
 *    classifier decides *category*, and the policy layer decides *permission*.
 */

const SEVERITY: Record<SqlClassification, number> = {
  READ: 0,
  WRITE: 1,
  DDL: 2,
  DESTRUCTIVE: 3,
  // Ranked highest so an unrecognised statement can never be downgraded by a
  // recognised one appearing alongside it.
  UNKNOWN: 4,
};

/** Leading verbs that only read. */
const READ_VERBS = new Set([
  'SELECT',
  'EXPLAIN',
  'SHOW',
  'WITH', // resolved further below: a CTE can wrap a write
  'TABLE',
  'VALUES',
  'FETCH',
  'CLOSE',
  'DECLARE',
]);

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT', 'COPY']);

const DDL_VERBS = new Set(['CREATE', 'ALTER', 'COMMENT', 'REINDEX', 'CLUSTER', 'REFRESH']);

const DESTRUCTIVE_VERBS = new Set(['DROP', 'TRUNCATE']);

/**
 * Statements that are refused outright regardless of policy: they change server
 * state, escalate privilege, or read the filesystem. None of them belong in an
 * infrastructure console's SQL editor.
 */
const FORBIDDEN_VERBS = new Set([
  'GRANT',
  'REVOKE',
  'SET', // includes SET ROLE / SET SESSION AUTHORIZATION
  'RESET',
  'ALTER SYSTEM',
  'CREATE ROLE',
  'CREATE USER',
  'ALTER ROLE',
  'ALTER USER',
  'DROP ROLE',
  'DROP USER',
  'CREATE EXTENSION',
  'DO',
  'CALL',
  'VACUUM',
  'ANALYZE',
  'CHECKPOINT',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'LOCK',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'START',
  'SAVEPOINT',
  'SECURITY',
  'IMPORT',
  'LOAD',
]);

/** Functions that read or write the server filesystem or issue network calls. */
const FORBIDDEN_FUNCTIONS = [
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_write_file',
  'lo_import',
  'lo_export',
  'dblink',
  'pg_sleep',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_promote',
  'copy_from_program',
];

export interface ClassifyOptions {
  /** Treat multiple statements as an error. Default: allowed, most-severe wins. */
  rejectMultiStatement?: boolean;
}

/**
 * Removes comments and replaces string/identifier literals with placeholders.
 * Verb detection then operates on text where no keyword can be hiding inside a
 * literal, and no literal can be mistaken for a keyword.
 */
export function stripLiteralsAndComments(sql: string): string {
  let output = '';
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    // Line comment.
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      output += ' ';
      continue;
    }
    // Block comment, which PostgreSQL allows to nest.
    if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
          continue;
        }
        index += 1;
      }
      output += ' ';
      continue;
    }
    // Single-quoted string, with '' escaping.
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      output += "''";
      continue;
    }
    // Double-quoted identifier.
    if (char === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      output += '""';
      continue;
    }
    // Dollar-quoted block, e.g. $$ ... $$ or $tag$ ... $tag$.
    if (char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (match) {
        const tag = match[0];
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
        output += ' $$ ';
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

/**
 * Splits on semicolons. Safe to do naively because literals and comments have
 * already been neutralised.
 */
export function splitStatements(stripped: string): string[] {
  return stripped
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function firstWords(statement: string, count: number): string {
  return statement
    .replace(/[()]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(' ')
    .toUpperCase();
}

/** Classifies a single, already-stripped statement. */
function classifyStatement(statement: string): { verb: string | null; classification: SqlClassification; note?: string } {
  const upper = statement.toUpperCase();
  const twoWords = firstWords(statement, 2);
  const threeWords = firstWords(statement, 3);
  const verb = firstWords(statement, 1) || null;

  if (!verb) return { verb: null, classification: 'UNKNOWN' };

  // Multi-word forbidden forms are checked before the single-word verb so
  // "ALTER SYSTEM" is not merely DDL and "CREATE ROLE" is not merely DDL.
  for (const forbidden of FORBIDDEN_VERBS) {
    if (
      forbidden === verb ||
      forbidden === twoWords ||
      forbidden === threeWords
    ) {
      return {
        verb,
        classification: 'UNKNOWN',
        note: `${forbidden} is not permitted through the console SQL editor.`,
      };
    }
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    // Word boundary check avoids flagging a column named e.g. "dblinks".
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(statement)) {
      return {
        verb,
        classification: 'UNKNOWN',
        note: `${fn}() is not permitted: it reaches outside the database.`,
      };
    }
  }

  if (DESTRUCTIVE_VERBS.has(verb)) {
    return { verb, classification: 'DESTRUCTIVE' };
  }

  if (DDL_VERBS.has(verb)) {
    return { verb, classification: 'DDL' };
  }

  if (WRITE_VERBS.has(verb)) {
    return { verb, classification: 'WRITE' };
  }

  if (verb === 'WITH') {
    // A CTE is only READ if nothing inside it writes. `WITH x AS (DELETE ...)`
    // and `WITH x AS (...) INSERT ...` are both writes.
    const hasWrite = /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(upper);
    const hasDestructive = /\b(DROP|TRUNCATE)\b/.test(upper);
    if (hasDestructive) {
      return { verb, classification: 'DESTRUCTIVE', note: 'CTE contains a destructive statement.' };
    }
    if (hasWrite) {
      return { verb, classification: 'WRITE', note: 'CTE contains a data-changing statement.' };
    }
    return { verb, classification: 'READ' };
  }

  if (verb === 'EXPLAIN') {
    // EXPLAIN ANALYZE actually executes the statement, so it inherits the
    // classification of what it wraps.
    if (/^EXPLAIN\s+(\(([^)]*\bANALYZE\b[^)]*)\)|ANALYZE\b)/i.test(statement)) {
      const inner = statement.replace(/^EXPLAIN\s+(\([^)]*\)|ANALYZE(\s+VERBOSE)?)\s*/i, '');
      const innerResult = classifyStatement(inner);
      if (innerResult.classification !== 'READ') {
        return {
          verb,
          classification: innerResult.classification,
          note: 'EXPLAIN ANALYZE executes the statement it wraps.',
        };
      }
    }
    return { verb, classification: 'READ' };
  }

  if (READ_VERBS.has(verb)) {
    return { verb, classification: 'READ' };
  }

  return { verb, classification: 'UNKNOWN' };
}

export function classify(sql: string, options: ClassifyOptions = {}): SqlClassificationResult {
  const stripped = stripLiteralsAndComments(sql);
  const statements = splitStatements(stripped);
  const notes: string[] = [];

  if (statements.length === 0) {
    return {
      classification: 'UNKNOWN',
      statements: [],
      multiStatement: false,
      notes: ['No executable statement found.'],
    };
  }

  const classified = statements.map((statement, index) => {
    const result = classifyStatement(statement);
    if (result.note) notes.push(result.note);
    if (result.classification === 'UNKNOWN' && !result.note) {
      notes.push(
        `Statement ${index + 1} starts with "${result.verb ?? '?'}", which the console does not recognise as a permitted operation.`,
      );
    }
    return {
      // The original text is not returned: it may contain literals. Callers that
      // need the real SQL already have it.
      sql: statement.slice(0, 200),
      verb: result.verb,
      classification: result.classification,
    };
  });

  const multiStatement = classified.length > 1;
  if (multiStatement) {
    notes.push(`${classified.length} statements submitted; the strictest classification applies.`);
  }
  if (multiStatement && options.rejectMultiStatement) {
    return {
      classification: 'UNKNOWN',
      statements: classified,
      multiStatement,
      notes: [...notes, 'Multiple statements are not permitted for this operation.'],
    };
  }

  const classification = classified.reduce<SqlClassification>(
    (worst, entry) => (SEVERITY[entry.classification] > SEVERITY[worst] ? entry.classification : worst),
    'READ',
  );

  return { classification, statements: classified, multiStatement, notes };
}

/** True when the statement only reads, i.e. is safe in read-only mode. */
export function isReadOnly(classification: SqlClassification): boolean {
  return classification === 'READ';
}

/** Statements that require a second look before running, even with permission. */
export function isDestructive(classification: SqlClassification): boolean {
  return classification === 'DESTRUCTIVE';
}
