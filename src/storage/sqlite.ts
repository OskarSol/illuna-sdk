import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { IllunaError, validateValue } from "../index.js";
import type { Elements, Value } from "../index.js";
import type { Scope, Storage, StoredState } from "../storage.js";

/** A local persistent file; no separate database service or native npm dependency. */
export function sqliteStorage(filename: string): Storage {
  if (filename !== ":memory:") mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS illuna_definitions (
      app_id TEXT NOT NULL, element_key TEXT NOT NULL, definition_json TEXT NOT NULL,
      PRIMARY KEY (app_id, element_key)
    );
    CREATE TABLE IF NOT EXISTS illuna_values (
      app_id TEXT NOT NULL, user_id TEXT NOT NULL, element_key TEXT NOT NULL,
      value_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (app_id, user_id, element_key)
    );
    CREATE TABLE IF NOT EXISTS illuna_revisions (
      app_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS illuna_migrations (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO illuna_migrations (version) VALUES (1);
  `);
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function read(scope: Scope): StoredState {
    const rows = db.prepare("SELECT element_key, value_json FROM illuna_values WHERE app_id = ? AND user_id = ?").all(scope.appId, scope.userId) as { element_key: string; value_json: string }[];
    const row = db.prepare("SELECT revision FROM illuna_revisions WHERE app_id = ? AND user_id = ?").get(scope.appId, scope.userId) as { revision: number } | undefined;
    return { values: Object.fromEntries(rows.map(r => [r.element_key, JSON.parse(r.value_json)])), revision: row?.revision ?? 0 };
  }
  return {
    initialize(appId: string, elements: Elements) {
      transaction(() => {
        // Fail explicitly on incompatible schema changes; never silently erase user values.
        const saved = db.prepare("SELECT element_key, value_json FROM illuna_values WHERE app_id = ?").all(appId) as { element_key: string; value_json: string }[];
        for (const row of saved) if (Object.hasOwn(elements, row.element_key)) validateValue(elements[row.element_key], JSON.parse(row.value_json));
        const previous = db.prepare("SELECT element_key, definition_json FROM illuna_definitions WHERE app_id = ? ORDER BY element_key").all(appId);
        const next = Object.entries(elements).sort(([a], [b]) => a.localeCompare(b)).map(([element_key, definition]) => ({ element_key, definition_json: JSON.stringify(definition) }));
        if (JSON.stringify(previous) !== JSON.stringify(next)) {
          db.prepare("DELETE FROM illuna_definitions WHERE app_id = ?").run(appId);
          const insert = db.prepare("INSERT INTO illuna_definitions VALUES (?, ?, ?)");
          for (const row of next) insert.run(appId, row.element_key, row.definition_json);
          db.prepare("UPDATE illuna_revisions SET revision = revision + 1 WHERE app_id = ?").run(appId);
        }
      });
    },
    read(scope) { return transaction(() => read(scope)); },
    commit(scope, expectedRevision, changes) {
      return transaction(() => {
        const current = read(scope);
        if (current.revision !== expectedRevision) throw new IllunaError("CONFLICT", "Values changed while this request was running. Refresh and try again.", 409);
        if (!Object.keys(changes).length) return current;
        const upsert = db.prepare("INSERT INTO illuna_values VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, user_id, element_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at");
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) db.prepare("DELETE FROM illuna_values WHERE app_id = ? AND user_id = ? AND element_key = ?").run(scope.appId, scope.userId, key);
          else upsert.run(scope.appId, scope.userId, key, JSON.stringify(value), new Date().toISOString());
        }
        db.prepare("INSERT INTO illuna_revisions VALUES (?, ?, 1) ON CONFLICT(app_id, user_id) DO UPDATE SET revision = revision + 1").run(scope.appId, scope.userId);
        return read(scope);
      });
    },
    close() { db.close(); },
  };
}
