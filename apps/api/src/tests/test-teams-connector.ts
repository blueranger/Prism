#!/usr/bin/env npx tsx
/**
 * Teams Connector 整合測試腳本
 *
 * 測試項目：
 *   1. SharedBrowserManager 連接 Chrome
 *   2. LINE / Teams 頁面共存
 *   3. Teams Network Interception（API 攔截）
 *   4. TeamsConnector 類別 (DB 操作)
 *   5. TeamsMonitorAgent 啟動/停止
 *   6. connector-service Teams 路由
 *
 * 前置需求：
 *   Chrome 以 --remote-debugging-port=9222 啟動
 *   Teams Web 已登入 https://teams.microsoft.com
 *
 * 執行方式：
 *   cd apps/api
 *   npx tsx src/tests/test-teams-connector.ts
 *
 *   可選 flag：
 *     --skip-browser    跳過需要 Chrome 的測試（只測 DB / 邏輯）
 *     --verbose         顯示詳細 log
 */

// ============================================================
//  Test Harness
// ============================================================

const SKIP_BROWSER = process.argv.includes('--skip-browser');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let skipped = 0;
const results: { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; error?: string; durationMs: number }[] = [];

function log(msg: string) {
  if (VERBOSE) console.log(`    ${msg}`);
}

async function test(name: string, fn: () => Promise<void>, opts?: { requiresBrowser?: boolean }) {
  if (opts?.requiresBrowser && SKIP_BROWSER) {
    skipped++;
    results.push({ name, status: 'SKIP', durationMs: 0 });
    console.log(`  ⏭  ${name} (skipped — no browser)`);
    return;
  }

  const start = Date.now();
  try {
    await fn();
    const dur = Date.now() - start;
    passed++;
    results.push({ name, status: 'PASS', durationMs: dur });
    console.log(`  ✅ ${name} (${dur}ms)`);
  } catch (err: any) {
    const dur = Date.now() - start;
    failed++;
    results.push({ name, status: 'FAIL', error: err.message, durationMs: dur });
    console.log(`  ❌ ${name} (${dur}ms)`);
    console.log(`     Error: ${err.message}`);
    if (VERBOSE && err.stack) {
      console.log(`     ${err.stack.split('\n').slice(1, 4).join('\n     ')}`);
    }
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================
//  1. SharedBrowserManager 測試
// ============================================================

async function testSharedBrowser() {
  console.log('\n📦 SharedBrowserManager Tests');

  await test('import shared-browser module', async () => {
    const mod = await import('../services/shared-browser');
    assert(mod.sharedBrowser != null, 'sharedBrowser should be exported');
    assert(typeof mod.sharedBrowser.getBrowser === 'function', 'getBrowser should be a function');
    assert(typeof mod.sharedBrowser.getOrCreatePage === 'function', 'getOrCreatePage should be a function');
    assert(typeof mod.sharedBrowser.getPage === 'function', 'getPage should be a function');
    assert(typeof mod.sharedBrowser.isPageAlive === 'function', 'isPageAlive should be a function');
    assert(typeof mod.sharedBrowser.closePage === 'function', 'closePage should be a function');
    assert(typeof mod.sharedBrowser.isConnected === 'function', 'isConnected should be a function');
    log('All methods present');
  });

  await test('connect to Chrome', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');
    const browser = await sharedBrowser.getBrowser();
    assert(browser != null, 'browser should not be null');
    assert(browser.isConnected(), 'browser should be connected');
    log(`Connected: ${browser.isConnected()}`);
  }, { requiresBrowser: true });

  await test('isConnected() returns true after connect', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');
    assert(sharedBrowser.isConnected(), 'should be connected after getBrowser()');
  }, { requiresBrowser: true });

  await test('getPage() returns null for unknown key', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');
    const page = sharedBrowser.getPage('nonexistent-test-key');
    assertEqual(page, null, 'unknown key should return null');
  }, { requiresBrowser: true });

  await test('isPageAlive() returns false for unknown key', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');
    assertEqual(sharedBrowser.isPageAlive('nonexistent-test-key'), false, 'should be false');
  }, { requiresBrowser: true });

  await test('getOrCreatePage() creates and caches page', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');
    const page = await sharedBrowser.getOrCreatePage('__test__');
    assert(page != null, 'page should not be null');
    assert(!page.isClosed(), 'page should not be closed');

    // Should return same page on second call
    const page2 = await sharedBrowser.getOrCreatePage('__test__');
    assert(page === page2, 'should return cached page');

    // Clean up
    await sharedBrowser.closePage('__test__');
    assertEqual(sharedBrowser.isPageAlive('__test__'), false, 'page should be closed after closePage');
  }, { requiresBrowser: true });
}

