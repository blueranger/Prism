#!/usr/bin/env npx tsx
/**
 * Debug script: dump all intercepted Teams API calls
 * to find the chat list endpoint pattern.
 *
 * Usage:
 *   cd apps/api
 *   npx tsx src/tests/debug-teams-discovery.ts
 */

import { connectToTeams, getDiscoveryLog, getCacheStatus, readChatList } from '../services/teams-puppeteer';
import { sharedBrowser } from '../services/shared-browser';

async function main() {
  console.log('Connecting to Teams...\n');
  await connectToTeams();

  // Wait a bit longer for Teams to make its chat list API call
  console.log('Waiting 10s for Teams to fetch chat list...\n');
  await new Promise(r => setTimeout(r, 10_000));

  // Try readChatList (triggers a page reload if cache empty)
  const chats = await readChatList();
  console.log(`\nChat list count: ${chats.length}`);
  if (chats.length > 0) {
    console.log('First 5 chats:');
    for (const c of chats.slice(0, 5)) {
      console.log(`  - [${c.id.slice(0, 30)}...] "${c.name}" (group=${c.isGroup})`);
    }
  }

  // Dump discovery log
  const log = getDiscoveryLog();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Discovery Log: ${log.length} entries`);
  console.log(`${'='.repeat(80)}\n`);

  // Group by URL pattern
  const urlGroups = new Map<string, { method: string; url: string; status: number; count: number }>();
  for (const entry of log) {
    // Normalize URL: remove query params, truncate thread IDs
    let key = entry.url.split('?')[0];
    // Replace thread IDs with placeholder
    key = key.replace(/19%3A[a-f0-9-]+(%40|@)[a-z.]+/gi, '{threadId}');
    key = key.replace(/19%3A(meeting_|)[A-Za-z0-9_-]+(%40|@)[a-z.]+/gi, '{threadId}');

    const existing = urlGroups.get(key);
    if (existing) {
      existing.count++;
    } else {
      urlGroups.set(key, { method: entry.method, url: key, status: entry.status, count: 1 });
    }
  }

  // Sort by count descending
  const sorted = [...urlGroups.values()].sort((a, b) => b.count - a.count);

  console.log('Grouped API endpoints (by frequency):\n');
  for (const g of sorted) {
    const tag = g.url.toLowerCase().includes('chat') || g.url.toLowerCase().includes('conversation') || g.url.toLowerCase().includes('thread')
      ? ' ← 💬 CHAT RELATED'
      : '';
    console.log(`  [${g.count}x] ${g.method} ${g.status} ${g.url}${tag}`);
  }

  // Also dump raw entries that might be chat list
  console.log(`\n${'='.repeat(80)}`);
  console.log('All entries containing "chat", "conversation", "thread", or "recent":');
  console.log(`${'='.repeat(80)}\n`);

  const chatRelated = log.filter(e =>
    /chat|conversation|thread|recent|contact/i.test(e.url)
  );

  for (const entry of chatRelated) {
    console.log(`  ${entry.method} ${entry.status} ${entry.url}`);
  }

  // Cache status
  console.log(`\n${'='.repeat(80)}`);
  console.log('Cache Status:');
  console.log(`${'='.repeat(80)}\n`);
  const status = getCacheStatus();
  console.log(JSON.stringify(status, null, 2));

  // Now let's also look at what the Teams page's current URL is
  const teamsPage = sharedBrowser.getPage('teams');
  if (teamsPage) {
    console.log(`\nTeams page URL: ${teamsPage.url()}`);

    // Try to find the chat list from the page's performance entries
    console.log('\nChecking performance.getEntries() for chat list API...\n');
    const perfEntries = await teamsPage.evaluate(`
      (function() {
        var entries = performance.getEntriesByType('resource');
        var chatEntries = [];
        for (var i = 0; i < entries.length; i++) {
          var name = entries[i].name || '';
          if (name.indexOf('chat') > -1 || name.indexOf('conversation') > -1 || name.indexOf('thread') > -1 || name.indexOf('recent') > -1) {
            chatEntries.push({
              name: name.length > 200 ? name.substring(0, 200) + '...' : name,
              type: entries[i].initiatorType,
              duration: Math.round(entries[i].duration),
            });
          }
        }
        return chatEntries;
      })()
    `) as any[];

    console.log(`Performance entries (chat related): ${perfEntries.length}`);
    for (const e of perfEntries) {
      console.log(`  [${e.type}] ${e.duration}ms ${e.name}`);
    }
  }

  // Disconnect
  const { disconnectTeams } = await import('../services/teams-puppeteer');
  await disconnectTeams();

  console.log('\nDone.');
}

main().catch(console.error);
