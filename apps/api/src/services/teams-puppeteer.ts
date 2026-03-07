/**
 * Microsoft Teams Web automation via Network Interception.
 *
 * Instead of scraping the Teams DOM (fragile, breaks on every UI update),
 * this module intercepts the REST API calls that Teams Web itself makes.
 * Teams Web is a React SPA that fetches chat lists and messages via internal
 * REST APIs — we passively capture those structured JSON responses.
 *
 * Architecture:
 *   1. Connect to Chrome via SharedBrowserManager
 *   2. Set up response interceptors on the Teams tab
 *   3. Capture: chat list JSON, message JSON, auth token
 *   4. For polling: use captured auth token + direct HTTP fetch
 *   5. For sending: DOM interaction (compose box) or direct API POST
 *
 * Prerequisites:
 *   Chrome launched with:
 *     /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *       --remote-debugging-port=9222 \
 *       --user-data-dir="$HOME/prism-chrome-profile"
 *   Teams Web logged in at https://teams.microsoft.com
 */

import type { Page, HTTPResponse } from 'puppeteer-core';
import { sharedBrowser } from './shared-browser';

const TEAMS_BASE_URL = 'https://teams.microsoft.com';
const TEAMS_CHAT_URL = 'https://teams.microsoft.com/v2/';

/** Page key in SharedBrowserManager */
const PAGE_KEY = 'teams';

/** How long to wait for Teams initial load */
const INITIAL_LOAD_WAIT_MS = 8000;

// ============================================================
//  Public Types
// ============================================================

export interface TeamsChatItem {
  /** Chat/thread ID (from Teams API, stable) */
  id: string;
  /** Display name (person or group name) */
  name: string;
  /** Last message preview */
  lastMessage: string;
  /** Timestamp string or ISO date */
  time: string;
  /** Unread message count */
  unreadCount: number;
  /** Group chat flag */
  isGroup: boolean;
  /** Index in list (for fallback operations) */
  index: number;
}

export interface TeamsMessage {
  /** Message ID from Teams */
  id: string;
  /** Sender display name */
  sender: string;
  /** Message body text (HTML stripped) */
  content: string;
  /** ISO timestamp */
  time: string;
  /** Whether this is the logged-in user's message */
  isMe: boolean;
}

// ============================================================
//  Internal Cache — populated by network interception
// ============================================================

interface TeamsApiCache {
  /** Intercepted chat list (normalized) */
  chatList: TeamsChatItem[];
  /** Per-chat messages, keyed by chat/thread ID */
  messages: Map<string, TeamsMessage[]>;
  /** Bearer token extracted from intercepted requests */
  authToken: string | null;
  /** Full set of headers from a successful Teams API request (for replay) */
  capturedHeaders: Record<string, string>;
  /** Timestamp of last chat list update */
  lastChatListUpdate: number;
  /** Discovered API base URL (varies by tenant/region) */
  chatServiceBaseUrl: string | null;
  /** Discovered endpoints (populated during interception) */
  discoveredEndpoints: {
    chatList: string | null;
    messages: string | null;  // pattern with {threadId} placeholder
  };
  /** Logged-in user ID (for isMe detection) */
  userId: string | null;
  /** Whether interceptors are active */
  intercepting: boolean;
}

const cache: TeamsApiCache = {
  chatList: [],
  messages: new Map(),
  authToken: null,
  capturedHeaders: {},
  lastChatListUpdate: 0,
  chatServiceBaseUrl: null,
  discoveredEndpoints: { chatList: null, messages: null },
  userId: null,
  intercepting: false,
};

/** All discovered API calls (for debugging / discovery mode) */
const discoveryLog: { method: string; url: string; status: number; timestamp: number }[] = [];

// ============================================================
//  URL Pattern Matching
// ============================================================

/**
 * Known patterns for Teams chat list API.
 * Teams uses different API backends depending on version/region.
 * These are ordered by likelihood; first match wins.
 *
 * Teams v2 uses regional CSA endpoints like:
 *   /api/csa/{region}/api/v3/teams/users/me/updates  (contains recent chats)
 *   /api/csa/{region}/api/v1/teams/users/me/discover  (discovery)
 *   /api/chatsvc/{region}/v1/users/ME/conversations    (direct chat list)
 */
const CHAT_LIST_PATTERNS = [
  // Teams v2 CSA regional endpoints (amer, emea, apac, etc.)
  /\/api\/csa\/[a-z]+\/api\/v\d+\/teams\/users\/me\/updates/i,
  /\/api\/csa\/[a-z]+\/api\/v\d+\/teams\/users\/me\/discover/i,
  // Teams v2 Chat Service — direct conversations endpoint
  /\/api\/chatsvc\/[a-z]+\/v\d+\/users\/ME\/conversations(?:\/?)(?:\?|$)/i,
  // Teams v2 Chat Service Aggregator
  /\/api\/csa\/api\/v\d+\/teams\/users\/ME\/conversations/i,
  /\/api\/csa.*\/conversations(?:\/?)(?:\?|$)/i,
  // Legacy / alternative endpoints
  /chatsvcagg.*\/threads/i,
  /\/v\d+\/users\/ME\/conversations\?/i,
];

const MESSAGES_PATTERNS = [
  // Teams v2 chatsvc with regional prefix (observed: /api/chatsvc/amer/v1/users/ME/conversations/{id}/messages)
  /\/api\/chatsvc\/[a-z]+\/v\d+\/users\/ME\/conversations\/[^/]+\/messages/i,
  /\/api\/csa.*\/messages/i,
  /chatsvcagg.*\/messages/i,
  /\/v\d+\/users\/ME\/conversations\/[^/]+\/messages/i,
  /teams\.microsoft\.com.*\/messages/i,
];

/** Patterns for Teams user profile (to extract userId) */
const USER_PROFILE_PATTERNS = [
  /\/api\/mt.*\/users\/\w+\/properties/i,
  /\/api\/csa.*\/me/i,
  // Teams v2 user settings endpoint
  /\/api\/csa\/[a-z]+\/api\/v\d+\/teams\/users\/me(?:\/|$)/i,
];

function matchesPattern(url: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(url));
}

// ============================================================
//  Network Interception
// ============================================================

/**
 * Set up response interceptors on the Teams page.
 * Passively captures API responses as Teams makes its own requests.
 */
