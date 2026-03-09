import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { generateAndPublish } from './generate-page.js';
import {
  isGeniConfigured,
  geniGetProfile,
  geniGetImmediateFamily,
  geniGetAncestors,
  geniSearch,
  geniPathTo,
  geniGetMyProfile,
} from './geni.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const AUTH_DIR = join(__dirname, 'whatsapp-auth', 'default');
const SOUL_PATH = join(__dirname, 'SOUL.md');
const FAMILY_PATH = join(__dirname, 'FAMILY.md');
const FAMILY_JSON_PATH = join(__dirname, 'family-tree.json');
const MEMORY_PATH = join(__dirname, 'MEMORY.md');
const GROUP_CONFIG_PATH = join(__dirname, 'group-config.json');
const MODEL = 'claude-sonnet-4-5-20250929';
const SITE_URL = 'https://family.mreider.com/';

// Mention triggers (case-insensitive)
const TRIGGERS = ['roro', 'grandma', 'grandmother', 'rosie', 'rose'];

// --- Group access control ---
// { groupJid: string, members: string[], lastRefresh: number }
let groupConfig = { groupJid: null, members: [], lastRefresh: 0 };
const MEMBER_REFRESH_INTERVAL = 10 * 60 * 1000; // refresh members every 10 min

function loadGroupConfig() {
  try {
    groupConfig = JSON.parse(readFileSync(GROUP_CONFIG_PATH, 'utf-8'));
    console.log(`[acl] Loaded group config: ${groupConfig.groupJid} (${groupConfig.members.length} members)`);
  } catch {
    console.log('[acl] No group config found. Will auto-discover on first group message.');
  }
}

function saveGroupConfig() {
  writeFileSync(GROUP_CONFIG_PATH, JSON.stringify(groupConfig, null, 2), 'utf-8');
}

async function refreshGroupMembers(sock) {
  if (!groupConfig.groupJid) return;
  try {
    const meta = await sock.groupMetadata(groupConfig.groupJid);
    groupConfig.members = meta.participants.map(p => p.id);
    groupConfig.lastRefresh = Date.now();
    saveGroupConfig();
    console.log(`[acl] Refreshed members: ${groupConfig.members.length} people`);
  } catch (err) {
    console.error('[acl] Failed to refresh members:', err.message);
  }
}

function isAuthorizedSender(senderJid) {
  if (!groupConfig.groupJid) return true; // no group set yet, allow all
  if (groupConfig.members.length === 0) return true; // no members cached yet
  const senderNum = senderJid?.split('@')[0]?.split(':')[0];
  return groupConfig.members.some(m => {
    const memberNum = m.split('@')[0].split(':')[0];
    return memberNum === senderNum;
  });
}

// --- Conversation management ---
let conversation = { messages: [], lastActivity: Date.now() };
const MAX_HISTORY = 30;
const HISTORY_TTL = 60 * 60 * 1000;

function getConversation() {
  if ((Date.now() - conversation.lastActivity) >= HISTORY_TTL) {
    conversation = { messages: [], lastActivity: Date.now() };
  }
  return conversation;
}

function addToConversation(role, content) {
  const conv = getConversation();
  conv.messages.push({ role, content });
  conv.lastActivity = Date.now();
  while (conv.messages.length > MAX_HISTORY * 2) conv.messages.shift();
  while (conv.messages.length > 0 && conv.messages[0].role !== 'user') conv.messages.shift();
}

function addGroupContext(senderName, text) {
  const conv = getConversation();
  const contextMsg = `[${senderName}]: ${text}`;
  const last = conv.messages[conv.messages.length - 1];
  if (last && last.role === 'user') {
    last.content += '\n' + contextMsg;
  } else {
    conv.messages.push({ role: 'user', content: contextMsg });
  }
  conv.lastActivity = Date.now();
  while (conv.messages.length > MAX_HISTORY * 2) conv.messages.shift();
}

