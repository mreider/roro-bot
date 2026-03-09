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

async function geniRequest(url, options = {}) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
    });

    // Log rate limit headers when present
    const remaining = resp.headers.get('X-API-Rate-Remaining');
    const window = resp.headers.get('X-API-Rate-Window');
    if (remaining !== null) {
      console.log(`[geni] Rate limit: ${remaining} remaining in ${window}s window`);
    }

    if (resp.status === 429 && attempt < MAX_RETRIES) {
      const waitSec = window ? Math.ceil(parseInt(window) / 2) : 30;
      console.log(`[geni] Rate limited (429), waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Geni API ${resp.status}: ${text}`);
    }
    return resp.json();
  }
}

async function geniGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}/${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  return geniRequest(url.toString(), {
    headers: { 'User-Agent': 'RoRo-FamilyTreeBot/1.0' },
  });
}

async function geniPost(path, data = {}) {
  const token = await getAccessToken();
  const url = `${API_BASE}/${path}?access_token=${token}`;

  return geniRequest(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'RoRo-FamilyTreeBot/1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(flattenParams(data)).toString(),
  });
}

// Flatten nested objects for form encoding (e.g., birth.date.year → birth[date][year])
function flattenParams(obj, prefix = '') {
  const params = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(params, flattenParams(val, fullKey));
    } else if (Array.isArray(val)) {
      params[fullKey] = val.join(',');
    } else if (val !== undefined && val !== null) {
      params[fullKey] = String(val);
    }
  }
  return params;
}

// --- Profile ID normalization ---

// Geni has two ID formats:
//   Internal: profile-5368178 (works for API calls)
//   GUID: 325120088920006414 (used in URLs, does NOT work for API calls)
// GUIDs are 15+ digits; internal IDs are shorter.
// When we get a GUID, we search by name to resolve it.

const guidCache = new Map(); // guid -> internal profile id

async function resolveProfileId(id) {
  if (!id) return id;

  // Strip URL parts if a full Geni URL was passed
  // Also extract the name from the URL path if present (e.g. /people/John-Sampson/12345)
  let nameFromUrl = null;
  const urlNameMatch = id.match(/\/people\/([^/]+)\/(\d+)/);
  if (urlNameMatch) {
    nameFromUrl = urlNameMatch[1].replace(/-/g, ' ');
    id = urlNameMatch[2];
  } else {
    const urlMatch = id.match(/(\d{5,})(?:\?|$)/);
    if (urlMatch) id = urlMatch[1];
  }

  // Already in profile-NNN format
  if (id.startsWith('profile-')) {
    const num = id.replace('profile-', '');
    if (num.length < 15) return id; // internal ID, good to go
    id = num; // it's a GUID, resolve below
  }

  // Short numeric ID = internal ID
  if (/^\d+$/.test(id) && id.length < 15) return `profile-${id}`;

  // It's a GUID — check cache
  if (guidCache.has(id)) return guidCache.get(id);

  // Resolve GUID by searching with the name extracted from URL
  if (nameFromUrl) {
    try {
      const searchData = await geniGet(`profile/search`, { names: nameFromUrl });
      const match = searchData.results?.find(r => r.guid === id);
      if (match) {
        console.log(`[geni] Resolved GUID ${id} → ${match.id} (${match.name})`);
        guidCache.set(id, match.id);
        return match.id;
      }
    } catch (err) {
      console.log(`[geni] GUID search failed: ${err.message}`);
    }
  }

  // Fallback — return with profile- prefix (may not work for GUIDs)
  console.log(`[geni] Warning: using GUID ${id} directly — use geni_search to get the internal ID first`);
  return `profile-${id}`;
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
    profileId = await resolveProfileId(profileId);
    const profile = await geniGet(profileId);
    return { success: true, profile: formatProfile(profile), raw_id: profile.id };
  } catch (err) {
    return { error: `Failed to get profile: ${err.message}` };
  }
}