function setupNetworkInterception(page: Page): void {
  if (cache.intercepting) return;

  page.on('response', async (response: HTTPResponse) => {
    try {
      await handleInterceptedResponse(response);
    } catch {
      // Ignore parse errors on non-JSON responses
    }
  });

  cache.intercepting = true;
  console.log('[teams-puppeteer] Network interception active');
}

async function handleInterceptedResponse(response: HTTPResponse): Promise<void> {
  const url = response.url();
  const status = response.status();

  // Only process successful JSON responses from Teams
  if (status < 200 || status >= 300) return;
  if (!url.includes('teams.microsoft.com') &&
      !url.includes('chatsvcagg') &&
      !url.includes('api.spaces') &&
      !url.includes('substrate.office.com') &&
      !url.includes('ng.msg.teams.microsoft.com')) return;

  const contentType = response.headers()['content-type'] || '';
  if (!contentType.includes('json')) return;

  // Extract auth token from request headers
  const reqHeaders = response.request().headers();
  const authHeader = reqHeaders['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    cache.authToken = authHeader.slice(7);
    // Capture useful headers for replay
    cache.capturedHeaders = {
      authorization: authHeader,
      'x-ms-client-type': reqHeaders['x-ms-client-type'] || '',
      'x-ms-scenario-id': reqHeaders['x-ms-scenario-id'] || '',
      'x-ms-session-id': reqHeaders['x-ms-session-id'] || '',
    };
  }

  // Extract userId from URL patterns (e.g., 8:orgid:xxxx in URL paths)
  if (!cache.userId) {
    const orgIdMatch = url.match(/(?:8%3A|8:)orgid[%3A:]([a-f0-9-]+)/i);
    if (orgIdMatch) {
      cache.userId = `8:orgid:${orgIdMatch[1]}`;
      console.log(`[teams-puppeteer] Extracted userId from URL: ${cache.userId}`);
    }
  }

  // Discovery log (keep last 200 entries)
  discoveryLog.push({
    method: response.request().method(),
    url: url.length > 200 ? url.slice(0, 200) + '...' : url,
    status,
    timestamp: Date.now(),
  });
  if (discoveryLog.length > 200) discoveryLog.shift();

  // --- Chat list interception ---
  if (matchesPattern(url, CHAT_LIST_PATTERNS)) {
    // Store the endpoint URL even if we can't parse the body
    const chatListUrl = url.split('?')[0];
    if (!cache.discoveredEndpoints.chatList) {
      // Prefer the /conversations endpoint over /updates or /discover for direct API
      if (chatListUrl.includes('/conversations')) {
        cache.discoveredEndpoints.chatList = chatListUrl;
        console.log(`[teams-puppeteer] Discovered chat list endpoint: ${chatListUrl}`);
      }
    }

    try {
      const json = await response.json();
      const chats = parseChatListResponse(json, url);
      if (chats.length > 0) {
        cache.chatList = chats;
        cache.lastChatListUpdate = Date.now();
        cache.discoveredEndpoints.chatList = chatListUrl;
        console.log(`[teams-puppeteer] Intercepted chat list: ${chats.length} chats from ${chatListUrl}`);
      }
    } catch {
      // Response body may already be consumed by the Teams app — this is expected.
    }
  }

  // --- Messages interception ---
  if (matchesPattern(url, MESSAGES_PATTERNS)) {
    // Always extract the endpoint template from the URL, even if body parsing fails
    if (!cache.discoveredEndpoints.messages) {
      const templateUrl = url.replace(
        /\/conversations\/[^/]+\/messages/i,
        '/conversations/{threadId}/messages'
      ).split('?')[0];
      cache.discoveredEndpoints.messages = templateUrl;
      console.log(`[teams-puppeteer] Discovered messages endpoint: ${templateUrl}`);
    }

    try {
      const json = await response.json();
      const { chatId, messages } = parseMessagesResponse(json, url);
      if (chatId && messages.length > 0) {
        cache.messages.set(chatId, messages);
        console.log(`[teams-puppeteer] Intercepted ${messages.length} messages for chat ${chatId.slice(0, 30)}...`);
      }
    } catch {
      // Response body may already be consumed by the Teams app — this is expected.
      // We still got the endpoint template above, which is what matters for direct API calls.
    }
  }

  // --- User profile interception ---
  if (matchesPattern(url, USER_PROFILE_PATTERNS) && !cache.userId) {
    try {
      const json = await response.json();
      cache.userId = extractUserId(json);
      if (cache.userId) {
        console.log(`[teams-puppeteer] Detected user ID: ${cache.userId}`);
      }
    } catch {
      // Ignore
    }
  }
}

// ============================================================
//  Response Parsers (adapt to Teams' actual JSON format)
// ============================================================

/**
 * Parse a chat list API response into normalized TeamsChatItem[].
 *
 * Teams API responses vary by version, but typically have:
 *   { conversations: [...] } or { threads: [...] } or { value: [...] }
 *   or for /updates: { chats: [...] } or nested { deltaRoster: { members: {...}, chats: [...] } }
 */
function parseChatListResponse(json: any, _url: string): TeamsChatItem[] {
  const items: TeamsChatItem[] = [];

  // Handle /updates endpoint — may have nested structure
  if (json.deltaRoster?.chats && Array.isArray(json.deltaRoster.chats)) {
    return parseConversationArray(json.deltaRoster.chats);
  }
  if (json.chats && Array.isArray(json.chats)) {
    return parseConversationArray(json.chats);
  }

  // Handle /updates that returns { eventMessages: [...] } containing chat metadata
  if (json.eventMessages && Array.isArray(json.eventMessages)) {
    const chatItems = extractChatsFromEventMessages(json.eventMessages);
    if (chatItems.length > 0) return chatItems;
  }

  // Try different response shapes
  const conversations: any[] =
    json.conversations ?? json.threads ?? json.value ?? [];

  if (!Array.isArray(conversations)) {
    // Maybe the root is the array itself
    if (Array.isArray(json)) {
      return parseConversationArray(json);
    }
    return items;
  }

  return parseConversationArray(conversations);
}

/**
 * Extract chat items from /updates eventMessages response.
 * Each eventMessage may contain thread/conversation metadata.
 */
