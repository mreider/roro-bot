import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, 'docs');
const INDEX_PATH = join(DOCS_DIR, 'index.html');
const NARRATIVE_CACHE_PATH = join(__dirname, '.narrative-cache.json');

function loadFile(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

// Hash the narrative source files to detect changes
function hashSources(familyMd, familyJson, soul) {
  return createHash('sha256').update(familyMd + familyJson + soul).digest('hex');
}

// Load cached narrative if sources haven't changed
function loadCachedNarrative(currentHash) {
  try {
    const cache = JSON.parse(readFileSync(NARRATIVE_CACHE_PATH, 'utf-8'));
    if (cache.hash === currentHash && cache.html) {
      console.log('[page] Narrative cache hit - sources unchanged, skipping Claude call');
      return cache.html;
    }
  } catch {}
  return null;
}

function saveCachedNarrative(hash, html) {
  writeFileSync(NARRATIVE_CACHE_PATH, JSON.stringify({ hash, html }), 'utf-8');
}

export async function generatePage(requestContext) {
  const familyMd = loadFile(join(__dirname, 'FAMILY.md'));
  const familyJson = loadFile(join(__dirname, 'family-tree.json'));
  const soul = loadFile(join(__dirname, 'SOUL.md'));

  const sourceHash = hashSources(familyMd, familyJson, soul);
  let narrativeHtml = loadCachedNarrative(sourceHash);

  if (!narrativeHtml) {
    const anthropic = new Anthropic();

    const prompt = `You are generating the NARRATIVE section of a family history page for the Sampson-Kahn family, in the voice of Grandma RoRo (Rose Etta Kahn Sampson, 1907-1997).

Here is RoRo's personality and voice:
${soul}

Here is the family tree in narrative form:
${familyMd}

Here is the structured family data:
${familyJson}

${requestContext ? `The family member who requested this page said: "${requestContext}". Take their request into account for the tone, focus, or style.` : ''}

Generate ONLY the narrative HTML content (no <!DOCTYPE>, no <html>, no <head>, no <body> - just the inner content divs). Requirements:

1. **Voice**: Written as if RoRo is telling you about her family. First person where natural. Warm, composed, proud but not boastful. Short, graceful sentences.

2. **Structure**: Use <div class="section"> wrappers with <h2> headings:
   - A brief introduction from RoRo
   - Sections by family branch (Kahn origins, the Lavensons, the Sampsons, RoRo & Grandpa John, their children, grandchildren, great-grandchildren)
   - The Sephardic ancestry as a fascinating open question
   - Key places (Oakland, Georgetown SC, Galveston, San Francisco, Curaçao)

3. **Content**: Use real dates, places, and stories. Don't invent facts. Include the rich details.

4. **Technical**: Just HTML content divs. No page structure, no CSS, no JavaScript. Use <p>, <h2>, <h3>, <ul>, <li> etc.

5. **IMPORTANT**: Never use em dashes. Use commas, periods, semicolons, or rewrite the sentence instead. Hyphens in hyphenated words are fine.

Output ONLY the HTML content. No markdown fences, no explanation.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 12000,
      messages: [{ role: 'user', content: prompt }],
    });

    narrativeHtml = response.content[0]?.text || '';
    narrativeHtml = narrativeHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();
    // Strip any em dashes that slipped through
    narrativeHtml = narrativeHtml.replace(/\u2014/g, ' - ').replace(/\u2013/g, '-');

    saveCachedNarrative(sourceHash, narrativeHtml);
    console.log('[page] Narrative generated and cached');
  }

  const treeData = familyJson;

  // Version tag so the bot can detect when GitHub Pages has deployed
  const version = new Date().toISOString();

  // Assemble the full page
  const html = buildFullPage(narrativeHtml, treeData, version);

  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, html, 'utf-8');
  // Ensure CNAME stays for custom domain
  const cnamePath = join(DOCS_DIR, 'CNAME');
  if (!existsSync(cnamePath)) {
    writeFileSync(cnamePath, 'family.mreider.com\n', 'utf-8');
  }
  console.log(`[page] Generated ${html.length} bytes → ${INDEX_PATH} (version: ${version})`);

  return { html, version };
}

function buildFullPage(narrativeHtml, treeDataJson, version) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="page-version" content="${version || ''}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Sampson-Kahn Family</title>
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png">
<link rel="manifest" href="site.webmanifest">
<link rel="shortcut icon" href="favicon.ico">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&family=Playfair+Display:wght@400;600&display=swap" rel="stylesheet">
<style>
:root {
  --primary: #5bc1ac;
  --secondary: #5a6f80;
  --bg: #f0f8ff;
  --white: #fff;
  --dark: #1a1a1a;
  --muted: #717275;
  --border: #e0e7ed;
  --radius: 10px;
  --sans: 'Inter', -apple-system, sans-serif;
  --serif: 'Playfair Display', Georgia, serif;
}
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--sans); background: var(--bg); color: var(--dark); line-height: 1.7; font-weight: 300; }
a { color: var(--secondary); text-decoration: none; transition: color 0.2s; }
a:hover { color: var(--primary); }

/* Header */
header { background: var(--secondary); color: var(--white); padding: 3rem 1.5rem; text-align: center; }
header h1 { font-family: var(--serif); font-size: 2rem; font-weight: 400; letter-spacing: 0.02em; margin-bottom: 0.3rem; }
header p { font-size: 0.95rem; opacity: 0.8; font-weight: 300; }

/* Tabs */
.tabs { display: flex; justify-content: center; gap: 0; background: var(--white); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
.tab { padding: 0.85rem 2rem; cursor: pointer; font-family: var(--sans); font-size: 0.9rem; font-weight: 400; color: var(--muted); border: none; background: none; border-bottom: 2px solid transparent; transition: all 0.2s; letter-spacing: 0.03em; }
.tab:hover { color: var(--dark); }
.tab.active { color: var(--dark); border-bottom-color: var(--primary); font-weight: 600; }
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Narrative */
#narrative-view { max-width: 720px; margin: 0 auto; padding: 2.5rem 1.5rem; }
.roro-portrait { display: block; width: 160px; height: 160px; border-radius: 50%; object-fit: cover; margin: 0 auto 1.5rem; border: 3px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
#narrative-view .section { margin-bottom: 2.5rem; }
#narrative-view h2 { font-family: var(--serif); font-size: 1.4rem; color: var(--secondary); margin-bottom: 0.8rem; }
#narrative-view h3 { font-size: 1.05rem; color: var(--dark); font-weight: 600; margin: 1.2rem 0 0.4rem; }
#narrative-view p { color: var(--muted); margin-bottom: 0.8rem; }
#narrative-view ul { margin: 0.5rem 0 1rem 1.5rem; color: var(--muted); }
#narrative-view li { margin-bottom: 0.3rem; }

/* Explorer */
.explorer { max-width: 680px; margin: 0 auto; padding: 1.5rem; }

/* Search */
.search-wrap { position: relative; margin-bottom: 1.5rem; }
.search-box { width: 100%; padding: 0.7rem 1rem; font-family: var(--sans); font-size: 0.95rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--white); color: var(--dark); outline: none; font-weight: 300; }
.search-box:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,193,172,0.15); }
.search-results { position: absolute; top: 100%; left: 0; right: 0; background: var(--white); border: 1px solid var(--border); border-top: none; border-radius: 0 0 var(--radius) var(--radius); max-height: 280px; overflow-y: auto; z-index: 200; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
.search-item { padding: 0.55rem 1rem; cursor: pointer; border-bottom: 1px solid var(--bg); }
.search-item:hover { background: var(--bg); }
.search-item:last-child { border-bottom: none; }
.si-name { font-weight: 600; font-size: 0.9rem; }
.si-detail { font-size: 0.8rem; color: var(--muted); }

/* Mini family diagram */
.family-diagram { text-align: center; margin-bottom: 1.5rem; }
.fd-row { display: flex; justify-content: center; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.fd-line { width: 1px; height: 1.2rem; background: var(--border); margin: 0 auto; }
.fd-node { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; padding: 0.4rem 0.8rem; background: var(--white); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; font-size: 0.8rem; line-height: 1.3; transition: all 0.15s; width: 140px; min-height: 52px; text-align: center; }
.fd-node:hover { border-color: var(--primary); background: var(--bg); }
.fd-node.active { border-color: var(--primary); background: var(--primary); color: var(--white); }
.fd-node.active .fd-dates { color: rgba(255,255,255,0.8); }
.fd-name { font-weight: 600; font-size: 0.78rem; }
.fd-dates { font-size: 0.7rem; color: var(--muted); }
.fd-couple { display: inline-flex; align-items: center; gap: 0; }
.fd-couple .fd-node { border-radius: 6px 0 0 6px; }
.fd-couple .fd-node:last-child { border-radius: 0 6px 6px 0; border-left: none; }
.fd-children-row { display: flex; justify-content: center; gap: 0.4rem; flex-wrap: wrap; }
.fd-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin: 0.3rem 0; }

/* Person card */
.person-card { background: var(--white); border-radius: var(--radius); padding: 1.8rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.person-card h2 { font-family: var(--serif); font-size: 1.5rem; color: var(--dark); margin-bottom: 0.15rem; font-weight: 400; }
.person-nicknames { font-style: italic; color: var(--muted); margin-bottom: 0.6rem; font-size: 0.9rem; }
.person-relation { display: inline-block; font-size: 0.75rem; background: var(--bg); color: var(--secondary); padding: 0.2rem 0.6rem; border-radius: 100px; margin-bottom: 0.8rem; font-weight: 400; }
.person-meta { margin-bottom: 0.8rem; }
.meta-row { display: flex; gap: 0.4rem; margin-bottom: 0.2rem; font-size: 0.9rem; }
.meta-label { color: var(--muted); min-width: 4rem; flex-shrink: 0; font-weight: 400; }
.meta-value { color: var(--dark); font-weight: 300; }
.spouse-link { color: var(--primary); cursor: pointer; font-weight: 400; }
.spouse-link:hover { text-decoration: underline; }
.person-notes { border-top: 1px solid var(--border); padding-top: 0.8rem; margin-top: 0.5rem; color: var(--muted); font-size: 0.9rem; line-height: 1.7; }

/* Siblings */
.siblings-section { margin-bottom: 1.5rem; }
.siblings-section h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.4rem; }
.siblings-section .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.sib-pill { padding: 0.3rem 0.7rem; background: var(--white); border: 1px solid var(--border); border-radius: 100px; cursor: pointer; font-size: 0.8rem; color: var(--secondary); font-weight: 400; transition: all 0.15s; font-family: var(--sans); }
.sib-pill:hover { border-color: var(--primary); color: var(--primary); }

footer { text-align: center; padding: 2rem; color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--border); background: var(--white); }
footer a { color: var(--muted); }
footer a:hover { color: var(--primary); }

@media (max-width: 600px) {
  header h1 { font-size: 1.5rem; }
  header { padding: 2rem 1rem; }
  .tab { padding: 0.7rem 1.2rem; font-size: 0.85rem; }
  .explorer { padding: 1rem; }
  .person-card { padding: 1.2rem; }
  .person-card h2 { font-size: 1.3rem; }
  .meta-row { flex-direction: column; gap: 0; }
  .meta-label { min-width: auto; }
  #narrative-view { padding: 1.5rem 1rem; }
  .fd-node { width: 110px; min-height: 46px; padding: 0.3rem 0.5rem; }
  .fd-name { font-size: 0.72rem; }
}
</style>
</head>
<body>

<header>
  <h1>The Sampson-Kahn Family</h1>
  <p>Kept by RoRo - Rose Etta Kahn Sampson, 1907-1997</p>
</header>

<div class="tabs">
  <button class="tab active" onclick="switchTab('narrative', this)">Our Story</button>
  <button class="tab" onclick="switchTab('tree', this)">Family Tree</button>
</div>

<div id="narrative-tab" class="tab-content active">
  <div id="narrative-view">
    <img src="roro.png" alt="Rose Etta Kahn Sampson" class="roro-portrait">
    ${narrativeHtml}
  </div>
</div>

<div id="tree-tab" class="tab-content">
  <div class="explorer">
    <div class="search-wrap">
      <input type="text" id="search-input" class="search-box" placeholder="Search for a family member...">
      <div id="search-results" class="search-results"></div>
    </div>
    <div id="person-view"></div>
  </div>
</div>

<footer>
  Composed by RoRo &middot;
  <a href="https://family.mreider.com">family.mreider.com</a>
  &middot;
  <a href="sampson-kahn.ged" download>Download GEDCOM</a>
</footer>

<script>
var rawData = ${treeDataJson};
var byName = {};
rawData.forEach(function(p) { byName[p.name] = p; });

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getYears(p) {
  var parts = [];
  if (p.born) { var b = String(p.born); parts.push(b.length > 4 ? b.split('-')[0] : b); }
  if (p.died) { var d = String(p.died); parts.push(d.length > 4 ? d.split('-')[0] : d); }
  else if (parts.length) parts.push('');
  return parts.length < 2 ? (parts[0] || '') : parts[0] + '\\u2013' + parts[1];
}

function getChildren(name) {
  return rawData.filter(function(p) { return p.parents && p.parents.indexOf(name) !== -1; })
    .sort(function(a, b) { return (a.born ? parseInt(a.born) : 9999) - (b.born ? parseInt(b.born) : 9999); });
}

function getSiblings(name) {
  var person = byName[name];
  if (!person || !person.parents) return [];
  return rawData.filter(function(p) {
    if (p.name === name || !p.parents) return false;
    for (var i = 0; i < p.parents.length; i++) { if (person.parents.indexOf(p.parents[i]) !== -1) return true; }
    return false;
  }).sort(function(a, b) { return (a.born ? parseInt(a.born) : 9999) - (b.born ? parseInt(b.born) : 9999); });
}

function fdNode(person, isActive) {
  var y = getYears(person);
  var cls = 'fd-node' + (isActive ? ' active' : '');
  return '<div class="' + cls + '" data-name="' + esc(person.name) + '">' +
    '<span class="fd-name">' + esc(person.name) + '</span>' +
    (y ? '<span class="fd-dates">' + y + '</span>' : '') + '</div>';
}

var currentPerson = null;

function showPerson(name) {
  var person = byName[name];
  if (!person) return;
  currentPerson = name;

  var newHash = '#' + encodeURIComponent(name);
  if (!_skipHash && location.hash !== newHash) history.pushState(null, '', newHash);

  var treeTab = document.getElementById('tree-tab');
  if (!treeTab.classList.contains('active')) {
    var btns = document.querySelectorAll('.tab');
    switchTab('tree', btns[1]);
  }

  var parents = (person.parents || []).map(function(n) { return byName[n]; }).filter(Boolean);
  var children = getChildren(name);
  var siblings = getSiblings(name);
  var spousePerson = person.spouse ? byName[person.spouse] : null;

  // --- Mini family diagram ---
  var diagram = '<div class="family-diagram">';

  // Parents row
  if (parents.length > 0) {
    diagram += '<div class="fd-label">Parents</div>';
    if (parents.length === 2 && parents[0].spouse === parents[1].name) {
      diagram += '<div class="fd-row"><div class="fd-couple">' + fdNode(parents[0], false) + fdNode(parents[1], false) + '</div></div>';
    } else {
      diagram += '<div class="fd-row">' + parents.map(function(p) { return fdNode(p, false); }).join('') + '</div>';
    }
    diagram += '<div class="fd-line"></div>';
  }

  // Current person + spouse
  if (spousePerson) {
    diagram += '<div class="fd-row"><div class="fd-couple">' + fdNode(person, true) + fdNode(spousePerson, false) + '</div></div>';
  } else {
    diagram += '<div class="fd-row">' + fdNode(person, true) + '</div>';
  }

  // Children
  if (children.length > 0) {
    diagram += '<div class="fd-line"></div>';
    diagram += '<div class="fd-label">Children</div>';
    diagram += '<div class="fd-children-row">' + children.map(function(c) { return fdNode(c, false); }).join('') + '</div>';
  }

  diagram += '</div>';

  // --- Person card ---
  var card = '<div class="person-card">';
  card += '<h2>' + esc(person.name) + '</h2>';

  if (person.nicknames && person.nicknames.length) {
    card += '<div class="person-nicknames">' + person.nicknames.map(function(n) { return esc(n); }).join(', ') + '</div>';
  }

  if (person.relation && person.relation !== 'self') {
    card += '<div class="person-relation">' + esc(person.relation) + '</div>';
  }

  card += '<div class="person-meta">';
  if (person.born || person.birthplace) {
    var bt = ''; if (person.born) bt += String(person.born); if (person.birthplace) bt += (bt ? ', ' : '') + person.birthplace;
    card += '<div class="meta-row"><span class="meta-label">Born</span><span class="meta-value">' + esc(bt) + '</span></div>';
  }
  if (person.died || person.deathplace) {
    var dt = ''; if (person.died) dt += String(person.died); if (person.deathplace) dt += (dt ? ', ' : '') + person.deathplace;
    card += '<div class="meta-row"><span class="meta-label">Died</span><span class="meta-value">' + esc(dt) + '</span></div>';
  }
  if (person.spouse) {
    if (spousePerson) {
      card += '<div class="meta-row"><span class="meta-label">Spouse</span><span class="meta-value"><a class="spouse-link" data-name="' + esc(person.spouse) + '">' + esc(person.spouse) + '</a></span></div>';
    } else {
      card += '<div class="meta-row"><span class="meta-label">Spouse</span><span class="meta-value">' + esc(person.spouse) + '</span></div>';
    }
  }
  if (person.married) {
    card += '<div class="meta-row"><span class="meta-label">Married</span><span class="meta-value">' + esc(String(person.married)) + '</span></div>';
  }
  card += '</div>';

  if (person.notes) {
    card += '<div class="person-notes">' + esc(person.notes) + '</div>';
  }
  card += '</div>';

  // Siblings
  var sibHtml = '';
  if (siblings.length > 0) {
    sibHtml = '<div class="siblings-section"><h3>Siblings</h3><div class="pills">' +
      siblings.map(function(s) { return '<button class="sib-pill" data-name="' + esc(s.name) + '">' + esc(s.name) + '</button>'; }).join('') +
      '</div></div>';
  }

  var view = document.getElementById('person-view');
  view.innerHTML = diagram + card + sibHtml;
  view.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Event delegation
document.getElementById('person-view').addEventListener('click', function(e) {
  var node = e.target.closest('.fd-node'); if (node && !node.classList.contains('active')) { showPerson(node.dataset.name); return; }
  var pill = e.target.closest('.sib-pill'); if (pill) { showPerson(pill.dataset.name); return; }
  var link = e.target.closest('.spouse-link'); if (link) { showPerson(link.dataset.name); return; }
});

// Search
var searchInput = document.getElementById('search-input');
var searchResults = document.getElementById('search-results');

searchInput.addEventListener('input', function() {
  var q = searchInput.value.trim().toLowerCase();
  if (!q) { searchResults.style.display = 'none'; return; }
  var matches = rawData.filter(function(p) {
    if (p.name.toLowerCase().indexOf(q) !== -1) return true;
    if (p.nicknames) { for (var i = 0; i < p.nicknames.length; i++) { if (p.nicknames[i].toLowerCase().indexOf(q) !== -1) return true; } }
    return false;
  }).slice(0, 8);
  if (!matches.length) { searchResults.style.display = 'none'; return; }
  searchResults.innerHTML = matches.map(function(p) {
    var y = getYears(p);
    return '<div class="search-item" data-name="' + esc(p.name) + '"><span class="si-name">' + esc(p.name) + '</span>' +
      (y ? '<span class="si-detail"> ' + y + '</span>' : '') +
      (p.relation ? '<br><span class="si-detail">' + esc(p.relation) + '</span>' : '') + '</div>';
  }).join('');
  searchResults.style.display = 'block';
});
searchResults.addEventListener('click', function(e) {
  var item = e.target.closest('.search-item');
  if (item) { showPerson(item.dataset.name); searchInput.value = ''; searchResults.style.display = 'none'; }
});
searchInput.addEventListener('blur', function() { setTimeout(function() { searchResults.style.display = 'none'; }, 200); });

// Tab switching
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById(tab + '-tab').classList.add('active');
  btn.classList.add('active');
}

// Hash navigation
window.addEventListener('popstate', function() {
  var name = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
  if (name && byName[name] && name !== currentPerson) showPerson(name);
});

var _skipHash = true;
var initialHash = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
if (initialHash && byName[initialHash]) { _skipHash = false; showPerson(initialHash); }
else {
  showPerson('Rose Etta Kahn Sampson');
  // Switch back to narrative as the default landing tab
  var btns = document.querySelectorAll('.tab');
  switchTab('narrative', btns[0]);
  history.replaceState(null, '', location.pathname);
}
_skipHash = false;
<\/script>
</body>
</html>`;
}

export async function generateAndPublish(requestContext) {
  const { version } = await generatePage(requestContext);

  try {
    execSync('git add docs/index.html', { cwd: __dirname, stdio: 'pipe' });
    const msg = `Update family page — ${new Date().toISOString().split('T')[0]}`;
    execSync(`git commit -m "${msg}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'pipe' });
    console.log('[page] Committed and pushed.');
    return { ok: true, version };
  } catch (err) {
    console.error('[page] Git push failed:', err.message);
    return { ok: false, version: null };
  }
}

// Allow running standalone: node generate-page.js [--publish]
if (process.argv[1] && process.argv[1].endsWith('generate-page.js')) {
  const publish = process.argv.includes('--publish');
  if (publish) {
    generateAndPublish().catch(console.error);
  } else {
    generatePage().then(({ version }) => console.log(`[page] Done (local only, version: ${version}).`)).catch(console.error);
  }
}
