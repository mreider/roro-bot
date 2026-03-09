import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, 'docs');
const GED_PATH = join(DOCS_DIR, 'sampson-kahn.ged');
const TREE_PATH = join(__dirname, 'family-tree.json');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Convert "1907-12-10", "1907", or "~1921" to GEDCOM date format
function gedDate(raw) {
  if (!raw) return null;
  const s = String(raw);
  const approx = s.startsWith('~');
  const clean = s.replace(/^~/, '');
  const parts = clean.split('-');
  let out = '';
  if (parts.length === 3) {
    out = `${parseInt(parts[2])} ${MONTHS[parseInt(parts[1]) - 1]} ${parts[0]}`;
  } else if (parts.length === 2) {
    out = `${MONTHS[parseInt(parts[1]) - 1]} ${parts[0]}`;
  } else {
    out = parts[0];
  }
  return approx ? `ABT ${out}` : out;
}

// Parse a full name into given/surname for GEDCOM NAME field
// Handles: "Rose Etta Kahn Sampson", "Helen Kahn (née Lavenson)", "Dr. John Jacob Sampson"
function parseName(fullName) {
  let name = fullName;
  // Remove "(née ...)" — maiden name
  const neeMatch = name.match(/\(née\s+([^)]+)\)/i);
  name = name.replace(/\s*\(née\s+[^)]+\)/i, '').trim();
  // Remove titles
  name = name.replace(/^(Dr\.\s+|Rev\.\s+|Reverend\s+)/i, '').trim();
  // Remove parenthetical alternate names like "(Hertz)"
  name = name.replace(/\s*\([^)]+\)/g, '').trim();
  // Last word is surname (simplification — works for most Western names)
  const words = name.split(/\s+/);
  const surname = words.length > 1 ? words[words.length - 1] : words[0];
  const given = words.length > 1 ? words.slice(0, -1).join(' ') : '';
  // For née names, use maiden surname
  const maidenSurname = neeMatch ? neeMatch[1].trim() : null;
  return { given, surname, maidenSurname };
}