function extractChatsFromEventMessages(events: any[]): TeamsChatItem[] {
  const items: TeamsChatItem[] = [];
  const seen = new Set<string>();

  for (const evt of events) {
    const resource = evt.resource ?? evt;

    // Look for conversation/thread data in the event
    const id = resource.id ?? resource.threadId ?? resource.conversationId ?? '';
    if (!id || seen.has(id)) continue;

    // Only include chat-like items (skip channel messages, etc.)
    const threadType = resource.threadType ?? resource.type ?? '';
    if (threadType === 'channel' || threadType === 'meeting') continue;

    const name =
      resource.displayName ??
      resource.topic ??
      resource.threadProperties?.topic ??
      extractParticipantNames(resource) ??
      '';

    if (!name && !id.includes('@unq.gbl.spaces')) continue; // Skip unidentifiable entries

    seen.add(id);
    items.push({
      id,
      name: stripHtml(name || `Chat ${items.length + 1}`),
      lastMessage: stripHtml(
        resource.lastMessage?.content ??
        resource.lastMessage?.body?.content ??
        resource.preview ??
        ''
      ).slice(0, 200),
      time:
        resource.lastMessage?.composetime ??
        resource.lastModifiedTime ??
        resource.version ??
        '',
      unreadCount: resource.unreadCount ?? 0,
      isGroup: resource.isGroup ?? (resource.members?.length > 2 ? true : false),
      index: items.length,
    });
  }

  return items;
}

/**
 * Map of user GUID → display name, built from observed API responses.
 * Used to resolve 1:1 chat names when the user sent the last message.
 */
const knownUserNames = new Map<string, string>();

function parseConversationArray(conversations: any[]): TeamsChatItem[] {
  const items: TeamsChatItem[] = [];
  const myGuid = extractMyGuid();

  // First pass: collect GUID → name mappings from lastMessage.imdisplayname
  for (const conv of conversations) {
    const imdisplayname = conv.lastMessage?.imdisplayname;
    const fromUrl: string = conv.lastMessage?.from ?? '';
    if (imdisplayname && fromUrl) {
      const guidMatch = fromUrl.match(/8:orgid:([a-f0-9-]+)/i);
      if (guidMatch) {
        const guid = guidMatch[1];
        // Only store if it's not the current user (compare by GUID only)
        if (!myGuid || guid !== myGuid) {
          knownUserNames.set(guid, imdisplayname);
        }
      }
    }
  }

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    if (!conv) continue;

    // Extract ID
    const id: string = conv.id ?? conv.threadId ?? conv.conversationId ?? conv.chatId ?? '';
    if (!id) continue;

    // --- Filter out system threads ---
    // All 48:* IDs are system threads (notifications, mentions, calllogs, etc.)
    if (id.startsWith('48:')) continue;
    const productType: string = conv.threadProperties?.productThreadType ?? '';
    if (productType === 'StreamOfNotifications') continue;

    // --- Classify conversation type ---
    const isMeeting = id.includes('meeting_');
    const tpThreadType: string = conv.threadProperties?.threadType ?? '';
    const isOneOnOne = tpThreadType === 'chat' &&
      (conv.threadProperties?.uniquerosterthread === 'true' ||
       conv.threadProperties?.uniquerosterthread === 'True');
    const isGroupChat = tpThreadType === 'chat' && !isOneOnOne;
    const isChannel = conv.threadProperties?.spaceType === 'standard' ||
      conv.threadProperties?.spaceType === 'private';

    // --- Extract display name ---
    let name = '';

    if (conv.displayName) {
      name = conv.displayName;
    } else if (conv.threadProperties?.spaceThreadTopic) {
      // Teams channel / space
      name = conv.threadProperties.spaceThreadTopic;
    } else if (conv.topic || conv.threadProperties?.topic) {
      name = conv.topic ?? conv.threadProperties?.topic ?? '';
    }

    // For 1:1 chats with no displayName: use lastMessage sender or resolve from GUID
    if (!name && isOneOnOne) {
      name = resolve1on1ChatName(conv, myGuid);
    }

    // For group chats with no displayName: try participant names
    if (!name && isGroupChat) {
      name = extractParticipantNames(conv) ?? '';
      if (!name) {
        // Try to get a name from lastMessage sender as hint
        const sender = conv.lastMessage?.imdisplayname ?? '';
        if (sender) {
          name = `${sender} and others`;
        }
      }
    }

    // Final fallback
    if (!name) {
      // Skip unnamed channels and system threads silently
      if (isChannel) continue;
      name = `Chat ${items.length + 1}`;
    }

    // --- Last message preview ---
    const lastMessageContent =
      conv.lastMessage?.content ??
      conv.lastMessage?.body?.content ??
      conv.preview ??
      conv.recentMessage?.content ??
      '';

    // --- Timestamp ---
    const time =
      conv.lastMessage?.composetime ??
      conv.lastMessage?.originalarrivaltime ??
      conv.lastModifiedTime ??
      conv.lastUpdatedTime ??
      conv.version?.toString() ??
      '';

    // --- Unread count ---
    const unreadCount =
      conv.unreadCount ??
      conv.unreadMessageCount ??
      (conv.isRead === false ? 1 : 0);

    items.push({
      id,
      name: stripHtml(name),
      lastMessage: stripHtml(lastMessageContent).slice(0, 200),
      time: typeof time === 'string' ? time : '',
      unreadCount: typeof unreadCount === 'number' ? unreadCount : 0,
      isGroup: isGroupChat || isMeeting,
      index: i,
    });
  }

  // Sort: non-meeting chats first, then by time descending
  items.sort((a, b) => {
    const aIsMeeting = a.id.includes('meeting_');
    const bIsMeeting = b.id.includes('meeting_');
    if (aIsMeeting !== bIsMeeting) return aIsMeeting ? 1 : -1;
    // Sort by time descending (most recent first)
    if (a.time && b.time) return b.time.localeCompare(a.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });

  // Re-index after sort
  items.forEach((item, idx) => item.index = idx);

  return items;
}

/**
 * Resolve the display name for a 1:1 chat.
 *
 * Strategy:
 * 1. If lastMessage.imdisplayname is the OTHER person → use it
 * 2. Extract the other person's GUID from thread ID → look up in knownUserNames
 * 3. Use addedBy GUID as hint
 */
