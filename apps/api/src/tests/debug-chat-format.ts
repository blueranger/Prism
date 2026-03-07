#!/usr/bin/env npx tsx
/**
 * Debug: inspect raw JSON from conversations API
 * to understand the structure for 1:1 chats vs meetings vs groups.
 */

import { connectToTeams, getCachedAuthToken } from '../services/teams-puppeteer';
import { sharedBrowser } from '../services/shared-browser';

async function main() {
  console.log('Connecting to Teams...\n');
  await connectToTeams();

  let token = getCachedAuthToken();

  // If no token, reload page to trigger fresh API calls
  if (!token) {
    console.log('No token yet, reloading Teams page...\n');
    const page = sharedBrowser.getPage('teams');
    if (page) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 8000));
      token = getCachedAuthToken();
    }
  }

  if (!token) {
    console.error('No auth token captured even after reload');
    const { disconnectTeams } = await import('../services/teams-puppeteer');
    await disconnectTeams();
    return;
  }

  // Fetch raw conversations
  const resp = await fetch(
    'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/conversations',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    }
  );

  if (!resp.ok) {
    console.error(`API returned ${resp.status}`);
    return;
  }

  const json = await resp.json();

  // Find the conversations array
  const convos: any[] = json.conversations ?? json.threads ?? json.value ?? json.chats ?? [];
  if (Array.isArray(json) && convos.length === 0) {
    console.log('Root is array');
  }

  console.log(`Total conversations: ${convos.length}`);
  console.log(`Response top-level keys: ${Object.keys(json).join(', ')}\n`);

  // Show first 10 conversations with key fields
  const sample = convos.slice(0, 15);
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    const id = c.id ?? c.threadId ?? '';
    const isMeeting = id.includes('meeting_');
    const threadType = c.threadType ?? c.type ?? c.chatType ?? '';
    const displayName = c.displayName ?? c.topic ?? c.threadProperties?.topic ?? '';
    const memberCount = (c.members ?? c.participants ?? c.threadMembers ?? []).length;
    const members = (c.members ?? c.participants ?? c.threadMembers ?? [])
      .slice(0, 5)
      .map((m: any) => m.displayName ?? m.name ?? m.id ?? '?');

    const lastMsg = c.lastMessage;
    const lastMsgTime = lastMsg?.composetime ?? lastMsg?.originalarrivaltime ?? c.lastModifiedTime ?? '';
    const lastMsgPreview = lastMsg?.content ?? lastMsg?.body?.content ?? lastMsg?.preview ?? '';

    console.log(`--- Conv #${i} ---`);
    console.log(`  id: ${id.slice(0, 60)}...`);
    console.log(`  threadType: "${threadType}"`);
    console.log(`  isMeeting: ${isMeeting}`);
    console.log(`  displayName: "${displayName}"`);
    console.log(`  memberCount: ${memberCount}`);
    console.log(`  members: [${members.join(', ')}]`);
    console.log(`  lastMsgTime: ${lastMsgTime}`);
    console.log(`  lastMsgPreview: ${(lastMsgPreview as string).replace(/<[^>]+>/g, '').slice(0, 80)}`);

    // For 1:1 chats (no displayName, not meeting), dump extra fields
    if (!displayName && !isMeeting) {
      console.log(`  properties: ${JSON.stringify(c.properties ?? {}).slice(0, 300)}`);
      console.log(`  threadProperties: ${JSON.stringify(c.threadProperties ?? {}).slice(0, 300)}`);
      console.log(`  memberProperties: ${JSON.stringify(c.memberProperties ?? {}).slice(0, 300)}`);
      if (c.lastMessage) {
        console.log(`  lastMessage.from: ${JSON.stringify(c.lastMessage.from ?? c.lastMessage.imdisplayname ?? c.lastMessage.creator ?? '').slice(0, 200)}`);
        console.log(`  lastMessage.imdisplayname: ${c.lastMessage.imdisplayname ?? ''}`);
      }
    }

    // Dump all top-level keys for the first conv
    if (i === 0) {
      console.log(`  ALL KEYS: ${Object.keys(c).join(', ')}`);
      console.log(`  FULL JSON (first 1000 chars): ${JSON.stringify(c).slice(0, 1000)}`);
    }
    console.log('');
  }

  // Count by type
  let meetings = 0, oneOnOne = 0, groups = 0, other = 0;
  for (const c of convos) {
    const id = c.id ?? '';
    const tt = c.threadType ?? '';
    if (id.includes('meeting_')) meetings++;
    else if (tt === 'chat' || (c.members?.length === 2)) oneOnOne++;
    else if (tt === 'group' || (c.members?.length > 2)) groups++;
    else other++;
  }
  console.log(`\n=== Summary ===`);
  console.log(`  Meetings: ${meetings}`);
  console.log(`  1:1 chats: ${oneOnOne}`);
  console.log(`  Groups: ${groups}`);
  console.log(`  Other/unknown: ${other}`);

  // Cleanup
  const { disconnectTeams } = await import('../services/teams-puppeteer');
  await disconnectTeams();
  console.log('\nDone.');
}

main().catch(console.error);