// --- File helpers ---
function loadFile(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

// --- System prompt ---
function buildSystemPrompt() {
  const soul = loadFile(SOUL_PATH);
  const family = loadFile(FAMILY_PATH);
  const familyJson = loadFile(FAMILY_JSON_PATH);
  const memory = loadFile(MEMORY_PATH);

  let prompt = '';
  if (soul) prompt += soul + '\n\n';
  if (family) prompt += '---\n\n# Family Tree (Narrative)\n\n' + family + '\n\n';
  if (familyJson) {
    prompt += '---\n\n# Structured Family Data\n\n```json\n' + familyJson + '\n```\n\n';
  }
  if (memory) prompt += '---\n\n# Saved Notes\n\n' + memory + '\n\n';

  prompt += `---

# Instructions

You are RoRo in a WhatsApp chat. You maintain the Sampson-Kahn family tree.

Messages from family members appear as [Name]: message. Use conversation history to follow threads.

Rules:
- Be direct and factual. Short messages. No filler.
- You know the family tree. Use the data above to answer. Don't say "I'm not sure" about things that are in your data.
- If something is genuinely unknown or contested, say so plainly with what evidence exists.
- If someone shares new info (dates, corrections, life events), update the tree and confirm what you changed. Use [REMEMBER: note] for your memory file.
- When adding or updating entries, always include a "verification" field: "verified" (primary source), "documented" (secondary source), "family knowledge" (who said it, when), "theory" (evidence + gaps), or "contested" (conflicting evidence). Ask for sources when people share info.
- If someone shares a URL or asks you to research something, use your web_fetch tool to read it.
- If you update the family tree data, offer to republish the family page.
- The family page is at ${SITE_URL}
- Don't use terms of endearment. Use real names.
- You have tools available: web_fetch (read URLs), update_family_tree (modify the JSON data), update_family_narrative (modify FAMILY.md), and republish_page (regenerate and push the website). Use them when appropriate.
- You also have Geni.com tools for exploring the online family tree: geni_search (find people by name), geni_profile (get full profile details), geni_family (get someone's immediate family — parents, siblings, partners, children), geni_ancestors (get ancestor tree), and geni_path (find how two people are related). Use these when someone asks about connections, wants to explore branches, or when you need to cross-reference Geni data with your local tree.
- Matt's Geni profile ID is profile-2160559. Use it as a starting point when exploring the tree.
- When presenting Geni data, include the profile IDs in brackets like [profile-123456] so you can look up more details if asked.
`;

  return prompt;
}

// --- Tool definitions for Claude ---
const TOOLS = [
  {
    name: 'web_fetch',
    description: 'Fetch and read the contents of a URL. Use this to research genealogical records, read documents or links shared by family members, or look up historical information.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        question: { type: 'string', description: 'What you want to find out from this page' },
      },
      required: ['url'],
    },
  },
  {
    name: 'update_family_tree',
    description: 'Update the structured family tree JSON. You can add a new person, update an existing person, or correct information. The data is an array of person objects with fields like name, born, died, relation, spouse, notes, parents, sources, verification. Always include a "verification" field indicating the evidence level: "verified — [source]", "documented — [source]", "family knowledge — [who, when]", "theory — [evidence]", or "contested — [explanation]".',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update'], description: 'Whether to add a new person or update an existing one' },
        name: { type: 'string', description: 'Full name of the person (used as the key to find existing entries)' },
        data: { type: 'object', description: 'The fields to set or update. For "add", include all known fields. For "update", include only the fields to change.' },
      },
      required: ['action', 'name', 'data'],
    },
  },
  {
    name: 'update_family_narrative',
    description: 'Append or update a section in the family narrative (FAMILY.md). Use this when you have new information that should be reflected in the written family history.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Which section to update (e.g., "Your Grandchildren", "The Sephardic Question")' },
        content: { type: 'string', description: 'The text to append to that section. Keep it factual and concise.' },
      },
      required: ['section', 'content'],
    },
  },
  {
    name: 'republish_page',
    description: 'Regenerate the family history website from current data and publish it to GitHub Pages. Use this after making tree updates, or when someone asks to refresh the page.',
    input_schema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Optional context about what changed or what to focus on' },
      },
    },
  },
];