function resolve1on1ChatName(conv: any, myGuid: string): string {
  const imdisplayname = conv.lastMessage?.imdisplayname ?? '';
  const fromUrl: string = conv.lastMessage?.from ?? '';
  const fromGuidMatch = fromUrl.match(/8:orgid:([a-f0-9-]+)/i);
  const fromGuid = fromGuidMatch?.[1] ?? '';

  // If last message is from the other person, their name is imdisplayname
  if (imdisplayname && fromGuid && fromGuid !== myGuid) {
    return imdisplayname;
  }

  // Extract the other person's GUID from the thread ID
  const otherGuid = extractOtherGuid(conv, myGuid);
  if (otherGuid) {
    // Look up in our name cache
    const knownName = knownUserNames.get(otherGuid);
    if (knownName) return knownName;
  }

  // Try addedBy field
  const addedBy: string = conv.properties?.addedBy ?? '';
  const addedByGuid = addedBy.match(/8:orgid:([a-f0-9-]+)/i)?.[1] ?? addedBy;
  if (addedByGuid && addedByGuid !== myGuid) {
    const knownName = knownUserNames.get(addedByGuid);
    if (knownName) return knownName;
  }

  return '';
}

/**
 * Extract our own GUID from the cached userId (format: "8:orgid:{guid}").
 */
function extractMyGuid(): string {
  if (!cache.userId) return '';
  const match = cache.userId.match(/8:orgid:([a-f0-9-]+)/i);
  return match?.[1] ?? '';
}

/**
 * Extract the other person's GUID from a 1:1 thread ID.
 * Thread ID format: "19:{guidA}_{guidB}@unq.gbl.spaces" or similar
 */
function extractOtherGuid(conv: any, myGuid: string): string {
  const originalId: string = conv.threadProperties?.originalThreadId ?? conv.id ?? '';
  // Extract the two GUIDs from the thread ID
  const guidPattern = /19:([a-f0-9-]+)_([a-f0-9-]+)@/i;
  const match = originalId.match(guidPattern);
  if (!match) return '';
  const [, guidA, guidB] = match;
  if (guidA === myGuid) return guidB;
  if (guidB === myGuid) return guidA;
  return guidA; // fallback: return first one
}

/**
 * Resolve names for chats still showing generic "Chat N" names.
 * Uses the Teams API to fetch individual conversation details with member info.
 * Called after initial parsing to enrich unresolved 1:1 chat names.
 */
async function enrichChatNames(chats: TeamsChatItem[]): Promise<TeamsChatItem[]> {
  if (!cache.authToken) return chats;

  const unresolvedChats = chats.filter(c =>
    c.name.match(/^Chat \d+$/) && !c.id.includes('meeting_')
  );

  if (unresolvedChats.length === 0) return chats;

  console.log(`[teams-puppeteer] Resolving names for ${unresolvedChats.length} unresolved chats...`);
  const region = detectRegion();
  const myGuid = extractMyGuid();

  // Batch-fetch conversation details (limit concurrency to avoid rate limits)
  const batchSize = 5;
  for (let i = 0; i < unresolvedChats.length; i += batchSize) {
    const batch = unresolvedChats.slice(i, i + batchSize);
    const promises = batch.map(async (chat) => {
      try {
        const encodedId = encodeURIComponent(chat.id);

        // Strategy 1: Fetch conversation detail with members
        const url = `https://teams.microsoft.com/api/chatsvc/${region}/v1/users/ME/conversations/${encodedId}?view=msnp24Equivalent`;
        const resp = await fetch(url, {
          headers: {
            Authorization: `Bearer ${cache.authToken!}`,
            Accept: 'application/json',
          },
        });
        if (!resp.ok) return;
        const detail: any = await resp.json();

        // Look for members array in the detailed response
        const members = detail.members ?? detail.participants ?? detail.roster ??
          detail.threadMembers ?? detail.memberProperties ?? [];
        if (Array.isArray(members) && members.length > 0) {
          const otherMembers = members.filter((m: any) => {
            const mri: string = m.mri ?? m.id ?? '';
            const guid = mri.match(/8:orgid:([a-f0-9-]+)/i)?.[1] ?? '';
            return guid !== myGuid;
          });

          if (otherMembers.length > 0) {
            const otherNames = otherMembers
              .map((m: any) => m.displayName ?? m.friendlyName ?? m.name ?? '')
              .filter((n: string) => n.length > 0);

            if (otherNames.length > 0) {
              chat.name = otherNames.join(', ');
              // Cache the mapping for future use
              for (const m of otherMembers) {
                const mri: string = m.mri ?? m.id ?? '';
                const guid = mri.match(/8:orgid:([a-f0-9-]+)/i)?.[1] ?? '';
                const dname = m.displayName ?? m.friendlyName ?? '';
                if (guid && dname) {
                  knownUserNames.set(guid, dname);
                }
              }
              return; // resolved!
            }
          }
        }

        // Strategy 2: For 1:1 chats, try resolving the other GUID via People API
        const otherGuid = extractOtherGuid({ id: chat.id, threadProperties: detail.threadProperties ?? {} }, myGuid);
        if (otherGuid && !knownUserNames.has(otherGuid)) {
          try {
            const peopleUrl = `https://teams.microsoft.com/api/mt/${region}/beta/users/8:orgid:${otherGuid}/properties?throwIfNotFound=false`;
            const pResp = await fetch(peopleUrl, {
              headers: {
                Authorization: `Bearer ${cache.authToken!}`,
                Accept: 'application/json',
              },
            });
            if (pResp.ok) {
              const pData: any = await pResp.json();
              const resolvedName = pData.displayName ?? pData.givenName ??
                pData.teamsDisplayName ?? '';
              if (resolvedName) {
                knownUserNames.set(otherGuid, resolvedName);
                chat.name = resolvedName;
                return;
              }
            }
          } catch {
            // Silently skip
          }
        } else if (otherGuid && knownUserNames.has(otherGuid)) {
          chat.name = knownUserNames.get(otherGuid)!;
          return;
        }
      } catch {
        // Silently skip individual failures
      }
    });

    await Promise.all(promises);
  }

  console.log(`[teams-puppeteer] Name resolution complete. Known users: ${knownUserNames.size}`);
  return chats;
}

