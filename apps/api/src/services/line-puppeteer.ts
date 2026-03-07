/**
 * LINE Chrome Extension automation via Puppeteer.
 *
 * Connects to a Chrome instance running with --remote-debugging-port=9222
 * that has the LINE Chrome Extension installed and logged in.
 *
 * Reads chat list and messages from the LINE Extension DOM,
 * and can send messages by typing into the input field.
 *
 * Prerequisites:
 *   Chrome launched with:
 *     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *       --remote-debugging-port=9222 \
 *       --user-data-dir="$HOME/prism-chrome-profile"
 *   LINE Extension installed and logged in.
 */

import type { Page } from 'puppeteer-core';
import { sharedBrowser } from './shared-browser';

const LINE_EXTENSION_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc';
const LINE_CHATS_URL = `chrome-extension://${LINE_EXTENSION_ID}/index.html#/chats`;

/** Page key in SharedBrowserManager */
const PAGE_KEY = 'line';

/** How long to wait for LINE to render after navigation */
const PAGE_LOAD_WAIT_MS = 5000;

// --- Types ---

export interface LineChatItem {
  name: string;
  lastMessage: string;
  time: string;
  unreadCount: number;
  /** Index in the chat list (for clicking) */
  index: number;
}

export interface LineMessage {
  sender: string;
  content: string;
  time: string;
  isMe: boolean;
}

/**
 * Connect to Chrome via SharedBrowserManager and open the LINE Extension page.
 * Reuses existing connection if already connected.
 */
export async function connectToLine(): Promise<void> {
  if (isLineConnected()) {
    console.log('[line-puppeteer] Already connected');
    return;
  }

  console.log('[line-puppeteer] Connecting via SharedBrowserManager...');

  await sharedBrowser.getOrCreatePage(
    PAGE_KEY,
    LINE_EXTENSION_ID,  // match existing tab by extension ID
    LINE_CHATS_URL       // navigate if creating new tab
  );

  // Wait for LINE to authenticate and render
  console.log(`[line-puppeteer] Waiting ${PAGE_LOAD_WAIT_MS}ms for LINE to render...`);
  await sleep(PAGE_LOAD_WAIT_MS);

  console.log('[line-puppeteer] LINE page ready');
}

/**
 * Check if Puppeteer is connected to LINE.
 */
export function isLineConnected(): boolean {
  return sharedBrowser.isPageAlive(PAGE_KEY);
}

/**
 * Disconnect from Chrome (close the LINE tab, not Chrome itself).
 */
export async function disconnectLine(): Promise<void> {
  await sharedBrowser.closePage(PAGE_KEY);
  console.log('[line-puppeteer] Disconnected');
}

/**
 * Read the chat list from LINE Extension.
 * Returns an array of chat items with name, preview, time, and unread count.
 */