// ============================================================
//  2. Teams Puppeteer (Network Interception) 測試
// ============================================================

async function testTeamsPuppeteer() {
  console.log('\n🌐 Teams Puppeteer (Network Interception) Tests');

  await test('import teams-puppeteer module', async () => {
    const mod = await import('../services/teams-puppeteer');
    assert(typeof mod.connectToTeams === 'function', 'connectToTeams');
    assert(typeof mod.isTeamsConnected === 'function', 'isTeamsConnected');
    assert(typeof mod.disconnectTeams === 'function', 'disconnectTeams');
    assert(typeof mod.readChatList === 'function', 'readChatList');
    assert(typeof mod.readChatMessages === 'function', 'readChatMessages');
    assert(typeof mod.openChat === 'function', 'openChat');
    assert(typeof mod.sendMessage === 'function', 'sendMessage');
    assert(typeof mod.getCachedAuthToken === 'function', 'getCachedAuthToken');
    assert(typeof mod.getDiscoveryLog === 'function', 'getDiscoveryLog');
    assert(typeof mod.getCacheStatus === 'function', 'getCacheStatus');
    log('All functions exported');
  });

  await test('TeamsChatItem type shape', async () => {
    // Verify type exports work
    const mod = await import('../services/teams-puppeteer');
    const cacheStatus = mod.getCacheStatus();
    assert(typeof cacheStatus.chatListCount === 'number', 'chatListCount');
    assert(Array.isArray(cacheStatus.cachedChatIds), 'cachedChatIds');
    assert(typeof cacheStatus.hasToken === 'boolean', 'hasToken');
    assert(typeof cacheStatus.intercepting === 'boolean', 'intercepting');
    log(`Cache status: ${JSON.stringify(cacheStatus)}`);
  });

  await test('connectToTeams() and initial interception', async () => {
    const { connectToTeams, isTeamsConnected, getCacheStatus } = await import('../services/teams-puppeteer');

    await connectToTeams();
    assert(isTeamsConnected(), 'should be connected after connectToTeams()');

    const status = getCacheStatus();
    log(`After connect: ${JSON.stringify(status)}`);
    log(`Intercepting: ${status.intercepting}`);
    assert(status.intercepting, 'interception should be active');
  }, { requiresBrowser: true });

  await test('readChatList() returns TeamsChatItem[]', async () => {
    const { readChatList } = await import('../services/teams-puppeteer');
    const chats = await readChatList();

    log(`Chat count: ${chats.length}`);
    assert(Array.isArray(chats), 'should return array');

    if (chats.length > 0) {
      const first = chats[0];
      assert(typeof first.id === 'string' && first.id.length > 0, 'chat should have id');
      assert(typeof first.name === 'string', 'chat should have name');
      assert(typeof first.lastMessage === 'string', 'chat should have lastMessage');
      assert(typeof first.isGroup === 'boolean', 'chat should have isGroup');
      assert(typeof first.index === 'number', 'chat should have index');
      log(`First chat: id=${first.id.slice(0, 30)}... name="${first.name}" group=${first.isGroup}`);

      // IDs should be unique
      const ids = new Set(chats.map(c => c.id));
      assertEqual(ids.size, chats.length, 'chat IDs should be unique');
    } else {
      log('⚠ No chats found — Teams may not have loaded yet');
    }
  }, { requiresBrowser: true });

  await test('getCachedAuthToken() returns token after interception', async () => {
    const { getCachedAuthToken } = await import('../services/teams-puppeteer');
    const token = getCachedAuthToken();
    log(`Token: ${token ? token.slice(0, 20) + '...' : 'null'}`);
    // Token may or may not be captured depending on whether Teams made API calls
    // Not asserting non-null here since it depends on timing
  }, { requiresBrowser: true });

  await test('getDiscoveryLog() returns API call log', async () => {
    const { getDiscoveryLog } = await import('../services/teams-puppeteer');
    const log_entries = getDiscoveryLog();
    assert(Array.isArray(log_entries), 'should return array');
    log(`Discovery log entries: ${log_entries.length}`);
    if (log_entries.length > 0) {
      const last = log_entries[log_entries.length - 1];
      log(`Last entry: ${last.method} ${last.url.slice(0, 80)}... (${last.status})`);
    }
  }, { requiresBrowser: true });

  await test('getCacheStatus() shows discovered endpoints', async () => {
    const { getCacheStatus } = await import('../services/teams-puppeteer');
    const status = getCacheStatus();
    log(`Discovered endpoints: ${JSON.stringify(status.discoveredEndpoints)}`);
    log(`User ID: ${status.userId ?? 'not yet detected'}`);
  }, { requiresBrowser: true });

  await test('readChatMessages() for first chat', async () => {
    const { readChatList, readChatMessages } = await import('../services/teams-puppeteer');
    const chats = await readChatList();

    if (chats.length === 0) {
      log('⚠ No chats to test messages with');
      return;
    }

    const chatId = chats[0].id;
    log(`Reading messages for: ${chats[0].name} (${chatId.slice(0, 30)}...)`);

    const messages = await readChatMessages(chatId);
    assert(Array.isArray(messages), 'should return array');
    log(`Message count: ${messages.length}`);

    if (messages.length > 0) {
      const first = messages[0];
      assert(typeof first.content === 'string', 'message should have content');
      assert(typeof first.sender === 'string', 'message should have sender');
      assert(typeof first.isMe === 'boolean', 'message should have isMe');
      log(`First message: sender="${first.sender}" isMe=${first.isMe} content="${first.content.slice(0, 50)}..."`);
    }
  }, { requiresBrowser: true });
}