// --- Geni tools (added dynamically if configured) ---
if (isGeniConfigured()) {
  console.log('[geni] Geni.com integration enabled');
  TOOLS.push(
    {
      name: 'geni_search',
      description: 'Search for people in the Geni.com family tree by name. Returns matching profiles with IDs you can use with other Geni tools.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name to search for (e.g., "Rose Kahn", "Sampson")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'geni_profile',
      description: 'Get detailed profile information for a person on Geni.com. Returns birth/death dates, locations, and biographical details.',
      input_schema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'Geni profile ID (e.g., "profile-2160559")' },
        },
        required: ['profile_id'],
      },
    },
    {
      name: 'geni_family',
      description: 'Get the immediate family of a person on Geni.com — parents, partners, children, and siblings. Each person includes their profile ID for further lookup.',
      input_schema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'Geni profile ID (e.g., "profile-2160559")' },
        },
        required: ['profile_id'],
      },
    },
    {
      name: 'geni_ancestors',
      description: 'Get the ancestor tree for a person on Geni.com. Returns parents, grandparents, and further back.',
      input_schema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string', description: 'Geni profile ID (e.g., "profile-2160559")' },
        },
        required: ['profile_id'],
      },
    },
    {
      name: 'geni_path',
      description: 'Find the relationship path between two people on Geni.com. Shows how they are connected through the family tree.',
      input_schema: {
        type: 'object',
        properties: {
          from_id: { type: 'string', description: 'Starting profile ID' },
          to_id: { type: 'string', description: 'Target profile ID' },
        },
        required: ['from_id', 'to_id'],
      },
    },
  );
} else {
  console.log('[geni] Geni.com not configured — run geni-auth.js to enable');
}

// --- Tool executors ---
async function executeTool(toolName, input) {
  switch (toolName) {
    case 'web_fetch':
      return await toolWebFetch(input);
    case 'update_family_tree':
      return await toolUpdateFamilyTree(input);
    case 'update_family_narrative':
      return await toolUpdateFamilyNarrative(input);
    case 'republish_page':
      return await toolRepublishPage(input);
    case 'geni_search':
      return await geniSearch(input.name);
    case 'geni_profile':
      return await geniGetProfile(input.profile_id);
    case 'geni_family':
      return await geniGetImmediateFamily(input.profile_id);
    case 'geni_ancestors':
      return await geniGetAncestors(input.profile_id);
    case 'geni_path':
      return await geniPathTo(input.from_id, input.to_id);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

async function toolWebFetch({ url, question }) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'RoRo-FamilyTreeBot/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${resp.statusText}` };
    const contentType = resp.headers.get('content-type') || '';
    let text;
    if (contentType.includes('text/html')) {
      const html = await resp.text();
      // Strip tags for a rough text extraction
      text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      text = await resp.text();
    }
    // Truncate to ~8000 chars to stay within reason
    if (text.length > 8000) text = text.slice(0, 8000) + '\n[...truncated]';
    return { url, content: text, question: question || null };
  } catch (err) {
    return { error: `Failed to fetch ${url}: ${err.message}` };
  }
}

async function toolUpdateFamilyTree({ action, name, data }) {
  try {
    const raw = loadFile(FAMILY_JSON_PATH);
    const tree = JSON.parse(raw);

    if (action === 'add') {
      const exists = tree.find(p => p.name === name);
      if (exists) return { error: `"${name}" already exists. Use action "update" instead.` };
      tree.push({ name, ...data });
      writeFileSync(FAMILY_JSON_PATH, JSON.stringify(tree, null, 2), 'utf-8');
      return { success: true, message: `Added "${name}" to family tree.` };
    }

    if (action === 'update') {
      const person = tree.find(p => p.name === name);
      if (!person) return { error: `"${name}" not found in family tree. Use action "add" to create.` };
      Object.assign(person, data);
      writeFileSync(FAMILY_JSON_PATH, JSON.stringify(tree, null, 2), 'utf-8');
      return { success: true, message: `Updated "${name}" in family tree.`, updated_fields: Object.keys(data) };
    }

    return { error: `Unknown action: ${action}` };
  } catch (err) {
    return { error: `Failed to update family tree: ${err.message}` };
  }
}