function parseMessagesResponse(json: any, url: string): { chatId: string; messages: TeamsMessage[] } {
  const messages: TeamsMessage[] = [];

  // Extract chatId from URL
  // URL may look like: /conversations/19%3A...%40thread.tacv2%3Bmessageid%3D1234/messages
  // We need to strip the `;messageid=xxx` suffix and URL-decode to get the clean thread ID
  const chatIdMatch = url.match(/conversations\/([^/?\s]+)/i) ??
                      url.match(/threads\/([^/?\s]+)/i);
  let chatId = chatIdMatch?.[1] ?? '';
  // URL-decode and strip ;messageid=xxx suffix
  try { chatId = decodeURIComponent(chatId); } catch { /* keep as-is */ }
  chatId = chatId.replace(/;messageid=\d+$/i, '');

  // Try different response shapes
  const rawMessages: any[] =
    json.messages ?? json.value ?? json.replyChain ?? [];

  if (!Array.isArray(rawMessages)) return { chatId, messages };

  for (const msg of rawMessages) {
    if (!msg) continue;

    const id = msg.id ?? msg.messageId ?? msg.clientmessageid ?? '';
    const sender =
      msg.from?.user?.displayName ??
      msg.imdisplayname ??
      msg.from?.displayName ??
      msg.sender?.displayName ??
      '';
    const content =
      msg.body?.content ??
      msg.content ??
      msg.text ??
      '';
    const time =
      msg.composetime ??
      msg.createdDateTime ??
      msg.originalarrivaltime ??
      '';

    // Skip system messages
    const msgType = msg.messagetype ?? msg.messageType ?? '';
    if (msgType && msgType !== 'Text' && msgType !== 'RichText/Html' && msgType !== 'RichText') {
      continue;
    }

    if (!content) continue;

    const isMe = isOwnMessage(msg);

    messages.push({
      id,
      sender: sender || (isMe ? 'Me' : ''),
      content: stripHtml(content).slice(0, 500),
      time: typeof time === 'string' ? time : '',
      isMe,
    });
  }

  return { chatId, messages };
}

function extractParticipantNames(conv: any): string | null {
  const members = conv.members ?? conv.participants ?? conv.threadMembers ?? [];
  if (!Array.isArray(members) || members.length === 0) return null;
  const names = members
    .map((m: any) => m.displayName ?? m.name ?? '')
    .filter((n: string) => n.length > 0);
  if (names.length === 0) return null;
  return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
}

function extractUserId(json: any): string | null {
  return json.objectId ?? json.id ?? json.userId ?? json.mri ?? null;
}

function isOwnMessage(msg: any): boolean {
  if (cache.userId) {
    const fromId = msg.from?.user?.id ?? msg.from?.id ?? msg.creator ?? '';
    if (fromId === cache.userId) return true;
  }
  // Heuristic: messages sent by "me" often have clientmessageid but no imdisplayname
  return false;
}

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
//  Public API
// ============================================================

/**
 * Connect to Teams Web and start network interception.
 */
export async function connectToTeams(): Promise<void> {
  if (isTeamsConnected() && cache.intercepting) {
    console.log('[teams-puppeteer] Already connected and intercepting');
    return;
  }

  const page = await sharedBrowser.getOrCreatePage(
    PAGE_KEY,
    'teams.microsoft.com',  // match existing tab
    TEAMS_CHAT_URL           // navigate if creating new tab
  );

  setupNetworkInterception(page);

  // Wait for Teams to load and make its initial API calls
  console.log(`[teams-puppeteer] Waiting ${INITIAL_LOAD_WAIT_MS}ms for Teams to load...`);
  await sleep(INITIAL_LOAD_WAIT_MS);

  // Navigate to Chat tab if not already there
  await navigateToChatTab(page);
  await sleep(3000); // Wait for chat list API call

  console.log(`[teams-puppeteer] Initial load complete. Cached: ${cache.chatList.length} chats, token: ${cache.authToken ? 'yes' : 'no'}`);
}

/**
 * Check if Puppeteer is connected to Teams.
 */
export function isTeamsConnected(): boolean {
  return sharedBrowser.isPageAlive(PAGE_KEY);
}

/**
 * Disconnect from Teams (close the tab).
 */
export async function disconnectTeams(): Promise<void> {
  await sharedBrowser.closePage(PAGE_KEY);
  resetCache();
  console.log('[teams-puppeteer] Disconnected');
}

/**
 * Read the chat list.
 *
 * Priority:
 * 1. Direct API call using captured auth token + discovered endpoint (fast)
 * 2. Return cached data from network interception
 * 3. Probe known conversation endpoints with auth token
 * 4. DOM scraping fallback
 * 5. Refresh page to trigger new interception
 */
export async function readChatList(): Promise<TeamsChatItem[]> {
  // Try direct API if we have token + endpoint
  if (cache.authToken && cache.discoveredEndpoints.chatList) {
    try {
      const chats = await fetchChatListDirect();
      if (chats.length > 0) return await enrichChatNames(chats);
    } catch (err: any) {
      console.warn(`[teams-puppeteer] Direct API failed: ${err.message}`);
    }
  }

  // Return cache if fresh enough (< 2 minutes)
  const cacheAge = Date.now() - cache.lastChatListUpdate;
  if (cache.chatList.length > 0 && cacheAge < 120_000) {
    return cache.chatList;
  }

  // Try refreshing token if it's null (e.g., after a 401)
  if (!cache.authToken) {
    await refreshAuthToken();
  }

  // Probe known conversations endpoints (try multiple regions)
  if (cache.authToken) {
    try {
      const chats = await probeConversationsEndpoint();
      if (chats.length > 0) return await enrichChatNames(chats);
    } catch (err: any) {
      console.warn(`[teams-puppeteer] Probe failed: ${err.message}`);
    }
  }

  // DOM scraping fallback — read chat names directly from the page
  if (cache.chatList.length === 0) {
    try {
      const chats = await scrapeChatListFromDOM();
      if (chats.length > 0) {
        cache.chatList = chats;
        cache.lastChatListUpdate = Date.now();
        console.log(`[teams-puppeteer] DOM scraping got ${chats.length} chats`);
        return chats;
      }
    } catch (err: any) {
      console.warn(`[teams-puppeteer] DOM scrape failed: ${err.message}`);
    }
  }

  // Trigger refresh by reloading the page
  await triggerChatListRefresh();

  // One more DOM scrape attempt after refresh
  if (cache.chatList.length === 0) {
    try {
      const chats = await scrapeChatListFromDOM();
      if (chats.length > 0) {
        cache.chatList = chats;
        cache.lastChatListUpdate = Date.now();
      }
    } catch {
      // Final fallback exhausted
    }
  }

  return cache.chatList;
}