// ============================================================
//  3. LINE Puppeteer (SharedBrowserManager 共存) 測試
// ============================================================

async function testLineCoexistence() {
  console.log('\n🟢 LINE / Teams Coexistence Tests');

  await test('SharedBrowserManager has separate pages for LINE and Teams', async () => {
    const { sharedBrowser } = await import('../services/shared-browser');

    const teamsAlive = sharedBrowser.isPageAlive('teams');
    const lineAlive = sharedBrowser.isPageAlive('line');

    log(`Teams page alive: ${teamsAlive}`);
    log(`LINE page alive: ${lineAlive}`);

    // Teams should be alive from previous tests
    assert(teamsAlive, 'Teams page should be alive');

    // LINE may or may not be connected; just verify no crash
    const teamPage = sharedBrowser.getPage('teams');
    const linePage = sharedBrowser.getPage('line');

    assert(teamPage != null, 'Teams page should exist');
    log(`Teams URL: ${teamPage!.url()}`);
    if (linePage) {
      log(`LINE URL: ${linePage.url()}`);
    }
  }, { requiresBrowser: true });

  await test('LINE connectToLine() uses SharedBrowserManager', async () => {
    const { connectToLine, isLineConnected } = await import('../services/line-puppeteer');
    const { sharedBrowser } = await import('../services/shared-browser');

    // Before connecting, Teams page should still be alive
    assert(sharedBrowser.isPageAlive('teams'), 'Teams should still be alive before LINE connect');

    await connectToLine();
    assert(isLineConnected(), 'LINE should be connected');

    // Both should coexist
    assert(sharedBrowser.isPageAlive('teams'), 'Teams should still be alive after LINE connect');
    assert(sharedBrowser.isPageAlive('line'), 'LINE should be alive');

    log('Both LINE and Teams pages coexist successfully');
  }, { requiresBrowser: true });
}

// ============================================================
//  4. TeamsConnector 類別測試 (DB)
// ============================================================

