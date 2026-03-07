/**
 * LINE Chrome Extension Explorer via Puppeteer (v3)
 *
 * Usage:
 *   1. Launch Chrome: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --remote-debugging-port=9222 --user-data-dir="$HOME/prism-chrome-profile"
 *   2. Run: npx tsx scripts/line-puppeteer-explore.ts
 */

import puppeteer from 'puppeteer-core';

const LINE_EXTENSION_ID = 'ophjlpahpchlmihnnnihgmmeilfjmjjc';
const LINE_URL = `chrome-extension://${LINE_EXTENSION_ID}/index.html`;

async function main() {
  console.log('=== LINE Puppeteer Explorer v3 ===');

  const browser = await puppeteer.connect({
    browserURL: 'http://127.0.0.1:9222',
    defaultViewport: null,
  }).catch(() => {
    console.error('❌ Cannot connect to Chrome on port 9222.');
    process.exit(1);
  });

  console.log('✅ Connected');
  const page = await browser!.newPage();

  // Navigate to chats
  try {
    await page.goto(`${LINE_URL}#/chats`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {}
  await new Promise(r => setTimeout(r, 4000));

  // Use evaluateHandle + string to avoid tsx __name injection
  const chatListResult = await page.evaluate(`
    (function() {
      var results = {};
      results.hash = window.location.hash;
      results.bodyText = (document.body && document.body.innerText) ? document.body.innerText.substring(0, 3000) : '';

      // CSS module prefixes
      var classMap = {};
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var cn = allEls[i].className;
        if (typeof cn !== 'string') continue;
        if (cn.indexOf('-module_') === -1) continue;
        var parts = cn.split(/\\s+/);
        for (var j = 0; j < parts.length; j++) {
          if (parts[j].indexOf('-module_') > -1) {
            var prefix = parts[j].split('_')[0];
            classMap[prefix] = (classMap[prefix] || 0) + 1;
          }
        }
      }
      results.classMap = classMap;

      // Chat items
      var items = document.querySelectorAll('[class*="friendlistItem-module"]');
      results.chatItemCount = items.length;
      results.chatItems = [];
      var max = Math.min(items.length, 15);
      for (var i = 0; i < max; i++) {
        var el = items[i];
        var cn = (typeof el.className === 'string') ? el.className : '';
        if (cn.indexOf('wrap') === -1 && cn.indexOf('item_') === -1) continue;
        var texts = [];
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var node;
        while (node = walker.nextNode()) {
          var t = node.textContent ? node.textContent.trim() : '';
          if (t.length > 0) texts.push(t);
        }
        if (texts.length > 0) {
          results.chatItems.push({ cls: cn.substring(0, 80), texts: texts });
        }
      }

      // Nav items
      var navEls = document.querySelectorAll('[class*="gnb-module"]');
      results.navItems = [];
      for (var i = 0; i < navEls.length; i++) {
        var el = navEls[i];
        results.navItems.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().substring(0, 50)
        });
      }

      return results;
    })()
  `);

  const chatData = chatListResult as any;
  console.log('Hash:', chatData.hash);

  console.log('\n=== CSS Module Prefixes ===');
  const sorted = Object.entries(chatData.classMap || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of sorted) console.log(`  ${k}: ${v}`);

  console.log('\n=== Nav Items ===');
  for (const n of chatData.navItems || []) console.log(`  <${n.tag}> "${n.text}"`);

  console.log(`\n=== Chat Items: ${chatData.chatItemCount} total ===`);
  for (const item of chatData.chatItems || []) {
    console.log(`  texts: ${JSON.stringify(item.texts)}`);
  }

  console.log('\n=== Body Text (chats page, 3000 chars) ===');
  console.log(chatData.bodyText);

  // Phase 2: Click first chat and read messages
  console.log('\n--- Phase 2: Click first chat ---');

  const clickResult = await page.evaluate(`
    (function() {
      var items = document.querySelectorAll('[class*="friendlistItem-module"]');
      for (var i = 0; i < items.length; i++) {
        var cn = (typeof items[i].className === 'string') ? items[i].className : '';
        if (cn.indexOf('wrap') > -1 || cn.indexOf('item_') > -1) {
          items[i].click();
          return { clicked: true, text: (items[i].textContent || '').substring(0, 80) };
        }
      }
      if (items.length > 0) {
        items[0].click();
        return { clicked: true, text: (items[0].textContent || '').substring(0, 80) };
      }
      return { clicked: false, text: '' };
    })()
  `) as any;

  console.log('Clicked:', clickResult.clicked, 'on:', clickResult.text);
  await new Promise(r => setTimeout(r, 4000));

  // Read chatroom
  const chatroomResult = await page.evaluate(`
    (function() {
      var results = {};

      // Chatroom elements
      var crEls = document.querySelectorAll('[class*="chatroom-module"]');
      results.chatroomCount = crEls.length;
      results.chatrooms = [];
      for (var i = 0; i < crEls.length; i++) {
        var cn = (typeof crEls[i].className === 'string') ? crEls[i].className : '';
        results.chatrooms.push({
          tag: crEls[i].tagName,
          cls: cn.substring(0, 100),
          children: crEls[i].children.length,
          text: (crEls[i].textContent || '').substring(0, 200)
        });
      }

      // Message-like elements
      var selectors = [
        '[class*="message-module"]',
        '[class*="chatMessage"]',
        '[class*="msg-module"]',
        '[class*="bubble-module"]',
        '[class*="text-module"]',
        '[class*="chatItem"]',
        '[class*="messageItem"]',
        '[class*="content-module"]',
        '[class*="balloon"]',
        '[class*="chat_"]'
      ];
      results.msgSelectors = {};
      for (var s = 0; s < selectors.length; s++) {
        var els = document.querySelectorAll(selectors[s]);
        if (els.length > 0) {
          var samples = [];
          var max = Math.min(els.length, 5);
          for (var i = 0; i < max; i++) {
            var cn = (typeof els[i].className === 'string') ? els[i].className : '';
            samples.push({
              tag: els[i].tagName,
              cls: cn.substring(0, 100),
              text: (els[i].textContent || '').substring(0, 150)
            });
          }
          results.msgSelectors[selectors[s]] = { count: els.length, samples: samples };
        }
      }

      // Chatroom area CSS prefixes
      var crArea = document.querySelector('[class*="chatroom-module"]');
      if (crArea) {
        var classMap = {};
        var allEls = crArea.querySelectorAll('*');
        for (var i = 0; i < allEls.length; i++) {
          var cn = (typeof allEls[i].className === 'string') ? allEls[i].className : '';
          if (cn.indexOf('-module_') === -1) continue;
          var parts = cn.split(/\\s+/);
          for (var j = 0; j < parts.length; j++) {
            if (parts[j].indexOf('-module_') > -1) {
              var prefix = parts[j].split('_')[0];
              classMap[prefix] = (classMap[prefix] || 0) + 1;
            }
          }
        }
        results.crClassMap = classMap;
      }

      // Updated body text
      results.bodyText = (document.body && document.body.innerText) ? document.body.innerText.substring(0, 5000) : '';

      return results;
    })()
  `) as any;

  console.log(`\n=== Chatroom Elements: ${chatroomResult.chatroomCount} ===`);
  for (const cr of chatroomResult.chatrooms || []) {
    console.log(`  <${cr.tag}> cls="${cr.cls}" children=${cr.children}`);
    if (cr.text) console.log(`    text: "${cr.text.substring(0, 120)}"`);
  }

  console.log('\n=== Message Selectors ===');
  for (const [sel, data] of Object.entries(chatroomResult.msgSelectors || {}) as any[]) {
    console.log(`  ${sel}: ${data.count} elements`);
    for (const s of data.samples) {
      console.log(`    <${s.tag}> cls="${s.cls.substring(0, 60)}" text="${s.text.substring(0, 80)}"`);
    }
  }

  if (chatroomResult.crClassMap) {
    console.log('\n=== Chatroom CSS Prefixes ===');
    const crSorted = Object.entries(chatroomResult.crClassMap).sort((a: any, b: any) => b[1] - a[1]).slice(0, 25);
    for (const [k, v] of crSorted) console.log(`  ${k}: ${v}`);
  }

  console.log('\n=== Body Text After Click (5000 chars) ===');
  console.log(chatroomResult.bodyText);

  await page.close();
  console.log('\n✅ Done!');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