/**
 * Read messages for a specific chat.
 *
 * Priority:
 * 1. Direct API call with captured token
 * 2. Navigate to chat in Teams UI to trigger interception
 * 3. Return cached messages
 */
export async function readChatMessages(chatId: string): Promise<TeamsMessage[]> {
  // Try direct API
  if (cache.authToken && cache.discoveredEndpoints.messages) {
    try {
      return await fetchMessagesDirect(chatId);
    } catch (err: any) {
      console.warn(`[teams-puppeteer] Direct messages API failed: ${err.message}`);
    }
  }

  // Navigate to chat to trigger interception
  await openChatForInterception(chatId);

  // Return intercepted messages
  return cache.messages.get(chatId) ?? [];
}

/**
 * Open a chat by clicking on it in the chat list (triggers message interception).
 */
export async function openChat(chatIndex: number, chatName?: string): Promise<boolean> {
  const page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) return false;

  const label = chatName ?? `index ${chatIndex}`;
  console.log(`[teams-puppeteer] Opening chat: ${label}`);

  // Use name-based clicking for reliability
  const escapedName = chatName ? chatName.replace(/'/g, "\\'").replace(/\\/g, '\\\\') : '';

  const clicked = await page.evaluate(`
    (function() {
      var targetName = '${escapedName}';
      var items = document.querySelectorAll('[role="listitem"], [role="treeitem"], [data-tid*="chat-list-item"]');

      // Try name match first
      if (targetName) {
        for (var i = 0; i < items.length; i++) {
          var text = (items[i].textContent || '').trim();
          if (text.indexOf(targetName) > -1) {
            items[i].click();
            return true;
          }
        }
      }

      // Fallback: index
      if (${chatIndex} < items.length) {
        items[${chatIndex}].click();
        return true;
      }
      return false;
    })()
  `) as boolean;

  if (clicked) {
    await sleep(3000); // Wait for messages API call
    console.log(`[teams-puppeteer] Opened chat: ${label}`);
  }

  return clicked;
}

/**
 * Send a message in the currently open chat.
 * This is the only operation that requires DOM interaction.
 */
export async function sendMessage(text: string): Promise<boolean> {
  const page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) return false;

  console.log(`[teams-puppeteer] Sending message (${text.length} chars)...`);

  // Find compose box
  const composeSelector =
    '[data-tid="ckeditor"] [contenteditable="true"], ' +
    '[role="textbox"][contenteditable="true"], ' +
    '[class*="compose"] [contenteditable="true"]';

  try {
    await page.waitForSelector(composeSelector, { timeout: 5000 });
    await page.click(composeSelector);
    await sleep(300);
    await page.type(composeSelector, text);
    await sleep(300);
    await page.keyboard.press('Enter');
    console.log('[teams-puppeteer] Message sent');
    return true;
  } catch (err: any) {
    console.warn(`[teams-puppeteer] Failed to send message: ${err.message}`);
    return false;
  }
}

/**
 * Get the cached auth token (for external use, e.g., TeamsConnector).
 */
export function getCachedAuthToken(): string | null {
  return cache.authToken;
}

/**
 * Get discovery log (for debugging).
 */
export function getDiscoveryLog(): typeof discoveryLog {
  return [...discoveryLog];
}

/**
 * Get cache status (for debugging / status endpoint).
 */
export function getCacheStatus() {
  return {
    chatListCount: cache.chatList.length,
    cachedChatIds: [...cache.messages.keys()],
    hasToken: !!cache.authToken,
    lastUpdate: cache.lastChatListUpdate,
    discoveredEndpoints: cache.discoveredEndpoints,
    userId: cache.userId,
    intercepting: cache.intercepting,
    discoveryLogSize: discoveryLog.length,
  };
}

// ============================================================
//  Probing & DOM Fallback
// ============================================================

/**
 * Detect the chat service region from intercepted URLs.
 * Teams v2 uses regional prefixes like 'amer', 'emea', 'apac'.
 */
function detectRegion(): string {
  // Check discoveryLog for region patterns
  for (const entry of discoveryLog) {
    const regionMatch = entry.url.match(/\/api\/(?:chatsvc|csa)\/([a-z]+)\//i);
    if (regionMatch) return regionMatch[1];
  }
  return 'amer'; // Default to Americas
}

/**
 * Probe the conversations endpoint directly using the captured auth token.
 * Tries known URL patterns with detected region.
 */
async function probeConversationsEndpoint(): Promise<TeamsChatItem[]> {
  const token = cache.authToken!;
  const region = detectRegion();

  // Known endpoints to try (ordered by likelihood for Teams v2)
  const endpoints = [
    `https://teams.microsoft.com/api/chatsvc/${region}/v1/users/ME/conversations`,
    `https://teams.microsoft.com/api/csa/${region}/api/v2/teams/users/me/conversations`,
    `https://teams.microsoft.com/api/csa/${region}/api/v1/teams/users/me/conversations`,
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`[teams-puppeteer] Probing: ${endpoint}`);
      const resp = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...filterHeaders(cache.capturedHeaders),
        },
      });

      if (resp.status === 401) {
        console.warn('[teams-puppeteer] Token expired during probe, attempting refresh...');
        const refreshed = await refreshAuthToken();
        if (!refreshed) {
          console.warn('[teams-puppeteer] Token refresh failed');
          return [];
        }
        // Retry this endpoint with fresh token
        const retryResp = await fetch(endpoint, {
          headers: {
            Authorization: `Bearer ${cache.authToken!}`,
            Accept: 'application/json',
            ...filterHeaders(cache.capturedHeaders),
          },
        });
        if (!retryResp.ok) {
          console.log(`[teams-puppeteer] Retry after refresh returned ${retryResp.status}`);
          continue;
        }
        const retryJson = await retryResp.json();
        const retryChats = parseChatListResponse(retryJson, endpoint);
        if (retryChats.length > 0) {
          cache.chatList = retryChats;
          cache.lastChatListUpdate = Date.now();
          cache.discoveredEndpoints.chatList = endpoint;
          console.log(`[teams-puppeteer] Probe success after refresh! ${retryChats.length} chats`);
          return retryChats;
        }
        continue;
      }

      if (!resp.ok) {
        console.log(`[teams-puppeteer] Probe ${endpoint} returned ${resp.status}`);
        continue;
      }

      const json = await resp.json();
      const chats = parseChatListResponse(json, endpoint);
      if (chats.length > 0) {
        cache.chatList = chats;
        cache.lastChatListUpdate = Date.now();
        cache.discoveredEndpoints.chatList = endpoint;
        console.log(`[teams-puppeteer] Probe success! ${chats.length} chats from ${endpoint}`);
        return chats;
      }
    } catch (err: any) {
      console.log(`[teams-puppeteer] Probe ${endpoint} error: ${err.message}`);
    }
  }

  return [];
}

