#!/usr/bin/env npx tsx
/**
 * Test the new parseConversationArray with name resolution.
 * Shows the final parsed chat list as Prism would display it.
 */

import { connectToTeams, readChatList, disconnectTeams } from '../services/teams-puppeteer';
import { sharedBrowser } from '../services/shared-browser';

async function main() {
  console.log('Connecting to Teams...\n');
  await connectToTeams();

  // If no token, reload
  const { getCachedAuthToken } = await import('../services/teams-puppeteer');
  if (!getCachedAuthToken()) {
    console.log('No token, reloading...');
    const page = sharedBrowser.getPage('teams');
    if (page) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  console.log('\n--- Calling readChatList() ---\n');
  const chats = await readChatList();

  console.log(`\nTotal parsed chats: ${chats.length}`);

  // Split by type
  const meetings = chats.filter(c => c.id.includes('meeting_'));
  const regular = chats.filter(c => !c.id.includes('meeting_'));
  const unresolved = chats.filter(c => c.name.match(/^Chat \d+$/));

  console.log(`  Regular chats: ${regular.length}`);
  console.log(`  Meeting chats: ${meetings.length}`);
  console.log(`  Unresolved names: ${unresolved.length}\n`);

  console.log('=== First 25 Regular Chats (sorted by recency) ===\n');
  for (const c of regular.slice(0, 25)) {
    const timeShort = c.time ? c.time.split('T')[0] : 'no-date';
    const preview = c.lastMessage ? c.lastMessage.slice(0, 50) : '';
    console.log(`  [${c.index}] "${c.name}" (group=${c.isGroup}) ${timeShort}`);
    if (preview) console.log(`      └─ ${preview}`);
  }

  if (unresolved.length > 0) {
    console.log(`\n=== Unresolved "Chat N" entries ===\n`);
    for (const c of unresolved) {
      console.log(`  [${c.index}] "${c.name}" id=${c.id.slice(0, 50)}...`);
    }
  }

  console.log(`\n=== First 10 Meeting Chats ===\n`);
  for (const c of meetings.slice(0, 10)) {
    const timeShort = c.time ? c.time.split('T')[0] : 'no-date';
    console.log(`  [${c.index}] "${c.name}" ${timeShort}`);
  }

  await disconnectTeams();
  console.log('\nDone.');
}

main().catch(console.error);
