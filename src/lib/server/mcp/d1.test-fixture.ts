import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
class Statement {
  private values: SQLQueryBindings[] = [];
  constructor(private database: Database, private sql: string) {}
  bind(...values: SQLQueryBindings[]) { this.values = values; return this; }
  first() { return this.database.query(this.sql).get(...this.values); }
  all() { return { results: this.database.query(this.sql).all(...this.values) }; }
  run() {
    const query = this.database.query(this.sql);
    if (query.columnNames.length) {
      const results = query.all(...this.values);
      return { results, meta: { changes: results.length } };
    }
    return { results: [], meta: { changes: Number(query.run(...this.values).changes) } };
  }
}

export function openMcpTestDatabase() {
  const database = new Database(':memory:');
  database.exec(readFileSync(new URL('../../../../schema.sql', import.meta.url), 'utf8'));
  database.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO workspace_users (id, name, role) VALUES ('owner', 'A', 'Owner'), ('other', 'B', 'Owner');
    INSERT INTO workspace_owner (singleton, user_id) VALUES (1, 'owner');`);
  const db = {
    prepare: (sql: string) => new Statement(database, sql),
    batch: (statements: Statement[]) => database.transaction(() => statements.map((statement) => statement.run()))()
  } as unknown as D1Database;
  return { database, db, [Symbol.dispose]: () => database.close() };
}