export async function readChatList(): Promise<LineChatItem[]> {
  const linePage = await getLinePage();

  // Make sure we're on the chats tab
  const hash = await linePage.evaluate('window.location.hash');
  if (hash !== '#/chats') {
    try {
      await linePage.goto(LINE_CHATS_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch {}
    await sleep(3000);
  }

  // LINE uses virtual scrolling — only chats visible in the viewport are in the DOM.
  // We need to scroll through the entire chat list to load all chats.
  const scrollableSelector = await linePage.evaluate(`
    (function() {
      // Find the scrollable container for the chat list
      // Usually it's a div with overflow-y: auto/scroll that contains chat items
      var candidates = document.querySelectorAll('[class*="chatlist-module"], [class*="chatList-module"], [class*="chatlistBody"], [class*="scroll"], [id*="chat"]');
      for (var i = 0; i < candidates.length; i++) {
        var style = window.getComputedStyle(candidates[i]);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          if (candidates[i].scrollHeight > candidates[i].clientHeight) {
            return { found: true, scrollHeight: candidates[i].scrollHeight, clientHeight: candidates[i].clientHeight, tag: candidates[i].tagName, cls: (candidates[i].className || '').substring(0, 80) };
          }
        }
      }
      // Try broader search — any scrollable element that contains chatlistItem elements
      var chatItems = document.querySelectorAll('[class*="chatlistItem-module"]');
      if (chatItems.length > 0) {
        var parent = chatItems[0].parentElement;
        while (parent) {
          var style = window.getComputedStyle(parent);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
            return { found: true, scrollHeight: parent.scrollHeight, clientHeight: parent.clientHeight, tag: parent.tagName, cls: (parent.className || '').substring(0, 80) };
          }
          parent = parent.parentElement;
        }
      }
      return { found: false };
    })()
  `) as any;

  console.log(`[line-puppeteer] Scroll container:`, JSON.stringify(scrollableSelector));

  // Scroll through the chat list to load all virtual items
  if (scrollableSelector.found) {
    const scrollPasses = Math.ceil(scrollableSelector.scrollHeight / scrollableSelector.clientHeight);
    const maxPasses = Math.min(scrollPasses + 2, 20); // safety cap

    console.log(`[line-puppeteer] Scrolling through chat list (${maxPasses} passes, scrollHeight=${scrollableSelector.scrollHeight})...`);

    for (let pass = 0; pass < maxPasses; pass++) {
      await linePage.evaluate(`
        (function() {
          var chatItems = document.querySelectorAll('[class*="chatlistItem-module"]');
          if (chatItems.length === 0) return;
          var parent = chatItems[0].parentElement;
          while (parent) {
            var style = window.getComputedStyle(parent);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop = ${pass} * parent.clientHeight;
              return;
            }
            parent = parent.parentElement;
          }
        })()
      `);
      await sleep(300); // Wait for DOM to update after scroll
    }

    // Scroll back to top
    await linePage.evaluate(`
      (function() {
        var chatItems = document.querySelectorAll('[class*="chatlistItem-module"]');
        if (chatItems.length === 0) return;
        var parent = chatItems[0].parentElement;
        while (parent) {
          var style = window.getComputedStyle(parent);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
            parent.scrollTop = 0;
            return;
          }
          parent = parent.parentElement;
        }
      })()
    `);
    await sleep(500);
  }

  // Collect selector analysis for debugging
  const selectorInfo = await linePage.evaluate(`
    (function() {
      var allItems = document.querySelectorAll('[class*="chatlistItem-module"]');
      var classPatterns = {};
      for (var i = 0; i < Math.min(allItems.length, 50); i++) {
        var classes = (typeof allItems[i].className === 'string') ? allItems[i].className.split(/\\s+/) : [];
        for (var j = 0; j < classes.length; j++) {
          var c = classes[j];
          if (c.indexOf('chatlistItem-module') > -1) {
            var parts = c.split('_');
            var key = parts.length > 1 ? parts[1] : 'root';
            classPatterns[key] = (classPatterns[key] || 0) + 1;
          }
        }
      }
      return {
        totalChatlistItems: allItems.length,
        dataMidCount: document.querySelectorAll('[data-mid]').length,
        classPatterns: classPatterns,
      };
    })()
  `) as any;

  console.log(`[line-puppeteer] Selector analysis:`, JSON.stringify(selectorInfo));

  // Parse chat list using COMBINED strategy — merge results from all selectors
  const items = await linePage.evaluate(`
    (function() {
      var chatsByName = {};  // Use name as key to auto-deduplicate

      function parseElement(el, idx) {
        var texts = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var node;
        while (node = walker.nextNode()) {
          var t = node.textContent ? node.textContent.trim() : '';
          if (t.length > 0) texts.push(t);
        }
        // Accept chats with at least 1 text node (just a name is enough)
        if (texts.length >= 1) {
          var name = texts[0];
          var time = '';
          var preview = '';
          var unread = 0;
          var textIdx = 1;

          // Member count like "(4)"
          if (texts[textIdx] && /^\\(\\d+\\)$/.test(texts[textIdx])) {
            name = name + ' ' + texts[textIdx];
            textIdx++;
          }

          // Time
          if (texts[textIdx]) { time = texts[textIdx]; textIdx++; }
          // Preview
          if (texts[textIdx]) { preview = texts[textIdx]; textIdx++; }
          // Remaining: unread count or more preview text
          for (var j = textIdx; j < texts.length; j++) {
            if (/^\\d+$/.test(texts[j])) { unread = parseInt(texts[j], 10); }
            else if (preview) { preview += ' ' + texts[j]; }
            else { preview = texts[j]; }
          }

          // Only add if we haven't seen this name before
          if (!chatsByName[name]) {
            chatsByName[name] = {
              name: name,
              lastMessage: preview.substring(0, 200),
              time: time,
              unreadCount: unread,
              index: idx
            };
          }
        }
      }

      // ===== Strategy 1: data-mid elements (unique per chat) =====
      var midEls = document.querySelectorAll('[data-mid]');
      for (var i = 0; i < midEls.length; i++) {
        parseElement(midEls[i], i);
      }

      // ===== Strategy 2: chatlistItem-module wrapper elements =====
      var allItems = document.querySelectorAll('[class*="chatlistItem-module"]');
      var wrapperItems = [];
      for (var i = 0; i < allItems.length; i++) {
        var cn = (typeof allItems[i].className === 'string') ? allItems[i].className : '';
        if (cn.indexOf('wrap') > -1) {
          wrapperItems.push(allItems[i]);
        }
      }

      // Fallback: top-level chatlistItem elements (parent is not also chatlistItem)
      if (wrapperItems.length === 0) {
        for (var i = 0; i < allItems.length; i++) {
          var el = allItems[i];
          var parent = el.parentElement;
          var parentCn = parent ? ((typeof parent.className === 'string') ? parent.className : '') : '';
          if (parentCn.indexOf('chatlistItem-module') === -1) {
            wrapperItems.push(el);
          }
        }
      }

      for (var i = 0; i < wrapperItems.length; i++) {
        parseElement(wrapperItems[i], Object.keys(chatsByName).length + i);
      }

      // ===== Strategy 3: <li> elements inside chat list =====
      var listItems = document.querySelectorAll('ul[class*="chatlist"] > li, ul[role="listbox"] > li');
      for (var i = 0; i < listItems.length; i++) {
        parseElement(listItems[i], Object.keys(chatsByName).length + i);
      }

      // ===== Strategy 4: Legacy friendlistItem-module =====
      var friendItems = document.querySelectorAll('[class*="friendlistItem-module"]');
      for (var i = 0; i < friendItems.length; i++) {
        parseElement(friendItems[i], Object.keys(chatsByName).length + i);
      }

      // Convert map to array and assign sequential indices
      var chats = [];
      var keys = Object.keys(chatsByName);
      for (var i = 0; i < keys.length; i++) {
        var chat = chatsByName[keys[i]];
        chat.index = i;
        chats.push(chat);
      }

      return chats;
    })()
  `) as LineChatItem[];

  console.log(`[line-puppeteer] Read ${items.length} unique chats`);
  return items;
}

/**
 * Open a specific chat by clicking on it in the chat list.
 * @param chatIndex - The index in the chat list (from readChatList())
 * @param chatName - Optional: the chat name for logging
 */
export async function openChat(chatIndex: number, chatName?: string): Promise<boolean> {
  const linePage = await getLinePage();

  const label = chatName ?? `index ${chatIndex}`;
  console.log(`[line-puppeteer] Opening chat: ${label}`);

  // Use name-based clicking when chatName is provided (more reliable than index)
  const escapedName = chatName ? chatName.replace(/'/g, "\\'").replace(/\\/g, '\\\\') : '';

  const clicked = await linePage.evaluate(`
    (function() {
      var targetName = '${escapedName}';

      // Collect all clickable chat items from multiple selectors
      var items = [];
      var midEls = document.querySelectorAll('[data-mid]');
      for (var i = 0; i < midEls.length; i++) items.push(midEls[i]);

      var allItems = document.querySelectorAll('[class*="chatlistItem-module"]');
      for (var i = 0; i < allItems.length; i++) {
        var cn = (typeof allItems[i].className === 'string') ? allItems[i].className : '';
        if (cn.indexOf('wrap') > -1) items.push(allItems[i]);
      }

      var friendItems = document.querySelectorAll('[class*="friendlistItem-module"]');
      for (var i = 0; i < friendItems.length; i++) items.push(friendItems[i]);

      // If we have a chat name, try to find and click by name first
      if (targetName) {
        for (var i = 0; i < items.length; i++) {
          var texts = [];
          var walker = document.createTreeWalker(items[i], NodeFilter.SHOW_TEXT);
          var node;
          while (node = walker.nextNode()) {
            var t = node.textContent ? node.textContent.trim() : '';
            if (t.length > 0) { texts.push(t); break; } // Just need the first text (name)
          }
          if (texts.length > 0 && texts[0] === targetName) {
            items[i].click();
            return true;
          }
        }
      }

      // Fallback: click by index
      if (${chatIndex} < items.length) {
        items[${chatIndex}].click();
        return true;
      }
      return false;
    })()
  `) as boolean;

  if (clicked) {
    await sleep(2000); // Wait for chat room to load
    console.log(`[line-puppeteer] Opened chat: ${label}`);
  } else {
    console.warn(`[line-puppeteer] Could not find chat at index ${chatIndex}`);
  }

  return clicked;
}

/**
 * Read messages from the currently open chat room.
 * Returns the visible messages in chronological order.
 */
export async function readChatMessages(): Promise<LineMessage[]> {
  const linePage = await getLinePage();

  const messages = await linePage.evaluate(`
    (function() {
      // Get the chatroom area body text
      var crArea = document.querySelector('[class*="chatroom-module"]');
      if (!crArea) return [];

      var bodyText = crArea.innerText || '';
      if (!bodyText) return [];

      // Parse messages from the chatroom text
      // LINE displays messages as: sender name, time, then message content
      // For "me" messages, the format might differ
      var lines = bodyText.split('\\n').filter(function(l) { return l.trim().length > 0; });
      var messages = [];

      // Simple heuristic: collect all text content from the chatroom
      // A more robust approach would use DOM structure
      var msgEls = crArea.querySelectorAll('[class*="message"]');
      if (msgEls.length === 0) {
        // Fallback: just return body text as one block
        return [{ sender: '', content: bodyText.substring(0, 2000), time: '', isMe: false }];
      }

      for (var i = 0; i < msgEls.length; i++) {
        var el = msgEls[i];
        var cn = (typeof el.className === 'string') ? el.className : '';
        var text = (el.textContent || '').trim();
        if (!text) continue;

        // Check if it's my message vs other's
        var isMe = cn.indexOf('my') > -1 || cn.indexOf('right') > -1 || cn.indexOf('self') > -1;

        messages.push({
          sender: isMe ? 'Me' : '',
          content: text.substring(0, 500),
          time: '',
          isMe: isMe
        });
      }

      return messages;
    })()
  `) as LineMessage[];

  console.log(`[line-puppeteer] Read ${messages.length} messages from current chat`);
  return messages;
}

/**
 * Send a message in the currently open chat.
 * Types the message into the input field and presses Enter.
 */
export async function sendMessage(text: string): Promise<boolean> {
  const linePage = await getLinePage();

  console.log(`[line-puppeteer] Sending message (${text.length} chars)...`);

  // Find the message input field and type into it
  const sent = await linePage.evaluate(`
    (function() {
      // Look for the message input (textarea or contenteditable div)
      var input = document.querySelector('[class*="chatroom-module"] textarea');
      if (!input) input = document.querySelector('[class*="chatroom-module"] [contenteditable="true"]');
      if (!input) input = document.querySelector('[class*="input-module"] textarea');
      if (!input) input = document.querySelector('textarea');
      if (!input) return { found: false };

      return { found: true, tag: input.tagName, cls: (input.className || '').substring(0, 60) };
    })()
  `) as any;

  if (!sent.found) {
    console.warn('[line-puppeteer] Could not find message input field');
    return false;
  }

  console.log(`[line-puppeteer] Found input: <${sent.tag}> cls="${sent.cls}"`);

  // Use Puppeteer's native type method for reliability
  const inputSelector = sent.tag === 'TEXTAREA'
    ? '[class*="chatroom-module"] textarea, [class*="input-module"] textarea, textarea'
    : '[class*="chatroom-module"] [contenteditable="true"]';

  await linePage.click(inputSelector);
  await sleep(200);
  await linePage.type(inputSelector, text);
  await sleep(200);
  await linePage.keyboard.press('Enter');

  console.log('[line-puppeteer] Message sent');
  return true;
}

// --- Internal helpers ---

/**
 * Get the LINE page, connecting if necessary.
 */
async function getLinePage(): Promise<Page> {
  let page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) {
    await connectToLine();
    page = sharedBrowser.getPage(PAGE_KEY);
  }
  if (!page) {
    throw new Error('Failed to get LINE page after connection attempt');
  }
  return page;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
