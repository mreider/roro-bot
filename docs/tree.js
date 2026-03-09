function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function getYears(p) {
  var parts = [];
  if (p.born) { var b = String(p.born); parts.push(b.length > 4 ? b.split('-')[0] : b); }
  if (p.died) { var d = String(p.died); parts.push(d.length > 4 ? d.split('-')[0] : d); }
  else if (parts.length) parts.push('');
  return parts.length < 2 ? (parts[0] || '') : parts[0] + '\u2013' + parts[1];
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

function showPerson(name, skipHash) {
  var person = byName[name];
  if (!person) return;
  currentPerson = name;

  if (!skipHash) {
    var newHash = '#' + encodeURIComponent(name);
    if (location.hash !== newHash) history.replaceState(null, '', newHash);
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

// Hash navigation
window.addEventListener('popstate', function() {
  var name = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
  if (name && byName[name] && name !== currentPerson) showPerson(name);
});

// On load: show person from hash, or default to Rose
var initialHash = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
if (initialHash && byName[initialHash]) {
  showPerson(initialHash);
} else {
  showPerson('Rose Etta Kahn Sampson');
}