async function toolUpdateFamilyNarrative({ section, content }) {
  try {
    let narrative = loadFile(FAMILY_PATH);
    const sectionHeader = `## ${section}`;
    const idx = narrative.indexOf(sectionHeader);
    if (idx >= 0) {
      // Find end of section (next ## or end of file)
      const nextSection = narrative.indexOf('\n## ', idx + sectionHeader.length);
      const insertAt = nextSection >= 0 ? nextSection : narrative.length;
      narrative = narrative.slice(0, insertAt).trimEnd() + '\n\n' + content + '\n\n' + narrative.slice(insertAt);
    } else {
      // Append new section
      narrative = narrative.trimEnd() + '\n\n' + sectionHeader + '\n\n' + content + '\n';
    }
    writeFileSync(FAMILY_PATH, narrative, 'utf-8');
    return { success: true, message: `Updated section "${section}" in family narrative.` };
  } catch (err) {
    return { error: `Failed to update narrative: ${err.message}` };
  }
}

async function toolRepublishPage({ context } = {}) {
  try {
    const ok = await generateAndPublish(context || '');
    if (ok) {
      return { success: true, message: `Page republished at ${SITE_URL}` };
    }
    return { error: 'Page was generated but git push failed. Matt may need to check.' };
  } catch (err) {
    return { error: `Failed to republish: ${err.message}` };
  }
}

// --- Memory persistence ---
function appendMemory(text) {
  const timestamp = new Date().toISOString().split('T')[0];
  appendFileSync(MEMORY_PATH, `\n- ${timestamp}: ${text}`, 'utf-8');
  console.log('[memory] saved:', text);
}

// --- Mention detection ---
function isMentioned(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => new RegExp(`\\b${t}\\b`, 'i').test(lower));
}

// --- Claude API ---
const anthropic = new Anthropic();

// --- Should RoRo respond? (lightweight classifier for group messages) ---
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

async function shouldRoRoRespond(text, senderName, recentContext) {
  try {
    const recent = recentContext.slice(-6).map(m => m.content).join('\n');
    const resp = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 3,
      system: `You are a classifier. RoRo is a family historian bot in a WhatsApp group chat for the Sampson-Kahn family. She maintains the family tree, knows genealogy, and can look things up on Geni.com.

Respond YES if the message is directed at RoRo or is something she should answer — family questions, genealogy, requests about the family tree/page, follow-ups to something she said, or questions only she would know. Also YES if someone is clearly talking to her even without using her name.

Respond NO if it's casual chat between family members, greetings not aimed at her, discussions about plans/logistics, or anything unrelated to family history.

Only output YES or NO.`,
      messages: [{
        role: 'user',
        content: `Recent chat context:\n${recent}\n\nNew message from ${senderName}: ${text}`,
      }],
    });
    const answer = resp.content[0]?.text?.trim().toUpperCase();
    console.log(`[classify] "${text.slice(0, 60)}" → ${answer}`);
    return answer === 'YES';
  } catch (err) {
    console.error('[classify] error:', err.message);
    return false; // fail closed — don't respond if classifier fails
  }
}

