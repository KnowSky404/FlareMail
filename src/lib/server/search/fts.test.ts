import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseMailSearchQuery } from '$lib/domain/mail';
import { buildFtsSearchPlan } from './fts';

describe('safe FTS5 search compiler', () => {
  test('binds phrases under whitelisted columns without accepting user operators', () => {
    const plan = buildFtsSearchPlan(parseMailSearchQuery(
      'incident OR from:"Alice@example.test" subject:"release \"train\"" is:unread has:attachment after:2026-08-01 status:delivered'
    ));
    expect(plan.expression).toBe(
      '("incident" OR "OR") AND from_text : "Alice@example.test" AND subject_text : "release train"'
    );
    expect(plan.hitFields).toEqual(['all', 'from', 'subject', 'state', 'attachment', 'date', 'status']);
  });

  test('executes punctuation and reserved words as data in SQLite FTS5', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE VIRTUAL TABLE search USING fts5(from_text, to_text, cc_text, subject_text, body_text, labels_text, tokenize='unicode61');
      INSERT INTO search VALUES ('alice@example.test', 'ops@example.test', '', 'OR release train', 'incident body', '["Operations"]');
    `);
    for (const query of ['OR', '---', 'from:"alice@example.test"', 'subject:"release train"']) {
      const plan = buildFtsSearchPlan(parseMailSearchQuery(query));
      expect(() => db.query('SELECT rowid FROM search WHERE search MATCH ?').all(plan.expression)).not.toThrow();
    }
    const matching = buildFtsSearchPlan(parseMailSearchQuery('incident from:alice@example.test label:Operations'));
    expect(db.query('SELECT rowid FROM search WHERE search MATCH ?').all(matching.expression)).toEqual([{ rowid: 1 }]);
  });

  test('keeps relational-only searches out of MATCH', () => {
    expect(buildFtsSearchPlan(parseMailSearchQuery('is:trash before:2026-09-01 has:attachment'))).toEqual({
      expression: null,
      hitFields: ['state', 'attachment', 'date']
    });
  });
});
