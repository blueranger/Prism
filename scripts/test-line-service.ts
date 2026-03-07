/**
 * Quick test for the LINE Puppeteer service.
 *
 * Usage:
 *   1. Launch Chrome: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir="$HOME/prism-chrome-profile"
 *   2. Run: npx tsx scripts/test-line-service.ts
 */

import {
  connectToLine,
  isLineConnected,
  readChatList,
  openChat,
  readChatMessages,
  disconnectLine,
} from '../apps/api/src/services/line-puppeteer';

async function main() {
  console.log('=== LINE Service Test ===\n');

  // 1. Connect
  console.log('1. Connecting to LINE...');
  await connectToLine();
  console.log(`   Connected: ${isLineConnected()}\n`);

  // 2. Read chat list
  console.log('2. Reading chat list...');
  const chats = await readChatList();
  console.log(`   Found ${chats.length} chats:\n`);
  for (const chat of chats) {
    const unread = chat.unreadCount > 0 ? ` [${chat.unreadCount} unread]` : '';
    console.log(`   [${chat.index}] ${chat.name} — ${chat.time}${unread}`);
    if (chat.lastMessage) {
      console.log(`       "${chat.lastMessage.substring(0, 80)}"`);
    }
  }

  // 3. Open first chat and read messages
  if (chats.length > 0) {
    console.log(`\n3. Opening first chat: "${chats[0].name}"...`);
    const opened = await openChat(0, chats[0].name);
    console.log(`   Opened: ${opened}`);

    if (opened) {
      console.log('\n4. Reading messages...');
      const messages = await readChatMessages();
      console.log(`   Found ${messages.length} messages:\n`);
      for (const msg of messages.slice(-10)) {
        const who = msg.isMe ? '[Me]' : `[${msg.sender || 'Other'}]`;
        const time = msg.time ? ` (${msg.time})` : '';
        console.log(`   ${who}${time}: ${msg.content.substring(0, 100)}`);
      }
    }
  }

  // Don't disconnect — leave the connection for the API server
  console.log('\n=== Test Complete ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
