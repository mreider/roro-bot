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

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const AUTH_DIR = join(__dirname, 'whatsapp-auth', 'default');
const SOUL_PATH = join(__dirname, 'SOUL.md');
const FAMILY_PATH = join(__dirname, 'FAMILY.md');
const FAMILY_JSON_PATH = join(__dirname, 'family-tree.json');
const MEMORY_PATH = join(__dirname, 'MEMORY.md');
const MODEL = 'claude-sonnet-4-5-20250929';

// Mention triggers (case-insensitive)
const TRIGGERS = ['roro', 'grandma', 'grandmother', 'rosie', 'rose'];

// Single shared conversation across all chats (no privacy boundaries)
// { messages: [{role, content}], lastActivity: timestamp }
let conversation = { messages: [], lastActivity: Date.now() };
const MAX_HISTORY = 30;        // max message pairs to keep
const HISTORY_TTL = 60 * 60 * 1000; // 1 hour — after this, context resets

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
  while (conv.messages.length > MAX_HISTORY * 2) {
    conv.messages.shift();
  }
  while (conv.messages.length > 0 && conv.messages[0].role !== 'user') {
    conv.messages.shift();
  }
}

// Track messages RoRo doesn't respond to (group chatter) for context
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
  while (conv.messages.length > MAX_HISTORY * 2) {
    conv.messages.shift();
  }
}

// --- Load personality & knowledge ---
function loadFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function buildSystemPrompt() {
  const soul = loadFile(SOUL_PATH);
  const family = loadFile(FAMILY_PATH);
  const familyJson = loadFile(FAMILY_JSON_PATH);
  const memory = loadFile(MEMORY_PATH);

  let prompt = '';
  if (soul) prompt += soul + '\n\n';
  if (family) prompt += '---\n\n# Family Tree\n\n' + family + '\n\n';
  if (familyJson) {
    prompt += '---\n\n# Structured Family Data\n\nThis JSON has detailed info on every family member. Use it to answer specific questions about dates, places, relationships:\n\n```json\n' + familyJson + '\n```\n\n';
  }
  if (memory) prompt += '---\n\n# Things You\'ve Learned from Chat\n\n' + memory + '\n\n';

  prompt += `---

# Instructions

You are in a WhatsApp group chat with your family. You've been mentioned or addressed.
Respond as RoRo — warmly, briefly, in character. This is WhatsApp, keep messages short (1-3 sentences usually).

The conversation history is provided so you can follow threads. Messages from family members appear as [Name]: message. Your previous responses appear as your messages. Use this context to follow up naturally — if someone says "when?" you should know what they're referring to from the prior messages.

CRITICAL RULES:
- NEVER use terms of endearment (no "dear", "darling", "sweetheart", "honey", "love"). Use real names.
- You know your entire family tree deeply. Never say family history is "hazy" or you "don't remember." The data is right here.
- Keep responses short and natural. This is texting, not letter-writing.
- If someone shares family info (birthdays, milestones, corrections), acknowledge it warmly. The system will save it.
- If someone gives you a personality tip, acknowledge it gracefully.
`;

  return prompt;
}

// --- Memory persistence ---
function appendMemory(text) {
  const timestamp = new Date().toISOString().split('T')[0];
  const entry = `\n- ${timestamp}: ${text}`;
  appendFileSync(MEMORY_PATH, entry, 'utf-8');
  console.log('[memory] saved:', text);
}

// --- Mention detection ---
function isMentioned(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TRIGGERS.some(t => {
    const regex = new RegExp(`\\b${t}\\b`, 'i');
    return regex.test(lower);
  });
}

// --- Page generation trigger ---
const PAGE_TRIGGERS = ['update the page', 'update the website', 'update the site', 'make a new page', 'redo the page', 'refresh the page', 'rebuild the page', 'generate the page', 'update the family page'];
const SITE_URL = 'https://mreider.github.io/roro-bot/';

function isPageRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return PAGE_TRIGGERS.some(t => lower.includes(t));
}

// --- Claude API ---
const anthropic = new Anthropic();

