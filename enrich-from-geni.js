#!/usr/bin/env node
/**
 * Enrich family-tree.json from Geni.com API
 * Uses search endpoint to find profiles, then fetches details.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TREE_PATH = join(__dirname, 'family-tree.json');
const TOKENS_PATH = join(__dirname, 'geni-tokens.json');
const API_BASE = 'https://www.geni.com/api';

// Rate limiting — Geni gives ~1 request per 10s window
let lastRequestTime = 0;
const MIN_INTERVAL = 11000;

async function throttle() {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL) {
    const wait = MIN_INTERVAL - elapsed;
    process.stdout.write(`  [wait ${Math.ceil(wait/1000)}s]\n`);
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
  const fullPath = path.startsWith('http') ? path : `${API_BASE}/${path}`;
  const url = `${fullPath}${fullPath.includes('?') ? '&' : '?'}access_token=${token}`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'RoRo-FamilyTreeBot/1.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (resp.status === 429) {
    console.log('  Rate limited, waiting 30s...');
    await new Promise(r => setTimeout(r, 30000));
    lastRequestTime = Date.now();
    return geniGet(path);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Geni ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function searchProfile(name) {
  const data = await geniGet(`profile/search?names=${encodeURIComponent(name)}`);
  return data.results || [];
}

async function getFamily(internalId) {
  const data = await geniGet(`${internalId}/immediate-family`);
  return data;
}

// Load tree
const tree = JSON.parse(readFileSync(TREE_PATH, 'utf-8'));
const treeByName = new Map(tree.map(e => [e.name, e]));

// People to search — focus on sparse entries
const sparseEntries = tree.filter(e => !e.born && !e.died && e.name !== 'self');
// Also search people who have dates but no Geni source link
const noGeniSource = tree.filter(e =>
  (e.born || e.died) &&
  !e.sources?.some(s => s.includes('geni.com')) &&
  !['Diogo Rodrigues', 'Clara Roiz', 'Solomon Levy', 'Salomon (Samuel) Levy', 'Antonio Ha Levy, Abulafia'].includes(e.name)
);

// Priority list: Sampson descendants first (user asked about Isaac Mays Smith)
const prioritySearches = [
  'Juliet Sampson',
  'Isaac Mays Smith',
  'John Frederick Sampson Jr',
  'Jennifer Sampson',
  'John Frederick Sampson',
  'Deborah Sampson Green',
  'Janet Sampson Reider',
  'Arthur Sampson', // Dr AF Sampson
  'Babette Sampson',
  'Joseph Sampson Georgetown', // Joseph H
  'Esther Sampson Langfeld',
  'Cornelia Sampson',
  'Frederick Kahn Oakland',
  'Helen Kahn Lavenson',
  'Caleb Green Seattle',
];

console.log('=== Geni Enrichment ===\n');

const updates = [];
const newPeople = [];
const geniIdMap = new Map(); // name -> {internalId, guid}

// Phase 1: Search for priority profiles
for (const searchName of prioritySearches) {
  console.log(`\nSearching: "${searchName}"`);
  try {
    const results = await searchProfile(searchName);
    if (!results.length) {
      console.log('  No results');
      continue;
    }

    // Take the first result that's in the family (has relationship field or is in our tree)
    const match = results.find(r => r.relationship || treeByName.has(r.name)) || results[0];
    const name = match.name;
    const internalId = match.id;
    const guid = match.guid;

    console.log(`  Found: ${name} [${internalId}] (${match.relationship || 'no relation listed'})`);

    geniIdMap.set(name, { internalId, guid });

    // Extract data
    const born = match.birth?.date?.formatted_date;
    const birthplace = match.birth?.location?.formatted_location;
    const died = match.death?.date?.formatted_date;
    const deathplace = match.death?.location?.formatted_location;
    const residence = match.current_residence?.formatted_location || match.location?.formatted_location;
    const occupation = match.occupation;

    if (born) console.log(`  Born: ${born}${birthplace ? ', ' + birthplace : ''}`);
    if (died) console.log(`  Died: ${died}${deathplace ? ', ' + deathplace : ''}`);
    if (match.is_alive) console.log(`  Living`);
    if (residence) console.log(`  Lives: ${residence}`);
    if (occupation) console.log(`  Occupation: ${occupation}`);

    const treeEntry = treeByName.get(name);
    if (treeEntry) {
      if (born && !treeEntry.born) updates.push({ name, field: 'born', value: born });
      if (birthplace && !treeEntry.birthplace) updates.push({ name, field: 'birthplace', value: birthplace });
      if (died && !treeEntry.died) updates.push({ name, field: 'died', value: died });
      if (deathplace && !treeEntry.deathplace) updates.push({ name, field: 'deathplace', value: deathplace });

      const geniUrl = `https://www.geni.com/people/${encodeURIComponent(name.replace(/ /g, '-'))}/${guid}`;
      if (!treeEntry.sources?.some(s => s.includes(guid))) {
        updates.push({ name, field: 'geni_source', value: geniUrl });
      }
    } else {
      console.log(`  ** NOT IN TREE **`);
      newPeople.push({
        name,
        born, birthplace, died, deathplace,
        is_alive: match.is_alive,
        residence, occupation,
        geniId: guid, internalId,
      });
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

// Phase 2: For key new people (like Isaac Mays Smith), get their family connections
const familyFetches = ['Isaac Mays Smith', 'Juliet Margaret Sampson', 'John Frederick Sampson'];
for (const name of familyFetches) {
  const ids = geniIdMap.get(name);
  if (!ids) continue;

  console.log(`\nFetching family of ${name} (${ids.internalId})...`);
  try {
    const fam = await getFamily(ids.internalId);
    const focus = fam.focus;
    const nodes = fam.nodes || {};

    for (const [nodeId, node] of Object.entries(nodes)) {
      if (nodeId === focus?.id) continue;
      const nName = node.name || `${node.first_name || ''} ${node.last_name || ''}`.trim();
      const inTree = treeByName.has(nName);

      let rel = '?';
      const edges = node.edges || {};
      const focusEdges = nodes[focus?.id]?.edges || {};
      for (const [unionId, edge] of Object.entries(edges)) {
        if (edge.rel === 'partner' && focusEdges[unionId]?.rel === 'partner') rel = 'partner';
        else if (edge.rel === 'child' && focusEdges[unionId]?.rel === 'partner') rel = 'child';
        else if (edge.rel === 'partner' && focusEdges[unionId]?.rel === 'child') rel = 'parent';
        else if (edge.rel === 'child' && focusEdges[unionId]?.rel === 'child') rel = 'sibling';
      }

      const alive = node.is_alive ? ' (living)' : '';
      console.log(`  ${rel}: ${nName}${alive} [${nodeId}] ${inTree ? '' : '** NEW **'}`);

      if (!inTree && !newPeople.find(p => p.name === nName)) {
        newPeople.push({
          name: nName,
          geniId: node.guid,
          internalId: nodeId,
          is_alive: node.is_alive,
          born: node.birth?.date?.formatted_date,
          birthplace: node.birth?.location?.formatted_location,
          rel, relTo: name,
        });
      }
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

// Summary
console.log('\n\n========== RESULTS ==========\n');

if (updates.length) {
  console.log(`UPDATES to existing entries (${updates.length}):`);
  for (const u of updates) {
    console.log(`  ${u.name} → ${u.field}: ${u.value}`);
  }
}

if (newPeople.length) {
  console.log(`\nNEW people to add (${newPeople.length}):`);
  for (const p of newPeople) {
    const alive = p.is_alive ? ' (living)' : '';
    const rel = p.rel ? ` [${p.rel} of ${p.relTo}]` : '';
    console.log(`  ${p.name}${alive}${rel}`);
    if (p.born) console.log(`    Born: ${p.born}${p.birthplace ? ', ' + p.birthplace : ''}`);
    if (p.died) console.log(`    Died: ${p.died}${p.deathplace ? ', ' + p.deathplace : ''}`);
    if (p.residence) console.log(`    Lives: ${p.residence}`);
    if (p.occupation) console.log(`    Occupation: ${p.occupation}`);
  }
}

console.log('\nDone.');