/**
 * DOM scraping fallback — read chat names directly from the Teams page.
 * This is less ideal than API interception but provides a reliable fallback
 * when Teams v2 doesn't use a recognizable REST endpoint for the chat list.
 *
 * Filters out navigation/UI items (Copilot, Mentions, Saved, Favorites, etc.)
 * and only returns actual conversation entries.
 */
async function scrapeChatListFromDOM(): Promise<TeamsChatItem[]> {
  const page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) return [];

  console.log('[teams-puppeteer] Attempting DOM scrape for chat list...');

  const rawChats = await page.evaluate(`
    (function() {
      var results = [];

      // Known Teams UI / navigation labels to exclude (case-insensitive)
      var NAV_ITEMS = [
        'copilot', 'mentions', 'saved', 'favorites', 'recent',
        'all chats', 'contacts', 'notifications', 'search',
        'activity', 'calendar', 'teams', 'calls', 'files',
        'apps', 'help', 'settings', 'more', 'filter',
        'new chat', 'meet now', 'join with a code'
      ];

      function isNavItem(name) {
        var lower = name.toLowerCase().trim();
        for (var i = 0; i < NAV_ITEMS.length; i++) {
          if (lower === NAV_ITEMS[i]) return true;
        }
        return false;
      }

      // Strategy 1: Look for chat list items specifically within a chat pane/list container
      // Teams v2 typically wraps chats in a container with role="list" or specific data-tid
      var chatContainers = document.querySelectorAll(
        '[data-tid*="chat-list"], [data-tid*="chatList"], [role="list"][aria-label*="chat" i], [role="tree"][aria-label*="chat" i]'
      );

      var items = [];
      if (chatContainers.length > 0) {
        // Use items within the chat container only
        for (var c = 0; c < chatContainers.length; c++) {
          var containerItems = chatContainers[c].querySelectorAll('[role="listitem"], [role="treeitem"], li');
          for (var j = 0; j < containerItems.length; j++) {
            items.push(containerItems[j]);
          }
        }
      }

      // Fallback: if no specific chat container found, use broader selectors
      // but be more aggressive about filtering
      if (items.length === 0) {
        var allItems = document.querySelectorAll('[role="listitem"], [role="treeitem"]');
        for (var k = 0; k < allItems.length; k++) {
          items.push(allItems[k]);
        }
      }

      for (var i = 0; i < items.length && i < 100; i++) {
        var el = items[i];

        // Skip items that are clearly navigation (no nested structure / too simple)
        var childCount = el.querySelectorAll('*').length;
        if (childCount < 3) continue; // Real chat items have avatars, text, timestamps

        var nameEl = el.querySelector(
          '[data-tid*="chat-title"], [data-tid*="chatTitle"],' +
          '[class*="chatName"], [class*="displayName"],' +
          'h3, [class*="title"]:not([class*="subtitle"])'
        );
        var previewEl = el.querySelector(
          '[data-tid*="chat-last-message"], [data-tid*="lastMessage"],' +
          '[class*="lastMessage"], [class*="preview"],' +
          '[class*="subtitle"], [class*="secondaryText"]'
        );
        var timeEl = el.querySelector(
          '[data-tid*="timestamp"], time,' +
          '[class*="time"], [class*="date"],' +
          '[class*="timestamp"]'
        );
        var avatarEl = el.querySelector(
          '[class*="avatar"], [class*="Avatar"],' +
          'img[src*="avatar"], img[src*="photo"],' +
          '[data-tid*="avatar"], [role="img"]'
        );

        var name = '';
        if (nameEl) {
          name = nameEl.textContent.trim();
        } else {
          // Try first meaningful text node
          var texts = [];
          var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
          var n;
          var count = 0;
          while ((n = walker.nextNode()) && count < 5) {
            var t = n.textContent.trim();
            if (t.length > 1 && t.length < 100) {
              texts.push(t);
              count++;
            }
          }
          name = texts[0] || '';
        }

        if (!name || name.length < 1) continue;

        // Filter out navigation items
        if (isNavItem(name)) continue;

        // A real chat entry should have at least one of: preview text, timestamp, or avatar
        var hasPreview = previewEl && previewEl.textContent.trim().length > 0;
        var hasTime = timeEl && timeEl.textContent.trim().length > 0;
        var hasAvatar = !!avatarEl;
        if (!hasPreview && !hasTime && !hasAvatar) continue;

        var preview = hasPreview ? previewEl.textContent.trim() : '';
        var time = hasTime ? timeEl.textContent.trim() : '';

        // Check for unread indicator
        var unreadEl = el.querySelector('[class*="unread"], [class*="badge"], [aria-label*="unread"]');
        var unread = unreadEl ? 1 : 0;

        results.push({
          name: name.substring(0, 200),
          preview: preview.substring(0, 200),
          time: time.substring(0, 50),
          unread: unread,
          index: i
        });
      }

      return results;
    })()
  `) as any[];

  if (!Array.isArray(rawChats) || rawChats.length === 0) return [];

  return rawChats.map((c, i) => ({
    id: `dom-chat-${i}-${c.name.replace(/\s+/g, '-').slice(0, 30)}`,
    name: c.name,
    lastMessage: c.preview || '',
    time: c.time || '',
    unreadCount: c.unread || 0,
    isGroup: false, // Cannot reliably detect from DOM
    index: c.index ?? i,
  }));
}

/**
 * Attempt to refresh the auth token by fetching /trap/tokens from Teams.
 * Teams v2 uses this endpoint to issue fresh tokens.
 */
