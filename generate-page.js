import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, 'docs');
const INDEX_PATH = join(DOCS_DIR, 'index.html');

function loadFile(path) {
  try { return readFileSync(path, 'utf-8'); } catch { return ''; }
}

export async function generatePage(requestContext) {
  const familyMd = loadFile(join(__dirname, 'FAMILY.md'));
  const familyJson = loadFile(join(__dirname, 'family-tree.json'));
  const soul = loadFile(join(__dirname, 'SOUL.md'));

  const anthropic = new Anthropic();

  // Generate the narrative section via Claude
  const prompt = `You are generating the NARRATIVE section of a family history page for the Sampson-Kahn family, in the voice of Grandma RoRo (Rose Etta Kahn Sampson, 1907–1997).

Here is RoRo's personality and voice:
${soul}

Here is the family tree in narrative form:
${familyMd}

Here is the structured family data:
${familyJson}

${requestContext ? `The family member who requested this page said: "${requestContext}". Take their request into account for the tone, focus, or style.` : ''}

Generate ONLY the narrative HTML content (no <!DOCTYPE>, no <html>, no <head>, no <body> — just the inner content divs). Requirements:

1. **Voice**: Written as if RoRo is telling you about her family. First person where natural. Warm, composed, proud but not boastful. Short, graceful sentences.

2. **Structure**: Use <div class="section"> wrappers with <h2> headings:
   - A brief introduction from RoRo
   - Sections by family branch (Kahn origins, the Lavensons, the Sampsons, RoRo & Grandpa John, their children, grandchildren, great-grandchildren)
   - The Sephardic ancestry as a fascinating open question
   - Key places (Oakland, Georgetown SC, Galveston, San Francisco, Curaçao)

3. **Content**: Use real dates, places, and stories. Don't invent facts. Include the rich details.

4. **Technical**: Just HTML content divs. No page structure, no CSS, no JavaScript. Use <p>, <h2>, <h3>, <ul>, <li> etc.

Output ONLY the HTML content. No markdown fences, no explanation.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 12000,
    messages: [{ role: 'user', content: prompt }],
  });

  let narrativeHtml = response.content[0]?.text || '';
  narrativeHtml = narrativeHtml.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();

  // Build the D3 tree data from family-tree.json
  const treeData = familyJson;

  // Assemble the full page
  const html = buildFullPage(narrativeHtml, treeData);

  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, html, 'utf-8');
  // Ensure CNAME stays for custom domain
  const cnamePath = join(DOCS_DIR, 'CNAME');
  if (!existsSync(cnamePath)) {
    writeFileSync(cnamePath, 'family.mreider.com\n', 'utf-8');
  }
  console.log(`[page] Generated ${html.length} bytes → ${INDEX_PATH}`);

  return html;
}

function buildFullPage(narrativeHtml, treeDataJson) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>The Sampson-Kahn Family</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    background: #faf8f4;
    color: #3a3226;
    line-height: 1.7;
  }

  header {
    background: linear-gradient(135deg, #4a3728 0%, #6b5344 100%);
    color: #f5f0e8;
    padding: 2.5rem 1.5rem;
    text-align: center;
  }

  header h1 {
    font-size: 2.2rem;
    font-weight: 400;
    letter-spacing: 0.05em;
    margin-bottom: 0.3rem;
  }

  header p {
    font-size: 1rem;
    opacity: 0.85;
    font-style: italic;
  }

  /* Tabs */
  .tabs {
    display: flex;
    justify-content: center;
    background: #e8e0d4;
    border-bottom: 2px solid #c9b99a;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .tab {
    padding: 0.9rem 2rem;
    cursor: pointer;
    font-family: Georgia, serif;
    font-size: 1rem;
    color: #6b5344;
    border: none;
    background: none;
    border-bottom: 3px solid transparent;
    transition: all 0.2s;
  }

  .tab:hover { color: #3a3226; background: rgba(255,255,255,0.3); }
  .tab.active { color: #3a3226; border-bottom-color: #8b6914; font-weight: 600; }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Tree tab */
  #tree-view {
    width: 100%;
    overflow: auto;
    background: #faf8f4;
    min-height: 80vh;
    position: relative;
  }

  #tree-container { width: 100%; }

  #tree-container svg { display: block; margin: 0 auto; }

  .node rect {
    fill: #fff;
    stroke: #c9b99a;
    stroke-width: 1.5;
    rx: 6;
    cursor: pointer;
    transition: all 0.2s;
  }

  .node rect:hover {
    stroke: #8b6914;
    stroke-width: 2;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
  }

  .node text { font-family: Georgia, serif; fill: #3a3226; pointer-events: none; }
  .node .name { font-size: 12px; font-weight: 600; }
  .node .dates { font-size: 10px; fill: #8b7355; }

  .link {
    fill: none;
    stroke: #c9b99a;
    stroke-width: 1.5;
  }

  .tree-controls {
    position: sticky;
    top: 50px;
    z-index: 50;
    display: flex;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.8rem;
    background: rgba(250, 248, 244, 0.95);
    border-bottom: 1px solid #e8e0d4;
  }

  .tree-controls button {
    padding: 0.4rem 1rem;
    font-family: Georgia, serif;
    font-size: 0.85rem;
    background: #fff;
    border: 1px solid #c9b99a;
    border-radius: 4px;
    cursor: pointer;
    color: #6b5344;
  }

  .tree-controls button:hover { background: #f0ebe3; }
  .tree-controls button.active { background: #6b5344; color: #fff; border-color: #6b5344; }

  /* Tooltip */
  .tooltip {
    position: absolute;
    background: #fff;
    border: 1px solid #c9b99a;
    border-radius: 8px;
    padding: 1rem;
    font-size: 0.85rem;
    max-width: 320px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    pointer-events: none;
    z-index: 200;
    display: none;
  }

  .tooltip h3 { margin-bottom: 0.3rem; color: #4a3728; font-size: 1rem; }
  .tooltip .detail { color: #8b7355; margin: 0.15rem 0; }
  .tooltip .notes { margin-top: 0.4rem; font-style: italic; color: #6b5344; }

  /* Narrative tab */
  #narrative-view {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }

  #narrative-view .section { margin-bottom: 2.5rem; }
  #narrative-view h2 {
    font-size: 1.5rem;
    color: #4a3728;
    border-bottom: 1px solid #d4c9b0;
    padding-bottom: 0.4rem;
    margin-bottom: 1rem;
  }
  #narrative-view h3 { font-size: 1.15rem; color: #6b5344; margin: 1rem 0 0.5rem; }
  #narrative-view p { margin-bottom: 0.8rem; }
  #narrative-view ul { margin: 0.5rem 0 1rem 1.5rem; }
  #narrative-view li { margin-bottom: 0.4rem; }

  footer {
    text-align: center;
    padding: 2rem;
    color: #a0937e;
    font-size: 0.85rem;
    font-style: italic;
    border-top: 1px solid #e8e0d4;
  }

  @media (max-width: 600px) {
    header h1 { font-size: 1.6rem; }
    .tab { padding: 0.7rem 1.2rem; font-size: 0.9rem; }
    #narrative-view { padding: 1.5rem 1rem; }
  }
</style>
</head>
<body>

<header>
  <h1>The Sampson-Kahn Family</h1>
  <p>Kept by RoRo &mdash; Rose Etta Kahn Sampson, 1907&ndash;1997</p>
</header>

<div class="tabs">
  <button class="tab active" onclick="switchTab('tree')">Family Tree</button>
  <button class="tab" onclick="switchTab('narrative')">Our Story</button>
</div>

<div id="tree-tab" class="tab-content active">
  <div class="tree-controls">
    <button id="btn-zoom-in" onclick="zoomIn()">Zoom In</button>
    <button id="btn-zoom-out" onclick="zoomOut()">Zoom Out</button>
    <button id="btn-fit" onclick="fitTree()">Fit All</button>
    <button id="btn-roro" class="active" onclick="centerOn('Rose Etta Kahn Sampson')">RoRo</button>
  </div>
  <div id="tree-view">
    <div id="tree-container"></div>
    <div class="tooltip" id="tooltip"></div>
  </div>
</div>

<div id="narrative-tab" class="tab-content">
  <div id="narrative-view">
    ${narrativeHtml}
  </div>
</div>

<footer>
  Composed by RoRo. The family historian knows what the family historian knows.<br>
  <a href="https://family.mreider.com" style="color:#a0937e">family.mreider.com</a>
</footer>

<script>
// --- Family data ---
const rawData = ${treeDataJson};

// --- Build tree hierarchy ---
function buildTree(data) {
  const byName = {};
  data.forEach(p => { byName[p.name] = { ...p, children: [] }; });

  // Find parent->child relationships
  data.forEach(p => {
    if (p.parents) {
      p.parents.forEach(parentName => {
        if (byName[parentName]) {
          const child = byName[p.name];
          if (!byName[parentName].children.find(c => c.name === child.name)) {
            byName[parentName].children.push(child);
          }
        }
      });
    }
  });

  // Root nodes: people with no parents in the dataset
  const childNames = new Set();
  data.forEach(p => {
    if (p.parents) p.parents.forEach(pn => {
      if (byName[pn]) childNames.add(p.name);
    });
  });

  // Find the best root — use RoRo's earliest ancestors
  // Start from RoRo and walk up to find top-level roots
  const roots = data.filter(p => !p.parents || !p.parents.some(pn => byName[pn]));
  const rootNodes = roots.map(r => byName[r.name]).filter(r => r.children.length > 0 || childNames.has(r.name));

  // Create a virtual root
  const virtualRoot = {
    name: 'Sampson-Kahn Family',
    children: rootNodes.length > 0 ? rootNodes : [byName['Rose Etta Kahn Sampson'] || Object.values(byName)[0]],
    _virtual: true,
  };

  return virtualRoot;
}

function getDates(person) {
  const parts = [];
  if (person.born) {
    const b = String(person.born);
    parts.push(b.length > 4 ? b.split('-')[0] : b);
  }
  if (person.died) {
    const d = String(person.died);
    parts.push(d.length > 4 ? d.split('-')[0] : d);
  } else if (person.is_alive || (!person.died && person.born)) {
    parts.push('');
  }
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts[0] + '–' + parts[1];
}

// --- D3 Tree ---
const treeRoot = buildTree(rawData);

const container = document.getElementById('tree-container');
const viewDiv = document.getElementById('tree-view');
const tooltip = document.getElementById('tooltip');

const nodeW = 160, nodeH = 52, hGap = 20, vGap = 70;

const hierarchy = d3.hierarchy(treeRoot);
const treeLayout = d3.tree().nodeSize([nodeW + hGap, nodeH + vGap]);
treeLayout(hierarchy);

// Compute bounds
let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
hierarchy.each(d => {
  if (d.x < x0) x0 = d.x;
  if (d.x > x1) x1 = d.x;
  if (d.y < y0) y0 = d.y;
  if (d.y > y1) y1 = d.y;
});

const padding = 80;
const svgW = (x1 - x0) + nodeW + padding * 2;
const svgH = (y1 - y0) + nodeH + padding * 2;

const svg = d3.select('#tree-container')
  .append('svg')
  .attr('width', svgW)
  .attr('height', svgH);

const g = svg.append('g')
  .attr('transform', \`translate(\${-x0 + padding + nodeW/2}, \${-y0 + padding + 20})\`);

// Zoom
const zoom = d3.zoom()
  .scaleExtent([0.15, 3])
  .on('zoom', (e) => g.attr('transform', e.transform));
svg.call(zoom);

// Initial transform
const initialTransform = d3.zoomIdentity
  .translate(-x0 + padding + nodeW/2, -y0 + padding + 20);
svg.call(zoom.transform, initialTransform);

// Links
g.selectAll('.link')
  .data(hierarchy.links().filter(d => !d.source.data._virtual || true))
  .enter()
  .append('path')
  .attr('class', 'link')
  .attr('d', d => {
    const sx = d.source.x, sy = d.source.y + nodeH/2;
    const tx = d.target.x, ty = d.target.y - nodeH/2;
    const mid = (sy + ty) / 2;
    return \`M\${sx},\${sy} C\${sx},\${mid} \${tx},\${mid} \${tx},\${ty}\`;
  });

// Nodes
const nodes = g.selectAll('.node')
  .data(hierarchy.descendants())
  .enter()
  .append('g')
  .attr('class', 'node')
  .attr('transform', d => \`translate(\${d.x - nodeW/2}, \${d.y - nodeH/2})\`)
  .style('display', d => d.data._virtual ? 'none' : null);

nodes.append('rect')
  .attr('width', nodeW)
  .attr('height', nodeH)
  .on('mouseover', (event, d) => showTooltip(event, d.data))
  .on('mousemove', (event) => moveTooltip(event))
  .on('mouseout', hideTooltip);

nodes.append('text')
  .attr('class', 'name')
  .attr('x', nodeW/2)
  .attr('y', nodeH/2 - 4)
  .attr('text-anchor', 'middle')
  .text(d => {
    const name = d.data.name || '';
    return name.length > 22 ? name.slice(0, 20) + '…' : name;
  });

nodes.append('text')
  .attr('class', 'dates')
  .attr('x', nodeW/2)
  .attr('y', nodeH/2 + 12)
  .attr('text-anchor', 'middle')
  .text(d => getDates(d.data));

// Tooltip
function showTooltip(event, data) {
  let html = '<h3>' + data.name + '</h3>';
  if (data.nicknames) html += '<div class="detail">Also: ' + data.nicknames.join(', ') + '</div>';
  const dates = getDates(data);
  if (dates) html += '<div class="detail">' + dates + '</div>';
  if (data.birthplace) html += '<div class="detail">Born: ' + data.birthplace + '</div>';
  if (data.deathplace) html += '<div class="detail">Died: ' + data.deathplace + '</div>';
  if (data.spouse) html += '<div class="detail">Spouse: ' + data.spouse + '</div>';
  if (data.relation) html += '<div class="detail">' + data.relation + '</div>';
  if (data.notes) {
    const notes = data.notes.length > 200 ? data.notes.slice(0, 200) + '…' : data.notes;
    html += '<div class="notes">' + notes + '</div>';
  }
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
}

function moveTooltip(event) {
  const rect = viewDiv.getBoundingClientRect();
  tooltip.style.left = (event.clientX - rect.left + 15) + 'px';
  tooltip.style.top = (event.clientY - rect.top + 15) + 'px';
}

function hideTooltip() { tooltip.style.display = 'none'; }

// Controls
function zoomIn() { svg.transition().duration(300).call(zoom.scaleBy, 1.4); }
function zoomOut() { svg.transition().duration(300).call(zoom.scaleBy, 0.7); }

function fitTree() {
  const vw = viewDiv.clientWidth, vh = viewDiv.clientHeight;
  const scale = Math.min(vw / svgW, vh / svgH, 1) * 0.9;
  const tx = (vw - svgW * scale) / 2;
  const ty = (vh - svgH * scale) / 2;
  svg.transition().duration(500)
    .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

function centerOn(name) {
  const node = hierarchy.descendants().find(d => d.data.name === name);
  if (!node) return;
  const vw = viewDiv.clientWidth, vh = viewDiv.clientHeight;
  const scale = 1;
  const tx = vw/2 - node.x * scale;
  const ty = vh/3 - node.y * scale;
  svg.transition().duration(500)
    .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

// Tab switching
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById(tab + '-tab').classList.add('active');
  event.target.classList.add('active');
  if (tab === 'tree') setTimeout(fitTree, 100);
}

// Initial fit
setTimeout(fitTree, 200);
<\/script>

</body>
</html>`;
}

export async function generateAndPublish(requestContext) {
  await generatePage(requestContext);

  try {
    execSync('git add docs/index.html', { cwd: __dirname, stdio: 'pipe' });
    const msg = `Update family page — ${new Date().toISOString().split('T')[0]}`;
    execSync(`git commit -m "${msg}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'pipe' });
    console.log('[page] Committed and pushed.');
    return true;
  } catch (err) {
    console.error('[page] Git push failed:', err.message);
    return false;
  }
}

// Allow running standalone: node generate-page.js [--publish]
if (process.argv[1] && process.argv[1].endsWith('generate-page.js')) {
  const publish = process.argv.includes('--publish');
  if (publish) {
    generateAndPublish().catch(console.error);
  } else {
    generatePage().then(() => console.log('[page] Done (local only).')).catch(console.error);
  }
}