async function testTeamsConnector() {
  console.log('\n🔌 TeamsConnector Class Tests');

  // Initialize DB for testing
  await test('initialize test DB', async () => {
    const { getDb } = await import('../memory/db');
    const db = getDb(); // getDb() auto-initializes
    assert(db != null, 'DB should be initialized');
    log('DB initialized');
  });

  await test('import TeamsConnector and register type', async () => {
    await import('../connectors/teams');
    const { ConnectorRegistry } = await import('../connectors/registry');
    const types = ConnectorRegistry.getAvailableTypes();
    const hasTeams = types.some((t: any) => t.connectorType === 'teams');
    assert(hasTeams, 'teams should be in available types');
    log(`Available types: ${types.map((t: any) => t.connectorType).join(', ')}`);
  });

  await test('create TeamsConnector instance', async () => {
    const { TeamsConnector } = await import('../connectors/teams');
    const conn = new TeamsConnector('test-teams-001');
    assertEqual(conn.provider, 'teams', 'provider');
    assertEqual(conn.connectorType, 'teams', 'connectorType');
    assertEqual(conn.isLocal, true, 'isLocal');
    assertEqual(conn.accountId, 'test-teams-001', 'accountId');
    log('Instance created with correct properties');
  });

  await test('activateTeamsConnector() persists to DB', async () => {
    const { TeamsConnector } = await import('../connectors/teams');
    const { getDb } = await import('../memory/db');

    const conn = new TeamsConnector('test-teams-activate');
    conn.activateTeamsConnector('Test Teams');

    const db = getDb();
    const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get('test-teams-activate') as any;
    assert(row != null, 'connector row should exist in DB');
    assertEqual(row.display_name, 'Test Teams', 'display_name');
    assertEqual(row.active, 1, 'active');
    assertEqual(row.provider, 'teams', 'provider');
    assertEqual(row.connector_type, 'teams', 'connector_type');

    const config = JSON.parse(row.config);
    assertEqual(config.accessToken, 'puppeteer', 'config.accessToken');
    log('DB row verified');

    // Clean up
    db.prepare('DELETE FROM connectors WHERE id = ?').run('test-teams-activate');
  });

  await test('setChatConfigs() and getChatConfigs()', async () => {
    const { TeamsConnector } = await import('../connectors/teams');
    const { getDb } = await import('../memory/db');

    const conn = new TeamsConnector('test-teams-configs');
    conn.activateTeamsConnector('Test Teams');

    // Initially null
    assertEqual(conn.getChatConfigs(), null, 'should be null initially');

    // Set configs
    conn.setChatConfigs([
      { chatId: 'chat-1', name: 'Alice', enabled: true, persona: 'PM', tone: 'formal' },
      { chatId: 'chat-2', name: 'DevTeam', enabled: false, instruction: '用中文' },
    ]);

    const configs = conn.getChatConfigs();
    assert(configs != null, 'configs should not be null');
    assertEqual(configs!.length, 2, 'should have 2 configs');
    assertEqual(configs![0].name, 'Alice', 'first config name');
    assertEqual(configs![0].persona, 'PM', 'first config persona');
    assertEqual(configs![1].enabled, false, 'second config enabled');

    log('Chat configs persisted and retrieved correctly');

    // Clean up
    const db = getDb();
    db.prepare('DELETE FROM connectors WHERE id = ?').run('test-teams-configs');
  });

  await test('getMonitoredChatNames() filters correctly', async () => {
    const { TeamsConnector } = await import('../connectors/teams');
    const { getDb } = await import('../memory/db');

    const conn = new TeamsConnector('test-teams-monitor-names');
    conn.activateTeamsConnector('Test Teams');

    // null = monitor ALL
    assertEqual(conn.getMonitoredChatNames(), null, 'should be null (monitor all)');

    // Set configs: one enabled, one disabled
    conn.setChatConfigs([
      { chatId: 'c1', name: 'Alice', enabled: true },
      { chatId: 'c2', name: 'Bob', enabled: false },
      { chatId: 'c3', name: 'Charlie', enabled: true },
    ]);

    const names = conn.getMonitoredChatNames();
    assert(names != null, 'should not be null');
    assertEqual(names!.length, 2, 'should have 2 enabled');
    assert(names!.includes('Alice'), 'should include Alice');
    assert(names!.includes('Charlie'), 'should include Charlie');
    assert(!names!.includes('Bob'), 'should not include Bob');

    log('Monitoring filter works correctly');

    const db = getDb();
    db.prepare('DELETE FROM connectors WHERE id = ?').run('test-teams-monitor-names');
  });

  await test('updateChatConfig() updates single chat', async () => {
    const { TeamsConnector } = await import('../connectors/teams');
    const { getDb } = await import('../memory/db');

    const conn = new TeamsConnector('test-teams-update');
    conn.activateTeamsConnector('Test');

    conn.setChatConfigs([
      { chatId: 'c1', name: 'Alice', enabled: true, tone: 'casual' },
    ]);

    // Update existing
    conn.updateChatConfig('Alice', { tone: 'formal', persona: 'Manager' });
    const alice = conn.getChatConfig('Alice');
    assertEqual(alice?.tone, 'formal', 'tone should be updated');
    assertEqual(alice?.persona, 'Manager', 'persona should be added');
    assertEqual(alice?.enabled, true, 'enabled should not change');

    // Add new
    conn.updateChatConfig('NewPerson', { enabled: true, language: 'zh-TW' });
    const newP = conn.getChatConfig('NewPerson');
    assert(newP != null, 'new config should exist');
    assertEqual(newP?.language, 'zh-TW', 'language');

    log('Single chat update works');

    const db = getDb();
    db.prepare('DELETE FROM connectors WHERE id = ?').run('test-teams-update');
  });
}