export async function geniGetImmediateFamily(profileId) {
  try {
    profileId = await resolveProfileId(profileId);
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
    profileId = await resolveProfileId(profileId);
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
    fromId = await resolveProfileId(fromId);
    toId = await resolveProfileId(toId);
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

// --- Write operations ---

function buildEventParam(dateStr, location) {
  const event = {};
  if (dateStr) {
    const date = {};
    const parts = dateStr.split('-');
    if (parts[0]) date.year = parseInt(parts[0]);
    if (parts[1]) date.month = parseInt(parts[1]);
    if (parts[2]) date.day = parseInt(parts[2]);
    event.date = date;
  }
  if (location) {
    event.location = { city: location };
  }
  return event;
}

export async function geniUpdateProfile(profileId, updates) {
  try {
    profileId = await resolveProfileId(profileId);
    const params = {};
    if (updates.first_name) params.first_name = updates.first_name;
    if (updates.last_name) params.last_name = updates.last_name;
    if (updates.middle_name) params.middle_name = updates.middle_name;
    if (updates.maiden_name) params.maiden_name = updates.maiden_name;
    if (updates.suffix) params.suffix = updates.suffix;
    if (updates.gender) params.gender = updates.gender;
    if (updates.about_me) params.about_me = updates.about_me;
    if (updates.occupation) params.occupation = updates.occupation;
    if (updates.is_alive !== undefined) params.is_alive = updates.is_alive;
    if (updates.nicknames) params.nicknames = updates.nicknames;
    if (updates.birth_date || updates.birth_location) {
      params.birth = buildEventParam(updates.birth_date, updates.birth_location);
    }
    if (updates.death_date || updates.death_location) {
      params.death = buildEventParam(updates.death_date, updates.death_location);
    }

    const result = await geniPost(`${profileId}/update`, params);
    const name = result.name || `${result.first_name || ''} ${result.last_name || ''}`.trim();
    return { success: true, message: `Updated ${name} [${result.id}]`, updated: Object.keys(updates) };
  } catch (err) {
    return { error: `Failed to update profile: ${err.message}` };
  }
}

export async function geniAddChild(parentProfileId, childData) {
  try {
    parentProfileId = await resolveProfileId(parentProfileId);
    const params = {};
    if (childData.first_name) params.first_name = childData.first_name;
    if (childData.last_name) params.last_name = childData.last_name;
    if (childData.gender) params.gender = childData.gender;
    if (childData.birth_date || childData.birth_location) {
      params.birth = buildEventParam(childData.birth_date, childData.birth_location);
    }
    if (childData.is_alive !== undefined) params.is_alive = childData.is_alive;

    const result = await geniPost(`${parentProfileId}/add-child`, params);
    const name = result.name || `${result.first_name || ''} ${result.last_name || ''}`.trim();
    return { success: true, message: `Added child ${name} [${result.id}] to [${parentProfileId}]`, profile_id: result.id };
  } catch (err) {
    return { error: `Failed to add child: ${err.message}` };
  }
}

export async function geniAddParent(childProfileId, parentData) {
  try {
    childProfileId = await resolveProfileId(childProfileId);
    const params = {};
    if (parentData.first_name) params.first_name = parentData.first_name;
    if (parentData.last_name) params.last_name = parentData.last_name;
    if (parentData.gender) params.gender = parentData.gender;
    if (parentData.birth_date || parentData.birth_location) {
      params.birth = buildEventParam(parentData.birth_date, parentData.birth_location);
    }
    if (parentData.death_date || parentData.death_location) {
      params.death = buildEventParam(parentData.death_date, parentData.death_location);
    }

    const result = await geniPost(`${childProfileId}/add-parent`, params);
    const name = result.name || `${result.first_name || ''} ${result.last_name || ''}`.trim();
    return { success: true, message: `Added parent ${name} [${result.id}] to [${childProfileId}]`, profile_id: result.id };
  } catch (err) {
    return { error: `Failed to add parent: ${err.message}` };
  }
}

export async function geniAddPartner(profileId, partnerData) {
  try {
    profileId = await resolveProfileId(profileId);
    const params = {};
    if (partnerData.first_name) params.first_name = partnerData.first_name;
    if (partnerData.last_name) params.last_name = partnerData.last_name;
    if (partnerData.gender) params.gender = partnerData.gender;
    if (partnerData.birth_date || partnerData.birth_location) {
      params.birth = buildEventParam(partnerData.birth_date, partnerData.birth_location);
    }
    if (partnerData.marriage_date || partnerData.marriage_location) {
      params.marriage = buildEventParam(partnerData.marriage_date, partnerData.marriage_location);
    }

    const result = await geniPost(`${profileId}/add-partner`, params);
    const name = result.name || `${result.first_name || ''} ${result.last_name || ''}`.trim();
    return { success: true, message: `Added partner ${name} [${result.id}] to [${profileId}]`, profile_id: result.id };
  } catch (err) {
    return { error: `Failed to add partner: ${err.message}` };
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
