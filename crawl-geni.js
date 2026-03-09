#!/usr/bin/env node
/**
 * Crawl Geni.com family tree starting from a known profile.
 * Walks outward via immediate-family, collecting all connected profiles.
 * Compares against family-tree.json and outputs updates + new people.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TREE_PATH = join(__dirname, 'family-tree.json');
const TOKENS_PATH = join(__dirname, 'geni-tokens.json');
const API_BASE = 'https://www.geni.com/api';

// Rate limiting
let lastRequestTime = 0;
const MIN_INTERVAL = 11000;

async function throttle() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL) {
    const wait = MIN_INTERVAL - elapsed;
    process.stdout.write(`  [wait ${Math.ceil(wait/1000)}s] `);
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
}

function getToken() {
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));
  if (Date.now() > tokens.expires_at - 60000) throw new Error('Token expired');
  return tokens.access_token;
}

async function geniGet(path) {
  await throttle();
  const token = getToken();
  const url = `${API_BASE}/${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RoRo-FamilyTreeBot/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429) {
    const window = resp.headers.get('X-API-Rate-Window');
    const wait = window ? parseInt(window) * 1000 : 60000;
    console.log(`429 — waiting ${Math.ceil(wait/1000)}s`);
    await new Promise(r => setTimeout(r, wait));
    lastRequestTime = Date.now();
    return geniGet(path);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// --- Crawl ---

const visited = new Set();       // internal IDs we've fetched family for
const profiles = new Map();      // internalId -> profile data
const relationships = [];        // {from, to, rel}

async function fetchFamily(internalId) {
  if (visited.has(internalId)) return;
  visited.add(internalId);

  process.stdout.write(`\nFamily of ${internalId}: `);
  try {
    const data = await geniGet(`${internalId}/immediate-family`);
    const focus = data.focus;
    const nodes = data.nodes || {};

    // Store focus profile
    if (focus) {
      profiles.set(focus.id, extractProfile(focus));
      process.stdout.write(`${focus.name || focus.first_name}`);
    }

    // Process family members
    for (const [nodeId, node] of Object.entries(nodes)) {
      if (nodeId === focus?.id) continue;
      if (nodeId.startsWith('union-')) continue;

      const p = extractProfile(node);
      profiles.set(nodeId, p);

      // Determine relationship
      const edges = node.edges || {};
      const focusEdges = nodes[focus?.id]?.edges || {};
      let rel = 'unknown';
      for (const [unionId, edge] of Object.entries(edges)) {
        const focusEdge = focusEdges[unionId];
        if (!focusEdge) continue;
        if (edge.rel === 'partner' && focusEdge.rel === 'partner') rel = 'partner';
        else if (edge.rel === 'child' && focusEdge.rel === 'partner') rel = 'child';
        else if (edge.rel === 'partner' && focusEdge.rel === 'child') rel = 'parent';
        else if (edge.rel === 'child' && focusEdge.rel === 'child') rel = 'sibling';
      }

      relationships.push({ from: focus?.id, to: nodeId, rel });
      process.stdout.write(` → ${rel}:${p.name}`);
    }
  } catch (err) {
    process.stdout.write(` ERROR: ${err.message}`);
  }
}

function extractProfile(node) {
  return {
    name: node.name || `${node.first_name || ''} ${node.last_name || ''}`.trim(),
    id: node.id,
    guid: node.guid,
    gender: node.gender,
    is_alive: node.is_alive,
    born: node.birth?.date?.formatted_date,
    born_year: node.birth?.date?.year,
    birthplace: node.birth?.location?.formatted_location,
    died: node.death?.date?.formatted_date,
    died_year: node.death?.date?.year,
    deathplace: node.death?.location?.formatted_location,
    occupation: node.occupation,
    residence: node.current_residence?.formatted_location || node.location?.formatted_location,
    about: node.about_me,
  };
}

// --- Main ---

// Load tree for comparison
const tree = JSON.parse(readFileSync(TREE_PATH, 'utf-8'));
const treeByName = new Map(tree.map(e => [e.name, e]));

// Also build a fuzzy lookup (last name match)
function findInTree(name) {
  if (treeByName.has(name)) return treeByName.get(name);
  // Try matching by first+last name ignoring middle
  const parts = name.split(' ');
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];
    for (const [treeName, entry] of treeByName) {
      const tp = treeName.split(' ');
      if (tp[0] === first && tp[tp.length - 1] === last) return entry;
      // Check nicknames
      if (entry.nicknames?.some(n => n === first) && tp[tp.length - 1] === last) return entry;
    }
  }
  return null;
}

// Starting points — known internal IDs from previous runs
const SEEDS = [
  'profile-3777752',   // John Frederick Sampson
  'profile-5368178',   // Juliet Margaret Sampson
  'profile-24257391',  // Rose Sampson (RoRo)
  'profile-24257403',  // John Sampson (Grandpa John)
  'profile-2160991',   // Janet Reider
  'profile-39268585',  // Deborah Green
  'profile-5368564',   // Dr. Arthur Fischel Sampson
];

// Max depth for BFS
const MAX_DEPTH = 3;
const queue = SEEDS.map(id => ({ id, depth: 0 }));
const enqueued = new Set(SEEDS);

console.log('=== Geni Family Tree Crawl ===');
console.log(`Seeds: ${SEEDS.length}, Max depth: ${MAX_DEPTH}`);
console.log(`Rate: ~1 request per 10s. This will take a while.\n`);

while (queue.length > 0) {
  const { id, depth } = queue.shift();
  if (visited.has(id)) continue;

  process.stdout.write(`[depth=${depth}, queue=${queue.length}]`);
  await fetchFamily(id);

  // Enqueue discovered profiles for next depth
  if (depth < MAX_DEPTH) {
    for (const [nodeId] of profiles) {
      if (!enqueued.has(nodeId) && !visited.has(nodeId) && nodeId.startsWith('profile-')) {
        queue.push({ id: nodeId, depth: depth + 1 });
        enqueued.add(nodeId);
      }
    }
  }

  // Save progress every 10 profiles
  if (visited.size % 10 === 0) {
    const partial = { profiles: Object.fromEntries(profiles), relationships, visited: visited.size, queue: queue.length };
    writeFileSync(join(__dirname, 'geni-crawl-results.json'), JSON.stringify(partial, null, 2));
    console.log(`\n  [saved progress: ${visited.size} visited, ${queue.length} queued]`);
  }
}

// --- Compare with tree ---

console.log('\n\n========== CRAWL RESULTS ==========\n');
console.log(`Profiles discovered: ${profiles.size}`);
console.log(`Relationships: ${relationships.length}`);
console.log(`API calls made: ${visited.size}\n`);

const updates = [];
const newPeople = [];

for (const [id, p] of profiles) {
  const treeEntry = findInTree(p.name);
  if (treeEntry) {
    // Check for missing data
    if (p.born && !treeEntry.born) updates.push({ name: treeEntry.name, field: 'born', value: p.born });
    if (p.birthplace && !treeEntry.birthplace) updates.push({ name: treeEntry.name, field: 'birthplace', value: p.birthplace });
    if (p.died && !treeEntry.died) updates.push({ name: treeEntry.name, field: 'died', value: p.died });
    if (p.deathplace && !treeEntry.deathplace) updates.push({ name: treeEntry.name, field: 'deathplace', value: p.deathplace });
    if (p.guid && !treeEntry.sources?.some(s => s.includes('geni.com'))) {
      updates.push({ name: treeEntry.name, field: 'geni_source', value: `https://www.geni.com/people/${encodeURIComponent(p.name.replace(/ /g, '-'))}/${p.guid}` });
    }
  } else {
    // Find relationships
    const rels = relationships.filter(r => r.to === id || r.from === id);
    const relDescs = rels.map(r => {
      const other = r.from === id ? profiles.get(r.to) : profiles.get(r.from);
      const relName = r.from === id ? `is ${r.rel} of` : `${r.rel}`;
      return `${relName} ${other?.name || '?'}`;
    });

    newPeople.push({
      ...p,
      relDescs,
    });
  }
}

if (updates.length) {
  console.log(`UPDATES to existing entries (${updates.length}):`);
  for (const u of updates) {
    console.log(`  ${u.name} → ${u.field}: ${u.value}`);
  }
}

if (newPeople.length) {
  console.log(`\nNEW people not in tree (${newPeople.length}):`);
  for (const p of newPeople) {
    const alive = p.is_alive ? ' (living)' : '';
    console.log(`  ${p.name}${alive} [${p.id}]`);
    if (p.born) console.log(`    Born: ${p.born}${p.birthplace ? ', ' + p.birthplace : ''}`);
    if (p.died) console.log(`    Died: ${p.died}${p.deathplace ? ', ' + p.deathplace : ''}`);
    if (p.occupation) console.log(`    Occupation: ${p.occupation}`);
    if (p.residence) console.log(`    Lives: ${p.residence}`);
    if (p.relDescs?.length) console.log(`    Relations: ${p.relDescs.join('; ')}`);
  }
}

// Save raw results for later use
const output = { profiles: Object.fromEntries(profiles), relationships, updates, newPeople };
writeFileSync(join(__dirname, 'geni-crawl-results.json'), JSON.stringify(output, null, 2));
console.log('\nRaw results saved to geni-crawl-results.json');