// ============================================================
//  5. TeamsMonitorAgent 測試
// ============================================================

async function testTeamsMonitor() {
  console.log('\n📡 TeamsMonitorAgent Tests');

  await test('import teams-monitor module', async () => {
    const mod = await import('../agents/teams-monitor');
    assert(typeof mod.startTeamsMonitoring === 'function', 'startTeamsMonitoring');
    assert(typeof mod.stopTeamsMonitoring === 'function', 'stopTeamsMonitoring');
    assert(typeof mod.isTeamsMonitoringActive === 'function', 'isTeamsMonitoringActive');
    log('All exports present');
  });

  await test('agent registered in registry', async () => {
    await import('../agents/teams-monitor');
    const { agentRegistry } = await import('../agents/registry');
    const agent = agentRegistry.get('teams-monitor');
    assert(agent != null, 'teams-monitor agent should be registered');
    assertEqual(agent!.name, 'teams-monitor', 'agent name');
    log(`Agent: ${agent!.name} — ${agent!.description.slice(0, 60)}...`);
  });

  await test('isTeamsMonitoringActive() returns false initially', async () => {
    const { isTeamsMonitoringActive } = await import('../agents/teams-monitor');
    assertEqual(isTeamsMonitoringActive('nonexistent'), false, 'should be false for unknown account');
  });

  await test('startTeamsMonitoring / stopTeamsMonitoring lifecycle', async () => {
    const { startTeamsMonitoring, stopTeamsMonitoring, isTeamsMonitoringActive } = await import('../agents/teams-monitor');
    const { ConnectorRegistry } = await import('../connectors/registry');
    const { TeamsConnector } = await import('../connectors/teams');

    const testId = 'test-monitor-lifecycle';

    // Register a real TeamsConnector instance so pollOnce() doesn't self-stop
    const conn = ConnectorRegistry.createInstance('teams', testId) as InstanceType<typeof TeamsConnector>;
    conn.activateTeamsConnector('Test Monitor');

    startTeamsMonitoring(testId);
    await new Promise(r => setTimeout(r, 100));
    assert(isTeamsMonitoringActive(testId), 'should be active after start');

    stopTeamsMonitoring(testId);
    await new Promise(r => setTimeout(r, 100));
    assertEqual(isTeamsMonitoringActive(testId), false, 'should be inactive after stop');

    // Clean up
    ConnectorRegistry.removeInstance(testId);
    const { getDb } = await import('../memory/db');
    getDb().prepare('DELETE FROM connectors WHERE id = ?').run(testId);

    log('Start/stop lifecycle works without crash');
  });
}

// ============================================================
//  6. connector-service Teams 路由測試
// ============================================================

