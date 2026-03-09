import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

  const prompt = `You are generating a single-page HTML website for the Sampson-Kahn family history, narrated in the voice of Grandma RoRo (Rose Etta Kahn Sampson, 1907–1997).

Here is RoRo's personality and voice:
${soul}

Here is the family tree in narrative form:
${familyMd}

Here is the structured family data:
${familyJson}

${requestContext ? `The family member who requested this page said: "${requestContext}". Take their request into account for the tone, focus, or style of the page.` : ''}

Generate a COMPLETE, standalone HTML page (with all CSS inline in a <style> tag). Requirements:

1. **Design**: Elegant, warm, timeless. Think cream/ivory backgrounds, serif fonts, muted gold or brown accents. It should feel like opening a family album. Responsive for mobile.

2. **Voice**: Written as if RoRo is telling you about her family. First person where natural. Warm, composed, proud but not boastful. Short, graceful sentences — the way she actually spoke.

3. **Structure**:
   - A header with the family name and a brief introduction from RoRo
   - Sections organized by family branches (Kahn origins, the Lavensons, the Sampsons, RoRo & Grandpa John, their children, grandchildren, great-grandchildren)
   - The Sephardic ancestry section should be presented as the fascinating open question it is
   - A section about key places (Oakland, Georgetown SC, Galveston, San Francisco, Curaçao)
   - A footer noting this page was composed by RoRo

4. **Content**: Use the real dates, places, and stories from the data. Don't invent facts. Include the rich details — the Rotunda Building, the 1906 earthquake, Pete's 4:11 mile, Grandpa John's 49 publications, the Beth Haim cemetery in Curaçao.

5. **Technical**: Pure HTML + CSS. No JavaScript. No external dependencies. No images (unless you use CSS shapes/gradients for decoration). Must be a complete valid HTML5 document.

Output ONLY the HTML. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  let html = response.content[0]?.text || '';

  // Strip markdown fences if present
  html = html.replace(/^```html?\n?/, '').replace(/\n?```$/, '').trim();

  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, html, 'utf-8');
  console.log(`[page] Generated ${html.length} bytes → ${INDEX_PATH}`);

  return html;
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
