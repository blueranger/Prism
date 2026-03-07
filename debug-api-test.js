// Test the API endpoint directly
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'apps/api/prism.db');
let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  try {
    db = new Database(path.join(__dirname, 'prism.db'), { readonly: true });
  } catch (e2) {
    console.error('Cannot find prism.db');
    process.exit(1);
  }
}

// Get first thread
const thread = db.prepare('SELECT id, account_id, subject FROM external_threads ORDER BY last_message_at DESC LIMIT 1').get();
console.log('=== FIRST THREAD ===');
console.log(thread);

if (thread) {
  console.log('\n=== MESSAGES FOR THIS THREAD (DB query) ===');
  const msgs = db.prepare('SELECT id, thread_id, account_id, sender_name, LENGTH(content) as len FROM external_messages WHERE thread_id = ?').all(thread.id);
  console.log(`Found ${msgs.length} messages:`);
  console.table(msgs);

  // Now test the HTTP endpoint
  console.log('\n=== TESTING HTTP ENDPOINT ===');
  const url = `http://localhost:3001/api/comm/threads/${thread.id}/messages`;
  console.log('GET', url);

  fetch(url)
    .then(res => {
      console.log('Status:', res.status, res.statusText);
      return res.json();
    })
    .then(data => {
      console.log('Response messages count:', data.messages?.length ?? 'N/A');
      if (data.messages?.length > 0) {
        console.log('First message:', JSON.stringify(data.messages[0], null, 2).slice(0, 500));
      }
      if (data.error) {
        console.log('ERROR:', data.error);
      }
    })
    .catch(err => {
      console.log('FETCH ERROR:', err.message);
      console.log('Is the API server running on port 3001?');
    })
    .finally(() => db.close());
}