// --- Claude API with tool use ---
async function askRoRo(message, senderName) {
  const systemPrompt = buildSystemPrompt();
  const userContent = senderName ? `[${senderName}]: ${message}` : message;
  addToConversation('user', userContent);

  const conv = getConversation();

  try {
    // Tool-use loop: keep calling until Claude produces a final text response
    let messages = [...conv.messages];
    let finalText = '';
    let iterations = 0;
    const MAX_ITERATIONS = 8; // safety limit

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages,
        tools: TOOLS,
      });

      // Collect text blocks and tool_use blocks
      const textBlocks = response.content.filter(b => b.type === 'text');
      const toolBlocks = response.content.filter(b => b.type === 'tool_use');

      // Accumulate any text
      for (const block of textBlocks) {
        if (block.text) finalText += (finalText ? '\n' : '') + block.text;
      }

      // If no tool calls, we're done
      if (toolBlocks.length === 0) break;

      // Execute tool calls and build tool results
      const assistantMsg = { role: 'assistant', content: response.content };
      const toolResults = [];

      for (const tool of toolBlocks) {
        console.log(`[tool] ${tool.name}(${JSON.stringify(tool.input).slice(0, 200)})`);
        const result = await executeTool(tool.name, tool.input);
        console.log(`[tool] ${tool.name} → ${JSON.stringify(result).slice(0, 200)}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result),
        });
      }

      // Add assistant message and tool results, then loop
      messages = [...messages, assistantMsg, { role: 'user', content: toolResults }];

      // If stop_reason is end_turn (not tool_use), break
      if (response.stop_reason === 'end_turn') break;
    }

    // Extract memory markers from final text
    const memoryMatch = finalText.match(/\[REMEMBER:(.+?)\]/s);
    let cleanText = finalText;
    if (memoryMatch) {
      appendMemory(memoryMatch[1].trim());
      cleanText = finalText.replace(/\[REMEMBER:.+?\]/s, '').trim();
    }

    addToConversation('assistant', cleanText);
    return cleanText;
  } catch (err) {
    console.error('[claude] error:', err.message);
    return null;
  }
}

// --- WhatsApp connection ---
const logger = pino({ level: 'silent' });

async function startBot() {
  loadGroupConfig();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['RoRo Bot', 'Chrome', '120.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('[whatsapp] QR code — scan to connect');
    if (connection === 'open') {
      console.log('[whatsapp] Connected!');
      // Refresh group members on connect
      if (groupConfig.groupJid) await refreshGroupMembers(sock);
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('[whatsapp] Logged out. Delete auth and re-pair.');
        process.exit(1);
      } else {
        console.log(`[whatsapp] Disconnected (${statusCode}). Reconnecting in 3s...`);
        setTimeout(startBot, 3000);
      }
    }
  });

  // Track group membership changes
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (id === groupConfig.groupJid) {
      console.log(`[acl] Group membership changed: ${action} ${participants.length} members`);
      await refreshGroupMembers(sock);
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (!msg.message) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        '';

      if (!text) continue;

      const chatJid = msg.key.remoteJid;
      const isGroup = chatJid.endsWith('@g.us');
      const senderJid = isGroup ? msg.key.participant : chatJid;
      const senderName = msg.pushName || senderJid?.split('@')[0] || 'Someone';

      // --- Auto-discover main group ---
      if (isGroup && !groupConfig.groupJid) {
        // First group we see a mention in becomes our group
        if (isMentioned(text)) {
          groupConfig.groupJid = chatJid;
          console.log(`[acl] Auto-discovered main group: ${chatJid}`);
          await refreshGroupMembers(sock);
        }
      }

      // --- Access control ---
      if (!isAuthorizedSender(senderJid)) {
        // Not a member of the family group — skip entirely
        continue;
      }

      // Periodic member refresh
      if (groupConfig.groupJid && (Date.now() - groupConfig.lastRefresh) > MEMBER_REFRESH_INTERVAL) {
        refreshGroupMembers(sock).catch(() => {});
      }

      // Read receipt
      await sock.readMessages([msg.key]).catch(() => {});

      // Check for @ mention
      const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const ourPhone = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
      const ourLid = sock.user?.lid?.split(':')[0] || sock.user?.lid?.split('@')[0] || '';
      let mappedLid = '';
      try {
        const lidFile = join(AUTH_DIR, `lid-mapping-${ourPhone}.json`);
        mappedLid = JSON.parse(readFileSync(lidFile, 'utf-8'));
      } catch {}
      const wasAtMentioned = mentionedJids.some(jid => {
        const jidNum = jid.split('@')[0];
        return jidNum === ourPhone || jidNum === ourLid || jidNum === mappedLid;
      });

      let shouldRespond = !isGroup || isMentioned(text) || wasAtMentioned;

      // If not explicitly mentioned in a group, ask the classifier
      if (isGroup && !shouldRespond) {
        addGroupContext(senderName, text);
        const conv = getConversation();
        shouldRespond = await shouldRoRoRespond(text, senderName, conv.messages);
        if (!shouldRespond) continue;
      }

      console.log(`[msg] ${senderName}: ${text}`);

      // Show typing indicator
      await sock.sendPresenceUpdate('composing', chatJid);

      const reply = await askRoRo(text, senderName);

      await sock.sendPresenceUpdate('paused', chatJid);

      if (reply) {
        await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
        console.log(`[roro] ${reply}`);
      }
    }
  });
}

// --- Startup ---
if (!existsSync(MEMORY_PATH)) {
  writeFileSync(MEMORY_PATH, '# Saved Notes\n', 'utf-8');
}

console.log('[roro-bot] Starting...');
startBot().catch(err => {
  console.error('[roro-bot] Fatal:', err);
  process.exit(1);
});
