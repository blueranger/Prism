import { execSync, exec } from 'child_process';

/**
 * AppleScript helper for reading Outlook for macOS mailbox data.
 *
 * Uses `osascript` to communicate with the Outlook desktop app via Apple Events.
 * The Outlook app must be installed and the user must have at least one account configured.
 *
 * Sync operations (fetchInboxMessages, etc.) use async exec to avoid blocking
 * the Node event loop. Quick checks (isOutlookRunning, etc.) still use execSync.
 */

// --- Types for parsed results ---

export interface AppleScriptMailMessage {
  id: string;
  subject: string;
  senderName: string;
  senderEmail: string;
  receivedAt: number; // epoch ms
  content: string;
  isRead: boolean;
  conversationId: string;
  toRecipients: string[];
}

export type OutlookAccountType = 'exchange' | 'imap' | 'pop';

export interface OutlookAccountInfo {
  email: string;
  name: string;
  accountType: OutlookAccountType;
  accountIndex: number; // 1-based index within its type list
}

// --- Helpers ---

function runAppleScript(script: string): string {
  try {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    if (stderr.includes('not running') || stderr.includes('-600')) {
      throw new Error('Outlook for macOS is not running. Please open it first.');
    }
    throw new Error(`AppleScript failed: ${stderr || err.message}`);
  }
}

function runAppleScriptMultiline(lines: string[]): string {
  const script = lines.join('\n');
  try {
    return execSync('osascript -', {
      input: script,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? '';
    if (stderr.includes('not running') || stderr.includes('-600')) {
      throw new Error('Outlook for macOS is not running. Please open it first.');
    }
    throw new Error(`AppleScript failed: ${stderr || err.message}`);
  }
}

/**
 * Async version of runAppleScriptMultiline — does NOT block the Node event loop.
 * Use this for long-running operations like fetching messages.
 */
/** Default timeout for async AppleScript operations */
const APPLESCRIPT_TIMEOUT_MS = 120_000;

function runAppleScriptAsync(lines: string[], label?: string): Promise<string> {
  const script = lines.join('\n');
  const tag = label ? `[applescript:${label}]` : '[applescript]';
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const child = exec('osascript -', {
      encoding: 'utf8',
      timeout: APPLESCRIPT_TIMEOUT_MS,
    }, (err, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (err) {
        const stderrStr = stderr?.toString() ?? '';
        const killed = (err as any).killed === true;
        const signal = (err as any).signal ?? 'none';
        const code = (err as any).code ?? 'unknown';

        // Timeout detection: Node kills the process when timeout is exceeded
        if (killed || signal === 'SIGTERM') {
          const msg = `${tag} TIMEOUT after ${elapsed}s (limit: ${APPLESCRIPT_TIMEOUT_MS / 1000}s). ` +
            `The AppleScript operation took too long. This may indicate the Outlook account ` +
            `has too many messages, a slow Exchange server, or Outlook is busy with another operation.`;
          console.error(msg);
          reject(new Error(msg));
          return;
        }

        // Outlook not running
        if (stderrStr.includes('not running') || stderrStr.includes('-600')) {
          console.error(`${tag} Outlook not running (${elapsed}s)`);
          reject(new Error('Outlook for macOS is not running. Please open it first.'));
          return;
        }

        // AppleScript execution error (syntax, permission, app error, etc.)
        const errorDetail = stderrStr || err.message;
        console.error(`${tag} Failed in ${elapsed}s | code=${code} signal=${signal} killed=${killed} | ${errorDetail}`);
        reject(new Error(`AppleScript failed (${elapsed}s): ${errorDetail}`));
        return;
      }

      console.log(`${tag} Completed in ${elapsed}s (${(stdout ?? '').length} chars)`);
      resolve((stdout ?? '').trim());
    });
    // Feed the script via stdin
    child.stdin?.write(script);
    child.stdin?.end();
  });
}