export function generateGedcom() {
  const data = JSON.parse(readFileSync(TREE_PATH, 'utf-8'));

  // Assign IDs
  const idMap = {};
  data.forEach((p, i) => { idMap[p.name] = `@I${i + 1}@`; });

  // Build family (FAM) records from couples
  // A family = two spouses (or one known) + their children
  const families = [];
  const famIndex = {}; // "parentA|parentB" -> fam id
  const processed = new Set();

  data.forEach(p => {
    if (!p.spouse || processed.has(p.name)) return;
    const spousePerson = data.find(s => s.name === p.spouse);
    if (spousePerson) processed.add(spousePerson.name);
    processed.add(p.name);

    const famId = `@F${families.length + 1}@`;
    const children = data.filter(c =>
      c.parents && c.parents.includes(p.name)
    );
    // Also check spouse's children
    if (spousePerson) {
      data.filter(c =>
        c.parents && c.parents.includes(spousePerson.name) &&
        !children.find(ch => ch.name === c.name)
      ).forEach(c => children.push(c));
    }

    // Determine husband/wife (simplistic: if name contains "née", they're wife)
    let husbName = p.name, wifeName = p.spouse;
    if (p.name.includes('née') || (spousePerson && !spousePerson.name.includes('née') && p.relation && /mother|wife|grandmother/i.test(p.relation))) {
      husbName = p.spouse;
      wifeName = p.name;
    }

    const fam = {
      id: famId,
      husb: idMap[husbName] || null,
      wife: idMap[wifeName] || null,
      children: children.map(c => idMap[c.name]).filter(Boolean),
      married: p.married || (spousePerson && spousePerson.married) || null,
    };

    families.push(fam);

    // Index so children can find their FAMC
    const key1 = [p.name, p.spouse].sort().join('|');
    famIndex[key1] = famId;
  });

  // Helper to find FAMC for a person
  function findFamC(person) {
    if (!person.parents) return [];
    // Find families where at least one parent matches
    return families.filter(f => {
      const fHusb = data.find(p => idMap[p.name] === f.husb);
      const fWife = data.find(p => idMap[p.name] === f.wife);
      const famParents = [fHusb?.name, fWife?.name].filter(Boolean);
      return person.parents.some(par => famParents.includes(par));
    }).map(f => f.id);
  }

  // Helper to find FAMS for a person
  function findFamS(person) {
    return families.filter(f => {
      return f.husb === idMap[person.name] || f.wife === idMap[person.name];
    }).map(f => f.id);
  }

  // Build GEDCOM
  let ged = '';
  ged += '0 HEAD\n';
  ged += '1 SOUR RoRo-Bot\n';
  ged += '2 NAME Grandma RoRo Family Bot\n';
  ged += '2 VERS 1.0\n';
  ged += '1 GEDC\n';
  ged += '2 VERS 5.5.1\n';
  ged += '2 FORM LINEAGE-LINKED\n';
  ged += '1 CHAR UTF-8\n';
  ged += '1 NOTE Generated from the Sampson-Kahn family tree maintained by RoRo Bot.\n';

  // INDI records
  for (const p of data) {
    const id = idMap[p.name];
    const { given, surname, maidenSurname } = parseName(p.name);
    const gedSurname = maidenSurname || surname;

    ged += `0 ${id} INDI\n`;
    ged += `1 NAME ${given} /${gedSurname}/\n`;
    if (given) ged += `2 GIVN ${given}\n`;
    ged += `2 SURN ${gedSurname}\n`;
    if (p.nicknames && p.nicknames.length) {
      ged += `2 NICK ${p.nicknames[0]}\n`;
    }

    if (p.born || p.birthplace) {
      ged += '1 BIRT\n';
      const bd = gedDate(p.born);
      if (bd) ged += `2 DATE ${bd}\n`;
      if (p.birthplace) ged += `2 PLAC ${p.birthplace}\n`;
    }

    if (p.died || p.deathplace) {
      ged += '1 DEAT\n';
      const dd = gedDate(p.died);
      if (dd) ged += `2 DATE ${dd}\n`;
      if (p.deathplace) ged += `2 PLAC ${p.deathplace}\n`;
    }

    if (p.notes) {
      // GEDCOM NOTE lines — split long notes into CONC lines (max 248 chars per line)
      const noteLines = [];
      let remaining = p.notes;
      noteLines.push(remaining.slice(0, 248));
      remaining = remaining.slice(248);
      while (remaining.length > 0) {
        noteLines.push(remaining.slice(0, 248));
        remaining = remaining.slice(248);
      }
      ged += `1 NOTE ${noteLines[0]}\n`;
      for (let i = 1; i < noteLines.length; i++) {
        ged += `2 CONC ${noteLines[i]}\n`;
      }
    }

    if (p.verification === 'contested') {
      const vNote = '[CONTESTED] ' + (p.verification_notes || 'This lineage connection is contested and lacks primary documentation.');
      const vLines = [];
      let vRem = vNote;
      vLines.push(vRem.slice(0, 248));
      vRem = vRem.slice(248);
      while (vRem.length > 0) {
        vLines.push(vRem.slice(0, 248));
        vRem = vRem.slice(248);
      }
      ged += `1 NOTE ${vLines[0]}\n`;
      for (let vi = 1; vi < vLines.length; vi++) {
        ged += `2 CONC ${vLines[vi]}\n`;
      }
    }

    if (p.sources) {
      for (const src of p.sources) {
        ged += `1 SOUR ${src}\n`;
      }
    }

    // FAMC (child of family)
    for (const famId of findFamC(p)) {
      ged += `1 FAMC ${famId}\n`;
    }

    // FAMS (spouse in family)
    for (const famId of findFamS(p)) {
      ged += `1 FAMS ${famId}\n`;
    }
  }

  // FAM records
  for (const f of families) {
    ged += `0 ${f.id} FAM\n`;
    if (f.husb) ged += `1 HUSB ${f.husb}\n`;
    if (f.wife) ged += `1 WIFE ${f.wife}\n`;
    if (f.married) {
      ged += '1 MARR\n';
      const md = gedDate(f.married);
      if (md) ged += `2 DATE ${md}\n`;
    }
    for (const childId of f.children) {
      ged += `1 CHIL ${childId}\n`;
    }
  }

  ged += '0 TRLR\n';

  mkdirSync(DOCS_DIR, { recursive: true });
  writeFileSync(GED_PATH, ged, 'utf-8');
  console.log(`[gedcom] Generated ${data.length} individuals, ${families.length} families → ${GED_PATH}`);
  return { individuals: data.length, families: families.length };
}

export function publishGedcom() {
  generateGedcom();
  try {
    execSync('git add docs/sampson-kahn.ged', { cwd: __dirname, stdio: 'pipe' });
    const msg = `Update GEDCOM export — ${new Date().toISOString().split('T')[0]}`;
    execSync(`git commit -m "${msg}"`, { cwd: __dirname, stdio: 'pipe' });
    execSync('git push', { cwd: __dirname, stdio: 'pipe' });
    console.log('[gedcom] Committed and pushed.');
    return true;
  } catch (err) {
    console.error('[gedcom] Git push failed:', err.message);
    return false;
  }
}

// Allow running standalone: node generate-gedcom.js [--publish]
if (process.argv[1] && process.argv[1].endsWith('generate-gedcom.js')) {
  const publish = process.argv.includes('--publish');
  if (publish) {
    publishGedcom();
  } else {
    generateGedcom();
    console.log('[gedcom] Done (local only).');
  }
}