async function refreshAuthToken(): Promise<boolean> {
  const page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) return false;

  console.log('[teams-puppeteer] Attempting token refresh via /trap/tokens...');

  try {
    // Use page.evaluate to make the fetch from within the Teams page context
    // This ensures cookies and session data are included
    const tokenData = await page.evaluate(`
      (async function() {
        try {
          var resp = await fetch('/trap/tokens', { credentials: 'include' });
          if (!resp.ok) return null;
          var data = await resp.json();
          return data;
        } catch(e) {
          return null;
        }
      })()
    `);

    if (tokenData && typeof tokenData === 'object') {
      // Try to extract a chat service token from the response
      const token =
        (tokenData as any).chatSvcAggToken ??
        (tokenData as any).skypeToken ??
        (tokenData as any).tokens?.chatSvcAggToken ??
        (tokenData as any).tokens?.skypeToken ??
        (tokenData as any).regionGtms?.chatSvcAggToken;

      if (token && typeof token === 'string') {
        cache.authToken = token;
        console.log(`[teams-puppeteer] Token refreshed via /trap/tokens (${token.slice(0, 20)}...)`);
        return true;
      }

      // Maybe the token is in a different structure — log keys for discovery
      console.log(`[teams-puppeteer] /trap/tokens keys: ${Object.keys(tokenData as any).join(', ')}`);
    }
  } catch (err: any) {
    console.warn(`[teams-puppeteer] Token refresh failed: ${err.message}`);
  }

  // Fallback: trigger a page navigation to re-capture token from intercepted requests
  console.log('[teams-puppeteer] Triggering page navigation for token re-capture...');
  try {
    await page.evaluate(`
      (function() {
        var chatBtn = document.querySelector('[data-tid="app-bar-chat-button"], [aria-label="Chat"]');
        if (chatBtn) { chatBtn.click(); return; }
        var navItems = document.querySelectorAll('[role="tab"], nav button');
        for (var i = 0; i < navItems.length; i++) {
          var text = (navItems[i].textContent || '').trim().toLowerCase();
          if (text === 'activity') { navItems[i].click(); return; }
        }
      })()
    `);
    await sleep(2000);
    // Navigate back to chat
    await navigateToChatTab(page);
    await sleep(3000);

    return !!cache.authToken;
  } catch {
    return false;
  }
}

// ============================================================
//  Direct API Calls (using captured auth token)
// ============================================================

/**
 * Fetch chat list directly using captured auth token.
 * This is the preferred method during polling — fast and doesn't touch Puppeteer.
 */
async function fetchChatListDirect(): Promise<TeamsChatItem[]> {
  const endpoint = cache.discoveredEndpoints.chatList!;
  const token = cache.authToken!;

  console.log(`[teams-puppeteer] Direct API fetch: ${endpoint}`);

  const resp = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...filterHeaders(cache.capturedHeaders),
    },
  });

  if (resp.status === 401) {
    console.warn('[teams-puppeteer] Token expired (401), will refresh on next page load');
    cache.authToken = null;
    throw new Error('Token expired');
  }

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}`);
  }

  const json = await resp.json();
  const chats = parseChatListResponse(json, endpoint);

  if (chats.length > 0) {
    cache.chatList = chats;
    cache.lastChatListUpdate = Date.now();
  }

  return chats;
}

async function fetchMessagesDirect(chatId: string): Promise<TeamsMessage[]> {
  const endpointTemplate = cache.discoveredEndpoints.messages!;
  // URL-encode the chatId since the template expects an encoded path segment
  const endpoint = endpointTemplate.replace('{threadId}', encodeURIComponent(chatId));
  const token = cache.authToken!;

  const resp = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...filterHeaders(cache.capturedHeaders),
    },
  });

  if (resp.status === 401) {
    cache.authToken = null;
    throw new Error('Token expired');
  }

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}`);
  }

  const json = await resp.json();
  const { messages } = parseMessagesResponse(json, endpoint);
  cache.messages.set(chatId, messages);
  return messages;
}

/**
 * Filter captured headers to only include safe-to-replay ones.
 */
function filterHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'authorization') continue; // Already handled separately
    if (key.startsWith('x-ms-') && value) safe[key] = value;
  }
  return safe;
}

// ============================================================
//  Page Interaction (minimal DOM use)
// ============================================================

/**
 * Navigate to the Chat tab in Teams if not already there.
 */
async function navigateToChatTab(page: Page): Promise<void> {
  const url = page.url();
  if (url.includes('/chat') || url.includes('/conversations')) return;

  await page.evaluate(`
    (function() {
      var chatBtn = document.querySelector('[data-tid="app-bar-chat-button"], [aria-label="Chat"]');
      if (chatBtn) { chatBtn.click(); return; }
      var navItems = document.querySelectorAll('[role="tab"], nav button');
      for (var i = 0; i < navItems.length; i++) {
        var text = (navItems[i].textContent || '').trim().toLowerCase();
        if (text === 'chat' || text === 'chats') { navItems[i].click(); return; }
      }
    })()
  `);

  await sleep(2000);
}

/**
 * Trigger a chat list refresh by navigating Teams to the chat tab.
 */
async function triggerChatListRefresh(): Promise<void> {
  const page = sharedBrowser.getPage(PAGE_KEY);
  if (!page) {
    await connectToTeams();
    return;
  }

  // Navigate to chat tab (triggers chat list API call)
  await navigateToChatTab(page);

  // If still no data, try a page reload
  if (cache.chatList.length === 0) {
    console.log('[teams-puppeteer] No chats in cache, reloading page...');
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // SPA reload might not fire events
    }
    await sleep(INITIAL_LOAD_WAIT_MS);
  }
}

/**
 * Open a specific chat to trigger message interception.
 */
async function openChatForInterception(chatId: string): Promise<void> {
  // Find chat in cached list
  const chat = cache.chatList.find(c => c.id === chatId);
  if (!chat) return;

  await openChat(chat.index, chat.name);
}

// ============================================================
//  Helpers
// ============================================================

function resetCache(): void {
  cache.chatList = [];
  cache.messages.clear();
  cache.authToken = null;
  cache.capturedHeaders = {};
  cache.lastChatListUpdate = 0;
  cache.chatServiceBaseUrl = null;
  cache.discoveredEndpoints = { chatList: null, messages: null };
  cache.userId = null;
  cache.intercepting = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