// Field delimiter for structured output
const DELIM = '|||';
const ROW_DELIM = '<<<ROW>>>';

/**
 * Check if Outlook for macOS is installed and accessible.
 */
export function isOutlookInstalled(): boolean {
  try {
    const result = runAppleScript(
      'tell application "System Events" to return (name of processes) contains "Microsoft Outlook"'
    );
    // Even if Outlook isn't running, we check if the app exists
    if (result === 'true') return true;

    // Try checking if the app bundle exists
    try {
      execSync('mdfind "kMDItemCFBundleIdentifier == com.microsoft.Outlook"', {
        encoding: 'utf8',
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Check if Outlook for macOS is currently running.
 */
export function isOutlookRunning(): boolean {
  try {
    const result = runAppleScript(
      'tell application "System Events" to return (name of processes) contains "Microsoft Outlook"'
    );
    return result === 'true';
  } catch {
    return false;
  }
}

/**
 * Get the default email address from Outlook.
 */
export function getDefaultEmail(): string | null {
  try {
    const result = runAppleScriptMultiline([
      'tell application "Microsoft Outlook"',
      '  set accts to exchange accounts & imap accounts & pop accounts',
      '  if (count of accts) > 0 then',
      '    return email address of item 1 of accts',
      '  else',
      '    return ""',
      '  end if',
      'end tell',
    ]);
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Discover all configured email accounts in Outlook for macOS.
 * Iterates exchange, imap, and pop account types separately.
 */
export function discoverOutlookAccounts(): OutlookAccountInfo[] {
  try {
    const script = [
      'tell application "Microsoft Outlook"',
      '  set output to ""',
      '  set idx to 1',
      '  repeat with a in exchange accounts',
      '    set row to (email address of a) & "|||" & (name of a) & "|||exchange|||" & idx',
      '    if output is not "" then set output to output & "<<<ROW>>>"',
      '    set output to output & row',
      '    set idx to idx + 1',
      '  end repeat',
      '  set idx to 1',
      '  repeat with a in imap accounts',
      '    set row to (email address of a) & "|||" & (name of a) & "|||imap|||" & idx',
      '    if output is not "" then set output to output & "<<<ROW>>>"',
      '    set output to output & row',
      '    set idx to idx + 1',
      '  end repeat',
      '  set idx to 1',
      '  repeat with a in pop accounts',
      '    set row to (email address of a) & "|||" & (name of a) & "|||pop|||" & idx',
      '    if output is not "" then set output to output & "<<<ROW>>>"',
      '    set output to output & row',
      '    set idx to idx + 1',
      '  end repeat',
      '  return output',
      'end tell',
    ];

    const raw = runAppleScriptMultiline(script);
    if (!raw) return [];

    const accounts: OutlookAccountInfo[] = [];
    for (const row of raw.split(ROW_DELIM)) {
      const parts = row.split(DELIM);
      if (parts.length < 4) continue;
      const [email, name, accountType, indexStr] = parts;
      accounts.push({
        email: email.trim(),
        name: name.trim(),
        accountType: accountType.trim() as OutlookAccountType,
        accountIndex: parseInt(indexStr.trim(), 10) || 1,
      });
    }
    return accounts;
  } catch {
    return [];
  }
}

/**
 * Parse raw AppleScript message output rows into AppleScriptMailMessage objects.
 */
function parseMessageRows(raw: string): AppleScriptMailMessage[] {
  if (!raw) return [];

  const rows = raw.split(ROW_DELIM);
  const messages: AppleScriptMailMessage[] = [];

  for (const row of rows) {
    const parts = row.split(DELIM);
    if (parts.length < 9) continue;

    const [id, subject, senderName, senderEmail, dateStr, content, isReadStr, conversationId, recipStr] = parts;

    let receivedAt: number;
    try {
      receivedAt = new Date(dateStr).getTime();
      if (isNaN(receivedAt)) {
        console.warn(`[outlook-applescript] Could not parse date: "${dateStr}", using Date.now()`);
        receivedAt = Date.now();
      }
    } catch {
      console.warn(`[outlook-applescript] Date parse error for: "${dateStr}", using Date.now()`);
      receivedAt = Date.now();
    }

    messages.push({
      id: id.trim(),
      subject: subject.trim(),
      senderName: senderName.trim(),
      senderEmail: senderEmail.trim(),
      receivedAt,
      content: content.trim(),
      isRead: isReadStr.trim() === 'true',
      conversationId: conversationId.trim() || subject.trim(),
      toRecipients: recipStr ? recipStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
    });
  }

  return messages;
}

/**
 * Build the shared AppleScript message-extraction loop.
 * Returns the script lines between (and excluding) the "tell" and "end tell" wrappers.
 */
function buildMessageExtractionScript(inboxRef: string, limit: number): string[] {
  // NOTE: We do NOT use AppleScript's `whose` filter or in-loop date checks
  // because both fail or behave unreliably on Exchange accounts.
  // Instead we always fetch the latest N messages (Outlook returns newest-first)
  // and rely on DB upsert deduplication. Content is skipped during sync to avoid
  // timeouts — it's lazy-loaded via fetchMessageContent() when user clicks a thread.

  return [
    `  set msgs to messages of ${inboxRef}`,
    `  set maxCount to ${limit}`,
    '  if (count of msgs) < maxCount then set maxCount to (count of msgs)',
    '  set output to ""',
    '  repeat with i from 1 to maxCount',
    '    -- Yield to Outlook UI every iteration to prevent app freeze',
    '    delay 0.05',
    '    set m to item i of msgs',
    '    set msgId to id of m as string',
    '    set msgSubject to subject of m',
    '    set msgSenderName to ""',
    '    set msgSenderEmail to ""',
    '    try',
    '      set s to sender of m',
    '      set msgSenderName to name of s',
    '      set msgSenderEmail to address of s',
    '    end try',
    '    set msgDateObj to time received of m',
    '    set y to year of msgDateObj as string',
    '    set mo to text -2 thru -1 of ("0" & ((month of msgDateObj as integer) as string))',
    '    set d to text -2 thru -1 of ("0" & (day of msgDateObj as string))',
    '    set h to text -2 thru -1 of ("0" & (hours of msgDateObj as string))',
    '    set mi to text -2 thru -1 of ("0" & (minutes of msgDateObj as string))',
    '    set se to text -2 thru -1 of ("0" & (seconds of msgDateObj as string))',
    '    set msgDate to y & "-" & mo & "-" & d & "T" & h & ":" & mi & ":" & se',
    // Skip content during sync — lazy-loaded later via fetchMessageContent()
    '    set msgContent to ""',
    '    set msgIsRead to is read of m as string',
    '    -- Use subject as conversation grouping key',
    '    set convId to msgSubject',
    '    -- Get recipients',
    '    set recipList to ""',
    '    try',
    '      set toRecips to to recipients of m',
    '      repeat with r in toRecips',
    '        if recipList is not "" then set recipList to recipList & ","',
    '        set recipList to recipList & (address of r)',
    '      end repeat',
    '    end try',
    `    set row to msgId & "${DELIM}" & msgSubject & "${DELIM}" & msgSenderName & "${DELIM}" & msgSenderEmail & "${DELIM}" & msgDate & "${DELIM}" & msgContent & "${DELIM}" & msgIsRead & "${DELIM}" & convId & "${DELIM}" & recipList`,
    `    if output is not "" then set output to output & "${ROW_DELIM}"`,
    '    set output to output & row',
    '  end repeat',
    '  return output',
  ];
}

/**
 * Fetch recent inbox messages from Outlook.
 *
 * @param limit - Max number of messages to fetch (default 50)
 * @param sinceDate - Only fetch messages received after this date (epoch ms)
 */
export function fetchInboxMessages(limit: number = 50, _sinceDate?: number): AppleScriptMailMessage[] {
  // Always fetch latest N messages without date filter. DB upsert handles dedup.
  // Content is skipped during sync — loaded on demand via fetchMessageContent().
  const script = [
    'tell application "Microsoft Outlook"',
    ...buildMessageExtractionScript('inbox', limit),
    'end tell',
  ];

  const raw = runAppleScriptMultiline(script);
  return parseMessageRows(raw);
}

/**
 * Async version of fetchInboxMessages — does not block Node event loop.
 */
export async function fetchInboxMessagesAsync(limit: number = 50, _sinceDate?: number): Promise<AppleScriptMailMessage[]> {
  const script = [
    'tell application "Microsoft Outlook"',
    ...buildMessageExtractionScript('inbox', limit),
    'end tell',
  ];

  const raw = await runAppleScriptAsync(script, 'fetch-global-inbox');
  return parseMessageRows(raw);
}

/**
 * Fetch inbox messages for a specific Outlook account.
 * Uses `inbox of item N of {type} accounts` to target a single account.
 * Falls back to global fetchInboxMessages() if the per-account syntax fails.
 *
 * @param accountType - 'exchange' | 'imap' | 'pop'
 * @param accountIndex - 1-based index within the account type list
 * @param limit - Max number of messages to fetch (default 50)
 * @param sinceDate - Only fetch messages received after this date (epoch ms)
 */
export function fetchInboxMessagesForAccount(
  accountType: OutlookAccountType,
  accountIndex: number,
  limit: number = 50,
  sinceDate?: number,
): AppleScriptMailMessage[] {
  // Always fetch latest N messages without date filter. DB upsert handles dedup.
  // Content is skipped during sync — loaded on demand via fetchMessageContent().
  const inboxRef = `inbox of item ${accountIndex} of ${accountType} accounts`;

  const script = [
    'tell application "Microsoft Outlook"',
    ...buildMessageExtractionScript(inboxRef, limit),
    'end tell',
  ];

  try {
    const raw = runAppleScriptMultiline(script);
    return parseMessageRows(raw);
  } catch {
    // Fall back to global inbox if per-account syntax fails
    return fetchInboxMessages(limit, sinceDate);
  }
}

/**
 * Async version of fetchInboxMessagesForAccount — does not block Node event loop.
 */
export async function fetchInboxMessagesForAccountAsync(
  accountType: OutlookAccountType,
  accountIndex: number,
  limit: number = 50,
  sinceDate?: number,
): Promise<AppleScriptMailMessage[]> {
  const inboxRef = `inbox of item ${accountIndex} of ${accountType} accounts`;
  const label = `fetch-${accountType}${accountIndex}`;

  const script = [
    'tell application "Microsoft Outlook"',
    ...buildMessageExtractionScript(inboxRef, limit),
    'end tell',
  ];

  try {
    const raw = await runAppleScriptAsync(script, label);
    return parseMessageRows(raw);
  } catch (err: any) {
    // If per-account fetch timed out, don't retry with global inbox (would also timeout)
    if (err.message?.includes('TIMEOUT')) {
      console.warn(`[outlook] Skipping global inbox fallback for ${label} — per-account already timed out`);
      throw err;
    }
    console.warn(`[outlook] Per-account fetch failed for ${label}, falling back to global inbox: ${err.message}`);
    return fetchInboxMessagesAsync(limit, sinceDate);
  }
}

/**
 * Async version of fetchMessageContent — does not block Node event loop.
 */
export async function fetchMessageContentAsync(messageId: string): Promise<string> {
  console.log(`[outlook-applescript] fetchMessageContentAsync called with id=${messageId}`);
  try {
    const result = await runAppleScriptAsync([
      'tell application "Microsoft Outlook"',
      `  set m to message id ${messageId}`,
      '  set msgContent to ""',
      '  try',
      '    set msgContent to plain text content of m',
      '  end try',
      '  if msgContent is "" or msgContent is missing value then',
      '    -- Open message to force body download from Exchange',
      '    open m',
      '    delay 1',
      '    try',
      '      set msgContent to plain text content of m',
      '    end try',
      '  end if',
      '  if msgContent is "" or msgContent is missing value then',
      '    try',
      '      set msgContent to content of m',
      '    end try',
      '  end if',
      '  if msgContent is missing value then set msgContent to ""',
      '  -- Truncate to 4000 chars',
      '  if length of msgContent > 4000 then',
      '    set msgContent to text 1 thru 4000 of msgContent',
      '  end if',
      '  -- Close the message window if we opened one',
      '  try',
      `    close (every window whose name contains subject of m)`,
      '  end try',
      '  return msgContent',
      'end tell',
    ], `content-${messageId}`);
    console.log(`[outlook-applescript] fetchMessageContentAsync result: ${result?.length ?? 0} chars`);
    return result ?? '';
  } catch (err: any) {
    console.error(`[outlook-applescript] fetchMessageContentAsync error for id=${messageId}:`, err.message);
    return '';
  }
}

/**
 * Send a reply to a message in Outlook via AppleScript.
 *
 * @param messageId - The Outlook message ID to reply to
 * @param replyContent - The text content of the reply
 */
export function sendOutlookReply(messageId: string, replyContent: string): void {
  // Escape content for AppleScript
  const escaped = replyContent
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const script = [
    'tell application "Microsoft Outlook"',
    `  set origMsg to message id ${messageId}`,
    '  set replyMsg to reply to origMsg',
    `  set plain text content of replyMsg to "${escaped}"`,
    '  send replyMsg',
    'end tell',
  ];

  runAppleScriptMultiline(script);
}

/**
 * Fetch the full content of a message by its Outlook ID.
 * Opens the message to force Exchange to download the body,
 * reads content, then closes the window.
 *
 * @param messageId - The Outlook message ID (numeric string)
 * @returns The plain text content, or HTML-stripped content, or empty string
 */
export function fetchMessageContent(messageId: string): string {
  try {
    const result = runAppleScriptMultiline([
      'tell application "Microsoft Outlook"',
      `  set m to message id ${messageId}`,
      '  set msgContent to ""',
      '  try',
      '    set msgContent to plain text content of m',
      '  end try',
      '  if msgContent is "" or msgContent is missing value then',
      '    -- Open message to force body download from Exchange',
      '    open m',
      '    delay 1',
      '    try',
      '      set msgContent to plain text content of m',
      '    end try',
      '  end if',
      '  if msgContent is "" or msgContent is missing value then',
      '    try',
      '      set msgContent to content of m',
      '    end try',
      '  end if',
      '  if msgContent is missing value then set msgContent to ""',
      '  -- Truncate to 4000 chars',
      '  if length of msgContent > 4000 then',
      '    set msgContent to text 1 thru 4000 of msgContent',
      '  end if',
      '  -- Close the message window if we opened one',
      '  try',
      `    close (every window whose name contains subject of m)`,
      '  end try',
      '  return msgContent',
      'end tell',
    ]);
    return result ?? '';
  } catch {
    return '';
  }
}

/**
 * Fetch content for multiple messages by their Outlook IDs.
 * Returns a Map of messageId → content.
 */
export function fetchMultipleMessageContents(messageIds: string[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const id of messageIds) {
    const content = fetchMessageContent(id);
    results.set(id, content);
  }
  return results;
}

/**
 * Get the count of unread messages in the inbox.
 */
export function getUnreadCount(): number {
  try {
    const result = runAppleScriptMultiline([
      'tell application "Microsoft Outlook"',
      '  return unread count of inbox',
      'end tell',
    ]);
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}