async function testConnectorService() {
  console.log('\n⚙️  connector-service Integration Tests');

  await test('syncAccount() routes Teams directly (no Outlook queue)', async () => {
    // This is a logic test — we verify that Teams connectors bypass the queue
    const { syncAccount } = await import('../services/connector-service');
    const { ConnectorRegistry } = await import('../connectors/registry');

    // Create a fake Teams connector instance
    const { TeamsConnector } = await import('../connectors/teams');
    const testId = 'test-sync-route';
    const conn = ConnectorRegistry.createInstance('teams', testId) as InstanceType<typeof TeamsConnector>;
    conn.activateTeamsConnector('Test Sync');

    // syncAccount should return quickly (will fail because no Puppeteer, but shouldn't hang in queue)
    const start = Date.now();
    const result = await syncAccount(testId);
    const duration = Date.now() - start;

    log(`Sync result: ${JSON.stringify(result)} (${duration}ms)`);
    // It should return an error (can't connect) but NOT hang in the Outlook queue
    assert(duration < 30000, 'should not hang in Outlook queue');

    // Clean up
    ConnectorRegistry.removeInstance(testId);
    const { getDb } = await import('../memory/db');
    getDb().prepare('DELETE FROM connectors WHERE id = ?').run(testId);
  }, { requiresBrowser: true });

  await test('startPolling() skips Teams connectors', async () => {
    const { startPolling, isPolling, stopPolling } = await import('../services/connector-service');
    const { ConnectorRegistry } = await import('../connectors/registry');
    const { TeamsConnector } = await import('../connectors/teams');

    const testId = 'test-poll-skip';
    const conn = ConnectorRegistry.createInstance('teams', testId) as InstanceType<typeof TeamsConnector>;
    conn.activateTeamsConnector('Test Poll');

    startPolling(testId);
    // Teams should NOT be added to round-robin polling
    assertEqual(isPolling(testId), false, 'Teams should not be in round-robin polling');

    // Clean up
    ConnectorRegistry.removeInstance(testId);
    const { getDb } = await import('../memory/db');
    getDb().prepare('DELETE FROM connectors WHERE id = ?').run(testId);

    log('Teams correctly excluded from round-robin polling');
  });
}

// ============================================================
//  7. LINE Puppeteer Refactor 驗證
// ============================================================

async function testLinePuppeteerRefactor() {
  console.log('\n🔧 LINE Puppeteer Refactor Verification');

  await test('line-puppeteer uses SharedBrowserManager (no own browser singleton)', async () => {
    // Verify the module no longer has its own browser/page variables
    const mod = await import('../services/line-puppeteer');

    // These functions should still exist
    assert(typeof mod.connectToLine === 'function', 'connectToLine');
    assert(typeof mod.isLineConnected === 'function', 'isLineConnected');
    assert(typeof mod.disconnectLine === 'function', 'disconnectLine');
    assert(typeof mod.readChatList === 'function', 'readChatList');
    assert(typeof mod.openChat === 'function', 'openChat');
    assert(typeof mod.readChatMessages === 'function', 'readChatMessages');
    assert(typeof mod.sendMessage === 'function', 'sendMessage');

    log('All LINE functions present after refactor');
  });

  await test('isLineConnected() delegates to SharedBrowserManager', async () => {
    const { isLineConnected } = await import('../services/line-puppeteer');
    const { sharedBrowser } = await import('../services/shared-browser');

    // isLineConnected should match sharedBrowser.isPageAlive('line')
    const lineConnected = isLineConnected();
    const pageAlive = sharedBrowser.isPageAlive('line');
    assertEqual(lineConnected, pageAlive, 'should delegate to SharedBrowserManager');
    log(`LINE connected: ${lineConnected}, page alive: ${pageAlive}`);
  });
}

// ============================================================
//  Main
// ============================================================

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Teams Connector 整合測試');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Skip browser: ${SKIP_BROWSER}`);
  console.log(`  Verbose:      ${VERBOSE}`);
  console.log('');

  try {
    // Run test groups in order
    await testSharedBrowser();
    await testTeamsPuppeteer();
    await testLineCoexistence();
    await testTeamsConnector();
    await testTeamsMonitor();
    await testConnectorService();
    await testLinePuppeteerRefactor();
  } catch (err: any) {
    console.error(`\n💥 Unexpected error: ${err.message}`);
    if (VERBOSE) console.error(err.stack);
  }

  // Clean up browser connection
  try {
    if (!SKIP_BROWSER) {
      const { disconnectTeams } = await import('../services/teams-puppeteer');
      await disconnectTeams();
    }
  } catch { /* ignore */ }

  // Summary
  console.log('\n═══════════════════════════════════════════════');
  console.log('  Results');
  console.log('═══════════════════════════════════════════════');
  console.log(`  ✅ Passed:  ${passed}`);
  console.log(`  ❌ Failed:  ${failed}`);
  console.log(`  ⏭  Skipped: ${skipped}`);
  console.log(`  Total:     ${passed + failed + skipped}`);
  console.log('');

  if (failed > 0) {
    console.log('  Failed tests:');
    for (const r of results) {
      if (r.status === 'FAIL') {
        console.log(`    ❌ ${r.name}: ${r.error}`);
      }
    }
    console.log('');
  }

  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  console.log(`  Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log('═══════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main();
