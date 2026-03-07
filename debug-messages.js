// Quick diagnostic script: check DB state for threads and messages
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'apps/api/prism.db');
let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  // Try alternate location
  try {
    db = new Database(path.join(__dirname, 'prism.db'), { readonly: true });
  } catch (e2) {
    console.error('Cannot find prism.db. Tried:', dbPath, 'and', path.join(__dirname, 'prism.db'));
    process.exit(1);
  }
}

console.log('=== CONNECTORS ===');
const connectors = db.prepare('SELECT id, provider, connector_type, email, active FROM connectors WHERE active = 1').all();
console.table(connectors);

console.log('\n=== THREAD COUNT BY ACCOUNT ===');
const threadCounts = db.prepare(`
  SELECT account_id, COUNT(*) as thread_count
  FROM external_threads
  GROUP BY account_id
`).all();
console.table(threadCounts);

console.log('\n=== MESSAGE COUNT BY ACCOUNT ===');
const msgCounts = db.prepare(`
  SELECT account_id, COUNT(*) as msg_count
  FROM external_messages
  GROUP BY account_id
`).all();
console.table(msgCounts);

console.log('\n=== SAMPLE: First 3 threads with message counts ===');
const threads = db.prepare(`
  SELECT t.id, t.account_id, t.subject, t.message_count,
    (SELECT COUNT(*) FROM external_messages m WHERE m.thread_id = t.id) as actual_msg_count
  FROM external_threads t
  ORDER BY t.last_message_at DESC
  LIMIT 3
`).all();
console.table(threads);

console.log('\n=== SAMPLE: First 3 messages ===');
const msgs = db.prepare(`
  SELECT id, thread_id, account_id, sender_name, subject,
    LENGTH(content) as content_length, timestamp
  FROM external_messages
  ORDER BY timestamp DESC
  LIMIT 3
`).all();
console.table(msgs);

if (msgs.length === 0) {
  console.log('\n⚠️  NO MESSAGES IN DATABASE! Threads exist but messages were not stored.');
  console.log('This means fetchInboxMessagesForAccount() AppleScript might be returning empty content.');
}

db.close();
