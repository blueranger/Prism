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
      handoff_from TEXT,
      mode TEXT DEFAULT 'parallel',
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      reasoning_tokens INTEGER,
      cached_tokens INTEGER,
      estimated_cost_usd REAL,
      pricing_source TEXT
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
      preview TEXT,
      session_type TEXT NOT NULL DEFAULT 'topic',
      parent_session_id TEXT,
      action_type TEXT,
      action_status TEXT,
      action_title TEXT,
      action_target TEXT,
      context_snapshot TEXT,
      result_summary TEXT,
      interaction_mode TEXT,
      active_model TEXT,
      observer_models TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS observer_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      active_model TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      active_message_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      risks TEXT,
      disagreements TEXT,
      suggested_follow_up TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      captured_at INTEGER NOT NULL,
      UNIQUE(session_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_observer_snapshots_session
      ON observer_snapshots(session_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS rich_preview_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      preview_kind TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      selection_start INTEGER,
      selection_end INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      extraction_source TEXT,
      has_leading_text INTEGER NOT NULL DEFAULT 0,
      has_trailing_text INTEGER NOT NULL DEFAULT 0,
      starts_with_tag TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rich_preview_artifacts_session
      ON rich_preview_artifacts(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_lint_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      model TEXT,
      finding_count INTEGER NOT NULL DEFAULT 0,
      findings_json TEXT,
      article_candidates_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_lint_runs_created
      ON wiki_lint_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_compile_plans (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      applied_at INTEGER,
      source_summary TEXT NOT NULL DEFAULT '',
      detected_artifacts_json TEXT NOT NULL DEFAULT '[]',
      items_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      skipped_items_json TEXT NOT NULL DEFAULT '[]',
      errors_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_compile_plans_source
      ON wiki_compile_plans(source_id, source_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_backfill_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      vault_path TEXT NOT NULL,
      model TEXT,
      batch_size INTEGER NOT NULL DEFAULT 10,
      current_batch_size INTEGER NOT NULL DEFAULT 10,
      total_items INTEGER NOT NULL DEFAULT 0,
      processed_items INTEGER NOT NULL DEFAULT 0,
      compiled_count INTEGER NOT NULL DEFAULT 0,
      archived_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      next_batch_number INTEGER NOT NULL DEFAULT 1,
      last_lint_run_id TEXT,
      last_lint_finding_count INTEGER,
      tuning_notes_json TEXT NOT NULL DEFAULT '[]',
      current_conversation_title TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_backfill_jobs_created
      ON wiki_backfill_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS wiki_backfill_job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      platform TEXT NOT NULL,
      project_name TEXT,
      age_bucket TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      recommended_action TEXT NOT NULL,
      selected_action TEXT NOT NULL,
      reasons_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      batch_number INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      file_path TEXT,
      compile_plan_id TEXT,
      applied_item_count INTEGER,
      error TEXT,
      FOREIGN KEY (job_id) REFERENCES wiki_backfill_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wiki_backfill_job_items_job
      ON wiki_backfill_job_items(job_id, status, id);

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

    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      last_confirmed_at INTEGER,
      expires_at INTEGER,
      source_kind TEXT NOT NULL DEFAULT 'assistant_extracted',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_items_type_status
      ON memory_items(memory_type, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_scope
      ON memory_items(scope_type, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_attributes (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_attributes_item
      ON memory_attributes(memory_item_id);

    CREATE TABLE IF NOT EXISTS memory_entity_links (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      entity_id TEXT,
      entity_name TEXT NOT NULL,
      link_role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES knowledge_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entity_links_item
      ON memory_entity_links(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_links_entity
      ON memory_entity_links(entity_id);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      source_entity_id TEXT,
      source_entity_name TEXT NOT NULL,
      target_entity_id TEXT,
      target_entity_name TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      FOREIGN KEY (source_entity_id) REFERENCES knowledge_entities(id),
      FOREIGN KEY (target_entity_id) REFERENCES knowledge_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_item
      ON memory_edges(memory_item_id);

    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      timeline_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_item
      ON memory_events(memory_item_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS llm_usage_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL,
      request_id TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      pricing_version TEXT NOT NULL DEFAULT 'static-v1',
      pricing_source TEXT NOT NULL DEFAULT 'static_registry_estimate',
      workspace_scope TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_events_session
      ON llm_usage_events(session_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_events_provider_month
      ON llm_usage_events(provider, completed_at DESC);

    CREATE TABLE IF NOT EXISTS llm_cost_rollups (
      id TEXT PRIMARY KEY,
      bucket_type TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      mode TEXT,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_cost_rollups_bucket
      ON llm_cost_rollups(bucket_type, bucket_key, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_cost_sync_runs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      month TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_cost_sync_runs_provider_month
      ON provider_cost_sync_runs(provider, month, started_at DESC);

    CREATE TABLE IF NOT EXISTS provider_cost_records (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      month TEXT NOT NULL,
      line_item TEXT NOT NULL,
      amount_usd REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'USD',
      display_status TEXT NOT NULL DEFAULT 'reconciled',
      synced_at INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_provider_cost_records_provider_month
      ON provider_cost_records(provider, month, synced_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS compiler_runs (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_title TEXT NOT NULL,
      destination_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      model TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      graph_updates_count INTEGER NOT NULL DEFAULT 0,
      memory_candidates_count INTEGER NOT NULL DEFAULT 0,
      trigger_candidates_count INTEGER NOT NULL DEFAULT 0,
      concept_count INTEGER NOT NULL DEFAULT 0,
      related_note_count INTEGER NOT NULL DEFAULT 0,
      backlink_suggestion_count INTEGER NOT NULL DEFAULT 0,
      article_candidate_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT,
      artifacts_json TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_compiler_runs_source
      ON compiler_runs(source_id, source_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      conversation_id TEXT,
      provenance_id TEXT,
      excerpt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_sources_item
      ON memory_sources(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_session
      ON memory_sources(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      scope_type TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_kind TEXT NOT NULL DEFAULT 'assistant_extracted',
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
      ON memory_candidates(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      memory_source_id TEXT,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (memory_item_id) REFERENCES memory_items(id) ON DELETE CASCADE,
      FOREIGN KEY (memory_source_id) REFERENCES memory_sources(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_item
      ON memory_embeddings(memory_item_id);

    CREATE TABLE IF NOT EXISTS working_memory_items (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'working',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_message_id TEXT,
      observed_at INTEGER NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_session
      ON working_memory_items(session_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_extraction_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      trigger TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      added_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_session
      ON memory_extraction_runs(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_extraction_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT,
      memory_item_id TEXT,
      title TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES memory_extraction_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_run_items_run
      ON memory_extraction_run_items(run_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS relationship_mentions (
      id TEXT PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      source_entity_name TEXT NOT NULL,
      target_entity_name TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      routing_decision TEXT NOT NULL,
      promotion_reason TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL,
      source_session_id TEXT,
      source_message_id TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_mentions_unique
      ON relationship_mentions(workspace_key, source_entity_name, target_entity_name, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relationship_mentions_routing
      ON relationship_mentions(routing_decision, updated_at DESC);

    CREATE TABLE IF NOT EXISTS memory_usage_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      model TEXT NOT NULL,
      mode TEXT,
      prompt_preview TEXT NOT NULL,
      total_retrieved INTEGER NOT NULL DEFAULT 0,
      total_injected INTEGER NOT NULL DEFAULT 0,
      total_omitted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_usage_runs_session
      ON memory_usage_runs(session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS memory_usage_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      memory_item_id TEXT,
      title TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      summary TEXT,
      confidence REAL,
      source_session_id TEXT,
      source_message_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES memory_usage_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memory_usage_run_items_run
      ON memory_usage_run_items(run_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS trigger_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      source_memory_item_id TEXT,
      source_candidate_id TEXT,
      trigger_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confidence REAL NOT NULL DEFAULT 0.5,
      trigger_at INTEGER,
      delivery_channel TEXT NOT NULL DEFAULT 'web',
      action_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_candidates_status
      ON trigger_candidates(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS trigger_rules (
      id TEXT PRIMARY KEY,
      trigger_candidate_id TEXT,
      trigger_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      trigger_at INTEGER,
      delivery_channel TEXT NOT NULL DEFAULT 'web',
      action_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_rules_status
      ON trigger_rules(status, trigger_at);

    CREATE TABLE IF NOT EXISTS trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_candidate_id TEXT,
      trigger_rule_id TEXT,
      status TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_created
      ON trigger_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS trigger_notifications (
      id TEXT PRIMARY KEY,
      trigger_run_id TEXT,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      deep_link TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_notifications_created
      ON trigger_notifications(created_at DESC);

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
      source_title TEXT,
      title_source TEXT NOT NULL DEFAULT 'source',
      title_locked INTEGER NOT NULL DEFAULT 0,
      title_generated_at TEXT,
      title_last_message_count INTEGER,
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

    CREATE TABLE IF NOT EXISTS import_sync_state (
      conversation_id TEXT PRIMARY KEY,
      source_platform TEXT NOT NULL,
      original_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      last_synced_at TEXT NOT NULL,
      source_updated_at TEXT,
      project_name TEXT,
      workspace_id TEXT,
      workspace_name TEXT,
      account_id TEXT,
      metadata TEXT,
      FOREIGN KEY (conversation_id) REFERENCES imported_conversations(id),
      UNIQUE (source_platform, original_id)
    );

    CREATE INDEX IF NOT EXISTS idx_import_sync_state_source
      ON import_sync_state(source_platform, original_id);
    CREATE INDEX IF NOT EXISTS idx_import_sync_state_last_synced
      ON import_sync_state(last_synced_at DESC);

    CREATE TABLE IF NOT EXISTS import_sync_runs (
      id TEXT PRIMARY KEY,
      source_platform TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      project_name TEXT,
      status TEXT NOT NULL,
      requested_conversations INTEGER NOT NULL DEFAULT 0,
      processed_conversations INTEGER NOT NULL DEFAULT 0,
      imported_conversations INTEGER NOT NULL DEFAULT 0,
      overwritten_conversations INTEGER NOT NULL DEFAULT 0,
      skipped_conversations INTEGER NOT NULL DEFAULT 0,
      failed_conversations INTEGER NOT NULL DEFAULT 0,
      total_messages INTEGER NOT NULL DEFAULT 0,
      batch_count INTEGER NOT NULL DEFAULT 1,
      completed_batch_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_import_sync_runs_updated
      ON import_sync_runs(updated_at DESC);

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
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      conversation_id TEXT,
      session_id TEXT,
      mention_count INTEGER DEFAULT 1,
      context_snippet TEXT,
      UNIQUE (entity_id, conversation_id, session_id),
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

    -- Session Outline / Topic Navigation
    CREATE TABLE IF NOT EXISTS session_outlines (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      sections TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      model_used TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_outlines_session
      ON session_outlines(session_id, source_type);

    CREATE TABLE IF NOT EXISTS session_bootstraps (
      session_id TEXT PRIMARY KEY,
      bootstrap_type TEXT NOT NULL,
      source_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_bootstraps_created
      ON session_bootstraps(created_at DESC);

    -- Phase 7d: Content Provenance Tracking
    CREATE TABLE IF NOT EXISTS content_provenance (
      id TEXT PRIMARY KEY,
      short_code TEXT NOT NULL UNIQUE,
      source_type TEXT NOT NULL,
      session_id TEXT,
      conversation_id TEXT,
      message_id TEXT NOT NULL,
      artifact_id TEXT,
      content_preview TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_model TEXT NOT NULL,
      entities TEXT,
      tags TEXT,
      copied_at INTEGER NOT NULL,
      note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provenance_short_code ON content_provenance(short_code);
    CREATE INDEX IF NOT EXISTS idx_provenance_hash ON content_provenance(content_hash);
    CREATE INDEX IF NOT EXISTS idx_provenance_session ON content_provenance(session_id, copied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provenance_conversation ON content_provenance(conversation_id, copied_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provenance_copied_at ON content_provenance(copied_at DESC);

    -- Phase 8: Notion Integration
    CREATE TABLE IF NOT EXISTS notion_pages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      notion_page_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      content_md TEXT,
      content_hash TEXT,
      last_edited_at INTEGER,
      parent_type TEXT,
      parent_id TEXT,
      icon_emoji TEXT,
      synced_at INTEGER NOT NULL,
      UNIQUE(account_id, notion_page_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notion_pages_account ON notion_pages(account_id);

    CREATE TABLE IF NOT EXISTS context_sources (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'notion_page',
      source_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      attached_at INTEGER NOT NULL,
      attached_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_context_sources_session ON context_sources(session_id);

    CREATE TABLE IF NOT EXISTS web_pages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      root_url TEXT NOT NULL,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      title TEXT,
      host TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      parent_web_page_id TEXT,
      anchor_text TEXT,
      content_text TEXT NOT NULL,
      content_hash TEXT,
      attached_at INTEGER NOT NULL,
      discovered_at INTEGER NOT NULL,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_pages_session ON web_pages(session_id);
    CREATE INDEX IF NOT EXISTS idx_web_pages_root_url ON web_pages(root_url);
    CREATE INDEX IF NOT EXISTS idx_web_pages_normalized_url ON web_pages(normalized_url);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_web_pages_session_normalized_url ON web_pages(session_id, normalized_url);

    -- File Upload + Document Analysis
    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      extracted_text TEXT,
      summary TEXT,
      analyzed_by TEXT,
      error_message TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_session ON uploaded_files(session_id);

    CREATE TABLE IF NOT EXISTS notion_writes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      notion_page_id TEXT NOT NULL,
      page_title TEXT NOT NULL,
      content_preview TEXT NOT NULL,
      written_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'success'
    );
    CREATE INDEX IF NOT EXISTS idx_notion_writes_session ON notion_writes(session_id);

    -- RAG: Text Chunks + Embeddings
    CREATE TABLE IF NOT EXISTS text_chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      session_id TEXT,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_text_chunks_source ON text_chunks(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_text_chunks_session ON text_chunks(session_id);

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS text_chunks_fts USING fts5(
      content,
      content=text_chunks,
      content_rowid=rowid,
      tokenize='unicode61'
    );
  `);

  // FTS sync triggers (created separately since CREATE TRIGGER IF NOT EXISTS
  // inside a big db.exec can fail if some triggers already exist)
  createFtsTriggers(db);

  // Backfill FTS indexes from existing data
  backfillFts(db);

  // Migrate existing tables if columns are missing
  migrateMessages(db);
  migrateRichPreviewArtifacts(db);

  // Backfill sessions table from existing messages
  migrateSessionsFromMessages(db);

  // Prism topic/action session migration
  migratePrismSessions(db);

  // Multi-account connector migration
  migrateMultiAccount(db);

  // Persona + language migration
  migratePersonaAndLanguage(db);

  // Triage agent migration
  migrateTriageAgent(db);

  // Uploaded files metadata migration
  migrateUploadedFilesMetadata(db);

  // Imported conversation title metadata migration
  migrateImportedConversationTitles(db);

  // Observer mode migration
  migrateObserverMode(db);
  migrateStructuredMemory(db);
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
    // text_chunks_fts
    `CREATE TRIGGER IF NOT EXISTS text_chunks_ai AFTER INSERT ON text_chunks BEGIN
      INSERT INTO text_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS text_chunks_ad AFTER DELETE ON text_chunks BEGIN
      INSERT INTO text_chunks_fts(text_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS text_chunks_au AFTER UPDATE ON text_chunks BEGIN
      INSERT INTO text_chunks_fts(text_chunks_fts, rowid, content) VALUES('delete', old.rowid, old.content);
      INSERT INTO text_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
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

    const chunkCount = (db.prepare('SELECT COUNT(*) as c FROM text_chunks').get() as any).c;
    if (chunkCount > 0) {
      db.exec("INSERT INTO text_chunks_fts(text_chunks_fts) VALUES('rebuild')");
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
  if (!colNames.has('prompt_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER');
  }
  if (!colNames.has('completion_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN completion_tokens INTEGER');
  }
  if (!colNames.has('reasoning_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN reasoning_tokens INTEGER');
  }
  if (!colNames.has('cached_tokens')) {
    db.exec('ALTER TABLE messages ADD COLUMN cached_tokens INTEGER');
  }
  if (!colNames.has('estimated_cost_usd')) {
    db.exec('ALTER TABLE messages ADD COLUMN estimated_cost_usd REAL');
  }
  if (!colNames.has('pricing_source')) {
    db.exec("ALTER TABLE messages ADD COLUMN pricing_source TEXT");
  }
}

function migrateRichPreviewArtifacts(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rich_preview_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      preview_kind TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      selection_start INTEGER,
      selection_end INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      extraction_source TEXT,
      has_leading_text INTEGER NOT NULL DEFAULT 0,
      has_trailing_text INTEGER NOT NULL DEFAULT 0,
      starts_with_tag TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rich_preview_artifacts_session
      ON rich_preview_artifacts(session_id, created_at DESC)
  `);
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
 * Add metadata column to uploaded_files (for existing DBs).
 */
function migrateUploadedFilesMetadata(db: Database.Database): void {
  const cols = getColumnNames(db, 'uploaded_files');
  if (!cols.has('metadata')) {
    db.exec('ALTER TABLE uploaded_files ADD COLUMN metadata TEXT');
  }
}

function migrateImportedConversationTitles(db: Database.Database): void {
  const cols = getColumnNames(db, 'imported_conversations');
  if (!cols.has('source_title')) {
    db.exec('ALTER TABLE imported_conversations ADD COLUMN source_title TEXT');
  }
  if (!cols.has('title_source')) {
    db.exec("ALTER TABLE imported_conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'source'");
  }
  if (!cols.has('title_locked')) {
    db.exec('ALTER TABLE imported_conversations ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('title_generated_at')) {
    db.exec('ALTER TABLE imported_conversations ADD COLUMN title_generated_at TEXT');
  }
  if (!cols.has('title_last_message_count')) {
    db.exec('ALTER TABLE imported_conversations ADD COLUMN title_last_message_count INTEGER');
  }

  db.exec(`
    UPDATE imported_conversations
    SET source_title = COALESCE(source_title, title)
    WHERE source_title IS NULL OR TRIM(source_title) = '';
  `);
  db.exec(`
    UPDATE imported_conversations
    SET title_source = COALESCE(NULLIF(title_source, ''), 'source')
    WHERE title_source IS NULL OR TRIM(title_source) = '';
  `);
  db.exec(`
    UPDATE imported_conversations
    SET title_locked = COALESCE(title_locked, 0)
    WHERE title_locked IS NULL;
  `);
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

function migratePrismSessions(db: Database.Database): void {
  const cols = getColumnNames(db, 'sessions');

  if (!cols.has('session_type')) {
    db.exec("ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'topic'");
  }
  if (!cols.has('parent_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  }
  if (!cols.has('action_type')) {
    db.exec('ALTER TABLE sessions ADD COLUMN action_type TEXT');
  }
  if (!cols.has('action_status')) {
    db.exec('ALTER TABLE sessions ADD COLUMN action_status TEXT');
  }
  if (!cols.has('action_title')) {
    db.exec('ALTER TABLE sessions ADD COLUMN action_title TEXT');
  }
  if (!cols.has('action_target')) {
    db.exec('ALTER TABLE sessions ADD COLUMN action_target TEXT');
  }
  if (!cols.has('context_snapshot')) {
    db.exec('ALTER TABLE sessions ADD COLUMN context_snapshot TEXT');
  }
  if (!cols.has('result_summary')) {
    db.exec('ALTER TABLE sessions ADD COLUMN result_summary TEXT');
  }
  if (!cols.has('interaction_mode')) {
    db.exec("ALTER TABLE sessions ADD COLUMN interaction_mode TEXT");
  }
  if (!cols.has('active_model')) {
    db.exec("ALTER TABLE sessions ADD COLUMN active_model TEXT");
  }
  if (!cols.has('observer_models')) {
    db.exec("ALTER TABLE sessions ADD COLUMN observer_models TEXT");
  }

  db.exec("UPDATE sessions SET session_type = 'topic' WHERE session_type IS NULL OR session_type = ''");
  db.exec("UPDATE sessions SET action_status = 'draft' WHERE session_type = 'action' AND (action_status IS NULL OR action_status = '')");
}

function migrateObserverMode(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS observer_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      active_model TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      active_message_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      risks TEXT,
      disagreements TEXT,
      suggested_follow_up TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      captured_at INTEGER NOT NULL,
      UNIQUE(session_id, model)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observer_snapshots_session
    ON observer_snapshots(session_id, captured_at DESC)
  `);
}

function migrateStructuredMemory(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_at INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      last_confirmed_at INTEGER,
      expires_at INTEGER,
      source_kind TEXT NOT NULL DEFAULT 'assistant_extracted',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_attributes (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_entity_links (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      entity_id TEXT,
      entity_name TEXT NOT NULL,
      link_role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      source_entity_id TEXT,
      source_entity_name TEXT NOT NULL,
      target_entity_id TEXT,
      target_entity_name TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      timeline_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      session_id TEXT,
      message_id TEXT,
      conversation_id TEXT,
      provenance_id TEXT,
      excerpt TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      scope_type TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      source_kind TEXT NOT NULL DEFAULT 'assistant_extracted',
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      memory_item_id TEXT NOT NULL,
      memory_source_id TEXT,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_items_type_status
      ON memory_items(memory_type, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_items_scope
      ON memory_items(scope_type, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_attributes_item
      ON memory_attributes(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_links_item
      ON memory_entity_links(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_links_entity
      ON memory_entity_links(entity_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_item
      ON memory_edges(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_events_item
      ON memory_events(memory_item_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_item
      ON memory_sources(memory_item_id);
    CREATE INDEX IF NOT EXISTS idx_memory_sources_session
      ON memory_sources(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_candidates_status
      ON memory_candidates(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_embeddings_item
      ON memory_embeddings(memory_item_id);
    CREATE TABLE IF NOT EXISTS working_memory_items (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'working',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      source_message_id TEXT,
      observed_at INTEGER NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_working_memory_session
      ON working_memory_items(session_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS memory_extraction_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      trigger TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      added_count INTEGER NOT NULL DEFAULT 0,
      duplicate_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_runs_session
      ON memory_extraction_runs(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_extraction_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      candidate_id TEXT,
      memory_item_id TEXT,
      title TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_extraction_run_items_run
      ON memory_extraction_run_items(run_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS relationship_mentions (
      id TEXT PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      source_entity_name TEXT NOT NULL,
      target_entity_name TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      routing_decision TEXT NOT NULL,
      promotion_reason TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at INTEGER NOT NULL,
      source_session_id TEXT,
      source_message_id TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_mentions_unique
      ON relationship_mentions(workspace_key, source_entity_name, target_entity_name, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relationship_mentions_routing
      ON relationship_mentions(routing_decision, updated_at DESC);
    CREATE TABLE IF NOT EXISTS memory_usage_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      model TEXT NOT NULL,
      mode TEXT,
      prompt_preview TEXT NOT NULL,
      total_retrieved INTEGER NOT NULL DEFAULT 0,
      total_injected INTEGER NOT NULL DEFAULT 0,
      total_omitted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_usage_runs_session
      ON memory_usage_runs(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS memory_usage_run_items (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      memory_item_id TEXT,
      title TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      summary TEXT,
      confidence REAL,
      source_session_id TEXT,
      source_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_usage_run_items_run
      ON memory_usage_run_items(run_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS trigger_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      source_memory_item_id TEXT,
      source_candidate_id TEXT,
      trigger_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      confidence REAL NOT NULL DEFAULT 0.5,
      trigger_at INTEGER,
      delivery_channel TEXT NOT NULL DEFAULT 'web',
      action_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_candidates_status
      ON trigger_candidates(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS trigger_rules (
      id TEXT PRIMARY KEY,
      trigger_candidate_id TEXT,
      trigger_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      trigger_at INTEGER,
      delivery_channel TEXT NOT NULL DEFAULT 'web',
      action_json TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_rules_status
      ON trigger_rules(status, trigger_at);
    CREATE TABLE IF NOT EXISTS trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_candidate_id TEXT,
      trigger_rule_id TEXT,
      status TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_created
      ON trigger_runs(created_at DESC);
    CREATE TABLE IF NOT EXISTS trigger_notifications (
      id TEXT PRIMARY KEY,
      trigger_run_id TEXT,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      deep_link TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_notifications_created
      ON trigger_notifications(created_at DESC);
  `);

  const extractionRunItemCols = getColumnNames(db, 'memory_extraction_run_items');
  if (!extractionRunItemCols.has('metadata_json')) {
    db.exec('ALTER TABLE memory_extraction_run_items ADD COLUMN metadata_json TEXT');
  }
}
