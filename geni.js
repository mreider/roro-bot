/**
 * Geni.com API integration for RoRo bot
 * Handles OAuth token refresh and family tree exploration
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'geni-config.json');
const TOKENS_PATH = join(__dirname, 'geni-tokens.json');
const API_BASE = 'https://www.geni.com/api';

// --- Token management ---

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
}

async function refreshAccessToken() {
  const config = loadConfig();
  const tokens = loadTokens();
  if (!config || !tokens?.refresh_token) {
    throw new Error('No Geni config or refresh token available');
  }

  const params = new URLSearchParams({
    client_id: config.client_id,
    client_secret: config.client_secret,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });

  const resp = await fetch('https://www.geni.com/platform/oauth/request_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed: HTTP ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_in: data.expires_in,
    obtained_at: Date.now(),
    expires_at: Date.now() + (data.expires_in * 1000),
  };
  saveTokens(newTokens);
  console.log('[geni] Token refreshed, expires in', Math.round(data.expires_in / 3600), 'hours');
  return newTokens;
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) throw new Error('No Geni tokens — run geni-auth.js first');

  // Refresh if expiring within 5 minutes
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    console.log('[geni] Token expired or expiring soon, refreshing...');
    tokens = await refreshAccessToken();
  }
  return tokens.access_token;
}

// --- API helpers ---

async function geniGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), {
    headers: { 'User-Agent': 'RoRo-FamilyTreeBot/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Geni API ${resp.status}: ${text}`);
  }
  return resp.json();
}

// --- Profile helpers ---

function formatProfile(p) {
  const parts = [];
  const name = p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
  parts.push(`**${name}**`);
  if (p.maiden_name && p.maiden_name !== p.last_name) parts.push(`(née ${p.maiden_name})`);
  if (p.gender) parts.push(`[${p.gender}]`);

  const details = [];
  if (p.birth?.date?.formatted_date) {
    let b = `b. ${p.birth.date.formatted_date}`;
    if (p.birth.location?.formatted_location) b += `, ${p.birth.location.formatted_location}`;
    details.push(b);
  }
  if (p.death?.date?.formatted_date) {
    let d = `d. ${p.death.date.formatted_date}`;
    if (p.death.location?.formatted_location) d += `, ${p.death.location.formatted_location}`;
    details.push(d);
  }
  if (p.is_alive) details.push('living');
  if (p.about_me) details.push(`About: ${p.about_me}`);
  if (p.current_residence?.formatted_location) details.push(`Lives: ${p.current_residence.formatted_location}`);

  if (details.length) parts.push('— ' + details.join('; '));

  return parts.join(' ');
}

function formatFamilyNode(node) {
  const name = node.name || `${node.first_name || ''} ${node.last_name || ''}`.trim();
  const alive = node.is_alive ? ' (living)' : '';
  return `${name}${alive} [${node.id}]`;
}

// --- Geni tool functions (called by bot.js) ---

export function isGeniConfigured() {
  return existsSync(CONFIG_PATH) && existsSync(TOKENS_PATH);
}

export async function geniGetProfile(profileId) {
  try {
    const profile = await geniGet(profileId);
    return { success: true, profile: formatProfile(profile), raw_id: profile.id };
  } catch (err) {
    return { error: `Failed to get profile: ${err.message}` };
  }
}

export async function geniGetImmediateFamily(profileId) {
  try {
    const data = await geniGet(`${profileId}/immediate-family`);
    const focus = data.focus;
    const nodes = data.nodes || {};

    // Categorize relationships
    const family = { partners: [], children: [], parents: [], siblings: [] };

    for (const [nodeId, node] of Object.entries(nodes)) {
      if (nodeId === focus.id) continue;
      // Determine relationship from edges
      const edges = node.edges || {};
      const focusEdges = nodes[focus.id]?.edges || {};

      // Check unions to determine relationship
      for (const [unionId, edge] of Object.entries(edges)) {
        if (edge.rel === 'partner' && focusEdges[unionId]?.rel === 'partner') {
          family.partners.push(formatFamilyNode(node));
        } else if (edge.rel === 'child' && focusEdges[unionId]?.rel === 'partner') {
          family.children.push(formatFamilyNode(node));
        } else if (edge.rel === 'partner' && focusEdges[unionId]?.rel === 'child') {
          family.parents.push(formatFamilyNode(node));
        } else if (edge.rel === 'child' && focusEdges[unionId]?.rel === 'child') {
          family.siblings.push(formatFamilyNode(node));
        }
      }
    }

    const focusName = focus.name || `${focus.first_name || ''} ${focus.last_name || ''}`.trim();
    let result = `Immediate family of **${focusName}** [${focus.id}]:\n`;
    if (family.parents.length) result += `\nParents: ${family.parents.join(', ')}`;
    if (family.partners.length) result += `\nPartners: ${family.partners.join(', ')}`;
    if (family.children.length) result += `\nChildren: ${family.children.join(', ')}`;
    if (family.siblings.length) result += `\nSiblings: ${family.siblings.join(', ')}`;

    return { success: true, family: result };
  } catch (err) {
    return { error: `Failed to get family: ${err.message}` };
  }
}

export async function geniGetAncestors(profileId) {
  try {
    const data = await geniGet(`${profileId}/ancestors`);
    const nodes = data.nodes || data.results || {};
    const ancestors = [];

    for (const [nodeId, node] of Object.entries(nodes)) {
      if (nodeId === profileId) continue;
      ancestors.push(formatFamilyNode(node));
    }

    return { success: true, ancestors: ancestors.join('\n'), count: ancestors.length };
  } catch (err) {
    return { error: `Failed to get ancestors: ${err.message}` };
  }
}

export async function geniSearch(name) {
  try {
    const data = await geniGet('profile/search', { names: name });
    const results = data.results || [];

    if (results.length === 0) {
      return { success: true, message: `No profiles found for "${name}".` };
    }

    const formatted = results.slice(0, 10).map(p => {
      const parts = [formatProfile(p), `  ID: ${p.id}`];
      return parts.join('\n');
    });

    return { success: true, results: formatted.join('\n\n'), count: results.length };
  } catch (err) {
    return { error: `Search failed: ${err.message}` };
  }
}

export async function geniPathTo(fromId, toId) {
  try {
    const data = await geniGet(`${fromId}/path-to/${toId}`);
    const path = data.path || [];
    const nodes = data.nodes || {};

    const steps = path.map(id => {
      const node = nodes[id];
      if (!node) return id;
      return formatFamilyNode(node);
    });

    return { success: true, path: steps.join(' → '), length: steps.length };
  } catch (err) {
    return { error: `Path lookup failed: ${err.message}` };
  }
}

export async function geniGetMyProfile() {
  try {
    const token = await getAccessToken();
    const resp = await fetch(`${API_BASE}/user/max-family?access_token=${token}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data.results || [];
    const formatted = results.slice(0, 20).map(p => `${formatProfile(p)} [${p.id}]`);
    return { success: true, profiles: formatted.join('\n'), count: results.length };
  } catch (err) {
    return { error: `Failed to get family: ${err.message}` };
  }
}
