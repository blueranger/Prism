import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'prism.db');

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_model TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      token_count INTEGER,
      handoff_id TEXT,
      handoff_from TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_model TEXT NOT NULL,
      to_model TEXT NOT NULL,
      instruction TEXT,
      summary TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_handoffs_session
      ON handoffs(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_timestamp INTEGER NOT NULL,
      to_timestamp INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      original_token_count INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_summaries_session
      ON summaries(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT,
      created_by TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      parent_version INTEGER,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_session
      ON artifacts(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_session
      ON agent_tasks(session_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      success INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_execution_log_session
      ON execution_log(session_id, started_at);

    CREATE INDEX IF NOT EXISTS idx_execution_log_task
      ON execution_log(task_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      preview TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS session_links (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      linked_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, linked_session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_links_session ON session_links(session_id);

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'preference',
      content TEXT NOT NULL,
      model TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_active ON decisions(active, updated_at DESC);

    -- Phase 6: Communication Tools Integration

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      config TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_threads (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      session_id TEXT,
      display_name TEXT NOT NULL,
      subject TEXT,
      sender_name TEXT,
      sender_email TEXT,
      is_group INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      last_message_at INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_threads_provider
      ON external_threads(provider, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS external_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      external_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_email TEXT,
      subject TEXT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      is_inbound INTEGER DEFAULT 1,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_messages_thread
      ON external_messages(thread_id, timestamp);

    CREATE TABLE IF NOT EXISTS reply_learning (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      context_message TEXT NOT NULL,
      user_reply TEXT NOT NULL,
      tone TEXT,
      reply_length_chars INTEGER,
      contains_question INTEGER DEFAULT 0,
      contains_action_item INTEGER DEFAULT 0,
      was_edited_from_draft INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reply_learning_sender
      ON reply_learning(provider, sender_id);

    CREATE TABLE IF NOT EXISTS monitor_rules (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'all',
      rule_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      conditions TEXT NOT NULL,
      action TEXT NOT NULL,
      action_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_rules_enabled
      ON monitor_rules(enabled, provider);

    CREATE TABLE IF NOT EXISTS draft_replies (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      draft_content TEXT NOT NULL,
      model_used TEXT NOT NULL,
      tone TEXT,
      instruction TEXT,
      status TEXT DEFAULT 'pending',
      triggered_by TEXT,
      sent_at INTEGER,
      user_edit TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_draft_replies_thread
      ON draft_replies(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_draft_replies_status
      ON draft_replies(status);

    CREATE TABLE IF NOT EXISTS graph_subscriptions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      expiration INTEGER NOT NULL,
      client_state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_graph_subscriptions_provider
      ON graph_subscriptions(provider);

    -- Phase 7a: Import Engine

    CREATE TABLE IF NOT EXISTS imported_conversations (
      id TEXT PRIMARY KEY,
      source_platform TEXT NOT NULL,
      original_id TEXT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      message_count INTEGER DEFAULT 0,
      session_id TEXT,
      import_batch_id TEXT NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS imported_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source_model TEXT,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      parent_message_id TEXT,
      metadata TEXT,
      FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_imported_conversations_source ON imported_conversations(source_platform);
    CREATE INDEX IF NOT EXISTS idx_imported_conversations_batch ON imported_conversations(import_batch_id);
    CREATE INDEX IF NOT EXISTS idx_imported_conversations_created ON imported_conversations(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_imported_messages_conversation ON imported_messages(conversation_id, timestamp);

    -- Phase 7b: FTS5 full-text search indexes

    CREATE VIRTUAL TABLE IF NOT EXISTS imported_messages_fts USING fts5(
      content,
      content=imported_messages,
      content_rowid=rowid,
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS imported_conversations_fts USING fts5(
      title,
      content=imported_conversations,
      content_rowid=rowid,
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=rowid,
      tokenize='unicode61'
    );

    -- Phase 7c: Knowledge Graph tables

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at TEXT NOT NULL,
      source TEXT DEFAULT 'auto'
    );

    CREATE TABLE IF NOT EXISTS conversation_tags (
      tag_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      PRIMARY KEY (tag_id, conversation_id),
      FOREIGN KEY (tag_id) REFERENCES tags(id),
      FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id)
    );

    CREATE TABLE IF NOT EXISTS session_tags (
      tag_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      PRIMARY KEY (tag_id, session_id),
      FOREIGN KEY (tag_id) REFERENCES tags(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS knowledge_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      description TEXT,
      aliases TEXT,
      first_seen_at TEXT,
      mention_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id TEXT NOT NULL,
      conversation_id TEXT,
      session_id TEXT,
      mention_count INTEGER DEFAULT 1,
      context_snippet TEXT,
      PRIMARY KEY (entity_id, COALESCE(conversation_id, ''), COALESCE(session_id, '')),
      FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id),
      FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS entity_relations (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id),
      FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_tags_conv ON conversation_tags(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags(session_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_conv ON entity_mentions(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_session ON entity_mentions(session_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_entities_type ON knowledge_entities(entity_type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_entities_name_type ON knowledge_entities(name, entity_type);
  `);

  // FTS sync triggers (created separately since CREATE TRIGGER IF NOT EXISTS
  // inside a big db.exec can fail if some triggers already exist)
  createFtsTriggers(db);

  // Backfill FTS indexes from existing data
  backfillFts(db);

  // Migrate existing tables if columns are missing
  migrateMessages(db);

  // Backfill sessions table from existing messages
  migrateSessionsFromMessages(db);

  // Multi-account connector migration
  migrateMultiAccount(db);

  // Persona + language migration
  migratePersonaAndLanguage(db);

  // Triage agent migration
  migrateTriageAgent(db);
}

/**
 * Create FTS5 sync triggers (idempotent — each trigger is created individually).
 */
function createFtsTriggers(db: Database.Database): void {
  const triggers = [
    // imported_messages_fts
    `CREATE TRIGGER IF NOT EXISTS imported_messages_ai AFTER INSERT ON imported_messages BEGIN
      INSERT INTO imported_messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS imported_messages_ad AFTER DELETE ON imported_messages BEGIN
      INSERT INTO imported_messages_fts(imported_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS imported_messages_au AFTER UPDATE ON imported_messages BEGIN
      INSERT INTO imported_messages_fts(imported_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO imported_messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END`,
    // imported_conversations_fts
    `CREATE TRIGGER IF NOT EXISTS imported_conversations_ai AFTER INSERT ON imported_conversations BEGIN
      INSERT INTO imported_conversations_fts(rowid, title) VALUES (new.rowid, new.title);
    END`,
    `CREATE TRIGGER IF NOT EXISTS imported_conversations_ad AFTER DELETE ON imported_conversations BEGIN
      INSERT INTO imported_conversations_fts(imported_conversations_fts, rowid, title) VALUES('delete', old.rowid, old.title);
    END`,
    `CREATE TRIGGER IF NOT EXISTS imported_conversations_au AFTER UPDATE ON imported_conversations BEGIN
      INSERT INTO imported_conversations_fts(imported_conversations_fts, rowid, title) VALUES('delete', old.rowid, old.title);
      INSERT INTO imported_conversations_fts(rowid, title) VALUES (new.rowid, new.title);
    END`,
    // messages_fts
    `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END`,
  ];

  for (const sql of triggers) {
    try { db.exec(sql); } catch {}
  }
}

/**
 * Backfill FTS indexes from existing data using 'rebuild' command.
 * For content-sync'd FTS5 tables, 'rebuild' re-reads the content table
 * and rebuilds the full-text index — this is the correct way to backfill.
 * Safe to run multiple times (rebuild is idempotent).
 */
function backfillFts(db: Database.Database): void {
  try {
    const importedMsgCount = (db.prepare('SELECT COUNT(*) as c FROM imported_messages').get() as any).c;
    if (importedMsgCount > 0) {
      db.exec("INSERT INTO imported_messages_fts(imported_messages_fts) VALUES('rebuild')");
    }

    const importedConvCount = (db.prepare('SELECT COUNT(*) as c FROM imported_conversations').get() as any).c;
    if (importedConvCount > 0) {
      db.exec("INSERT INTO imported_conversations_fts(imported_conversations_fts) VALUES('rebuild')");
    }

    const msgCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
    if (msgCount > 0) {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    }
  } catch (err) {
    console.warn('[db] FTS backfill warning:', err);
  }
}

function migrateMessages(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('token_count')) {
    db.exec('ALTER TABLE messages ADD COLUMN token_count INTEGER');
  }
  if (!colNames.has('handoff_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN handoff_id TEXT');
  }
  if (!colNames.has('handoff_from')) {
    db.exec('ALTER TABLE messages ADD COLUMN handoff_from TEXT');
  }
  if (!colNames.has('mode')) {
    db.exec("ALTER TABLE messages ADD COLUMN mode TEXT DEFAULT 'parallel'");
  }
}

function getColumnNames(db: Database.Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(cols.map((c) => c.name));
}

/**
 * Multi-account connector migration.
 * Adds account_id, connector_type, display_name, email columns
 * and recreates tables with updated UNIQUE constraints.
 */
function migrateMultiAccount(db: Database.Database): void {
  // --- Add new columns (safe for SQLite, idempotent via column check) ---

  const connectorCols = getColumnNames(db, 'connectors');
  if (!connectorCols.has('connector_type')) {
    db.exec("ALTER TABLE connectors ADD COLUMN connector_type TEXT");
  }
  if (!connectorCols.has('display_name')) {
    db.exec("ALTER TABLE connectors ADD COLUMN display_name TEXT");
  }
  if (!connectorCols.has('email')) {
    db.exec("ALTER TABLE connectors ADD COLUMN email TEXT");
  }

  const threadCols = getColumnNames(db, 'external_threads');
  if (!threadCols.has('account_id')) {
    db.exec("ALTER TABLE external_threads ADD COLUMN account_id TEXT");
  }

  const messageCols = getColumnNames(db, 'external_messages');
  if (!messageCols.has('account_id')) {
    db.exec("ALTER TABLE external_messages ADD COLUMN account_id TEXT");
  }

  const draftCols = getColumnNames(db, 'draft_replies');
  if (!draftCols.has('account_id')) {
    db.exec("ALTER TABLE draft_replies ADD COLUMN account_id TEXT");
  }

  const graphSubCols = getColumnNames(db, 'graph_subscriptions');
  if (!graphSubCols.has('account_id')) {
    db.exec("ALTER TABLE graph_subscriptions ADD COLUMN account_id TEXT");
  }

  // --- Recreate tables to change UNIQUE constraints ---
  // external_threads: UNIQUE(provider, external_id) → UNIQUE(account_id, external_id)

  // Check if migration already done by checking if the unique index references account_id
  const threadIndexes = db.prepare("PRAGMA index_list('external_threads')").all() as any[];
  const needsThreadMigration = threadIndexes.some((idx: any) => {
    if (!idx.unique) return false;
    const info = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[];
    const colNames = info.map((c: any) => c.name);
    return colNames.includes('provider') && colNames.includes('external_id') && !colNames.includes('account_id');
  });

  if (needsThreadMigration) {
    const txn = db.transaction(() => {
      db.exec(`
        CREATE TABLE external_threads_new (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          account_id TEXT,
          external_id TEXT NOT NULL,
          session_id TEXT,
          display_name TEXT NOT NULL,
          subject TEXT,
          sender_name TEXT,
          sender_email TEXT,
          is_group INTEGER DEFAULT 0,
          message_count INTEGER DEFAULT 0,
          last_message_at INTEGER,
          last_synced_at INTEGER,
          created_at INTEGER NOT NULL,
          UNIQUE(account_id, external_id)
        );
        INSERT INTO external_threads_new
          SELECT id, provider, account_id, external_id, session_id, display_name, subject,
                 sender_name, sender_email, is_group, message_count, last_message_at,
                 last_synced_at, created_at
          FROM external_threads;
        DROP TABLE external_threads;
        ALTER TABLE external_threads_new RENAME TO external_threads;
        CREATE INDEX IF NOT EXISTS idx_external_threads_provider
          ON external_threads(provider, last_message_at DESC);
        CREATE INDEX IF NOT EXISTS idx_external_threads_account
          ON external_threads(account_id, last_message_at DESC);
      `);
    });
    txn();
  }

  // external_messages: UNIQUE(provider, external_id) → UNIQUE(account_id, external_id)
  const msgIndexes = db.prepare("PRAGMA index_list('external_messages')").all() as any[];
  const needsMsgMigration = msgIndexes.some((idx: any) => {
    if (!idx.unique) return false;
    const info = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as any[];
    const colNames = info.map((c: any) => c.name);
    return colNames.includes('provider') && colNames.includes('external_id') && !colNames.includes('account_id');
  });

  if (needsMsgMigration) {
    const txn = db.transaction(() => {
      db.exec(`
        CREATE TABLE external_messages_new (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          account_id TEXT,
          external_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          sender_name TEXT NOT NULL,
          sender_email TEXT,
          subject TEXT,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          is_inbound INTEGER DEFAULT 1,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(account_id, external_id)
        );
        INSERT INTO external_messages_new
          SELECT id, thread_id, provider, account_id, external_id, sender_id, sender_name,
                 sender_email, subject, content, timestamp, is_inbound, metadata, created_at
          FROM external_messages;
        DROP TABLE external_messages;
        ALTER TABLE external_messages_new RENAME TO external_messages;
        CREATE INDEX IF NOT EXISTS idx_external_messages_thread
          ON external_messages(thread_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_external_messages_account
          ON external_messages(account_id, timestamp);
      `);
    });
    txn();
  }

  // --- Backfill account_id from connectors table ---
  db.exec(`
    UPDATE external_threads SET account_id = (
      SELECT id FROM connectors WHERE provider = external_threads.provider AND active = 1
      ORDER BY updated_at DESC LIMIT 1
    ) WHERE account_id IS NULL;

    UPDATE external_messages SET account_id = (
      SELECT id FROM connectors WHERE provider = external_messages.provider AND active = 1
      ORDER BY updated_at DESC LIMIT 1
    ) WHERE account_id IS NULL;

    UPDATE draft_replies SET account_id = (
      SELECT id FROM connectors WHERE provider = draft_replies.provider AND active = 1
      ORDER BY updated_at DESC LIMIT 1
    ) WHERE account_id IS NULL;

    UPDATE graph_subscriptions SET account_id = (
      SELECT id FROM connectors WHERE provider = graph_subscriptions.provider AND active = 1
      ORDER BY updated_at DESC LIMIT 1
    ) WHERE account_id IS NULL;
  `);
}

/**
 * Add persona column to connectors and language column to draft_replies.
 */
function migratePersonaAndLanguage(db: Database.Database): void {
  const connectorCols = getColumnNames(db, 'connectors');
  if (!connectorCols.has('persona')) {
    db.exec('ALTER TABLE connectors ADD COLUMN persona TEXT');
  }

  const draftCols = getColumnNames(db, 'draft_replies');
  if (!draftCols.has('language')) {
    db.exec('ALTER TABLE draft_replies ADD COLUMN language TEXT');
  }
}

/**
 * Add triage_results table and triage settings columns to connectors.
 */
function migrateTriageAgent(db: Database.Database): void {
  // Create triage_results table
  db.exec(`
    CREATE TABLE IF NOT EXISTS triage_results (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      sender_role TEXT,
      importance TEXT,
      is_commercial INTEGER DEFAULT 0,
      suggested_action TEXT,
      reasoning TEXT,
      draft_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_triage_results_account
      ON triage_results(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_triage_results_thread
      ON triage_results(thread_id);
  `);

  // Add triage columns to connectors table
  const connectorCols = getColumnNames(db, 'connectors');
  if (!connectorCols.has('triage_enabled')) {
    db.exec('ALTER TABLE connectors ADD COLUMN triage_enabled INTEGER DEFAULT 0');
  }
  if (!connectorCols.has('triage_filter_commercial')) {
    db.exec('ALTER TABLE connectors ADD COLUMN triage_filter_commercial INTEGER DEFAULT 1');
  }
  if (!connectorCols.has('triage_auto_instruction')) {
    db.exec('ALTER TABLE connectors ADD COLUMN triage_auto_instruction TEXT');
  }
}

/**
 * If sessions table is empty but messages has data, backfill session rows
 * derived from existing messages.
 */
function migrateSessionsFromMessages(db: Database.Database): void {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number };
  if (count.cnt > 0) return;

  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
  if (msgCount.cnt === 0) return;

  const sessions = db.prepare(`
    SELECT session_id,
           MIN(timestamp) as created_at,
           MAX(timestamp) as updated_at
    FROM messages
    GROUP BY session_id
  `).all() as { session_id: string; created_at: number; updated_at: number }[];

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, preview) VALUES (?, ?, ?, ?, ?)'
  );

  const previewStmt = db.prepare(
    `SELECT content FROM messages
     WHERE session_id = ? AND role = 'user'
     ORDER BY timestamp ASC LIMIT 1`
  );

  const txn = db.transaction(() => {
    for (const s of sessions) {
      const firstUser = previewStmt.get(s.session_id) as { content: string } | undefined;
      const preview = firstUser ? firstUser.content.slice(0, 100) : null;
      insertStmt.run(s.session_id, null, s.created_at, s.updated_at, preview);
    }
  });
  txn();
}