async function askRoRo(message, senderName) {
  const systemPrompt = buildSystemPrompt();

  const userContent = senderName
    ? `[${senderName}]: ${message}`
    : message;

  // Add this message to shared conversation
  addToConversation('user', userContent);

  const conv = getConversation();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: conv.messages,
    });

    const text = response.content[0]?.text || '';

    // Check if response contains memory instructions (bracketed at the end)
    const memoryMatch = text.match(/\[REMEMBER:(.+?)\]/s);
    let cleanText = text;
    if (memoryMatch) {
      appendMemory(memoryMatch[1].trim());
      cleanText = text.replace(/\[REMEMBER:.+?\]/s, '').trim();
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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['RoRo Bot', 'Chrome', '120.0'],
  });

  // Save auth state on update
  sock.ev.on('creds.update', saveCreds);

  // Connection events
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[whatsapp] QR code received — scan with WhatsApp to connect');
    }

    if (connection === 'open') {
      console.log('[whatsapp] Connected!');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = DisconnectReason;

      if (statusCode === reason.loggedOut) {
        console.log('[whatsapp] Logged out. Delete auth and re-pair.');
        process.exit(1);
      } else {
        console.log(`[whatsapp] Disconnected (${statusCode}). Reconnecting in 3s...`);
        setTimeout(startBot, 3000);
      }
    }
  });

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip own messages, status broadcasts, protocol messages
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

      // Send read receipt
      await sock.readMessages([msg.key]).catch(() => {});

      // Check for WhatsApp @ mention (mentionedJid may use LID or phone JID)
      const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const ourPhone = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0] || '';
      const ourLid = sock.user?.lid?.split(':')[0] || sock.user?.lid?.split('@')[0] || '';
      let mappedLid = '';
      try {
        const lidFile = join(AUTH_DIR, `lid-mapping-${ourPhone}.json`);
        mappedLid = JSON.parse(readFileSync(lidFile, 'utf-8'));
      } catch {};
      const wasAtMentioned = mentionedJids.some(jid => {
        const jidNum = jid.split('@')[0];
        return jidNum === ourPhone || jidNum === ourLid || jidNum === mappedLid;
      });

      const shouldRespond = !isGroup || isMentioned(text) || wasAtMentioned;

      if (isGroup && !shouldRespond) {
        // Still track the message for context even if we don't respond
        addGroupContext(senderName, text);
        continue;
      }

      console.log(`[msg] ${senderName}: ${text}`);

      // Show typing indicator
      await sock.sendPresenceUpdate('composing', chatJid);

      // Check if this is a page generation request
      if (isPageRequest(text)) {
        console.log(`[page] Page generation requested by ${senderName}`);
        await sock.sendMessage(chatJid, { text: `Let me put that together. This takes a moment.` }, { quoted: msg });

        try {
          const ok = await generateAndPublish(text);
          await sock.sendPresenceUpdate('paused', chatJid);
          if (ok) {
            await sock.sendMessage(chatJid, { text: `There. I've updated the family page.\n\n${SITE_URL}` });
          } else {
            await sock.sendMessage(chatJid, { text: `I wrote the page, but had trouble publishing it. Matt may need to check the connection to GitHub.` });
          }
        } catch (err) {
          console.error('[page] Generation failed:', err.message);
          await sock.sendPresenceUpdate('paused', chatJid);
          await sock.sendMessage(chatJid, { text: `Something went wrong putting the page together. Matt, would you take a look?` });
        }
        continue;
      }

      const reply = await askRoRo(text, senderName);

      // Stop typing indicator
      await sock.sendPresenceUpdate('paused', chatJid);

      if (reply) {
        await sock.sendMessage(chatJid, { text: reply }, { quoted: msg });
        console.log(`[roro] ${reply}`);
      }
    }
  });
}

// --- Ensure MEMORY.md exists ---
if (!existsSync(MEMORY_PATH)) {
  writeFileSync(MEMORY_PATH, '# Things RoRo Has Learned\n', 'utf-8');
}

console.log('[roro-bot] Starting...');
startBot().catch(err => {
  console.error('[roro-bot] Fatal:', err);
  process.exit(1);
});
