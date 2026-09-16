// Patch a live element to match new markup, touching only what differs. The page renders each
// change as one HTML string; setting it as innerHTML would drop every node and start every
// animation over. Instead the string is parsed off-screen and the live tree is walked against
// it: text and attributes that changed are set, nodes that came or went are added or removed,
// and everything else is left alone. An element with an id is matched by that id among its
// siblings, so a list that gained or lost an entry keeps the nodes of the entries still there.
(function () {
  'use strict';
  function morph(el, html) {
    var tpl = document.createElement('template'); tpl.innerHTML = html;
    children(el, tpl.content);
  }
  function same(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || (a.id || '') === (b.id || '')); }
  function byId(from, id) { for (var n = from; n; n = n.nextSibling) if (n.nodeType === 1 && n.id === id) return n; return null; }
  function children(a, b) {
    var ac = a.firstChild, bc = b.firstChild, next, m;
    while (bc) {
      next = bc.nextSibling;
      if (!ac) a.appendChild(bc);
      else if (same(ac, bc)) { node(ac, bc); ac = ac.nextSibling; }
      else if (ac.nodeType === 1 && ac.id && !byId(bc, ac.id)) { m = ac; ac = ac.nextSibling; a.removeChild(m); continue; }
      else if ((m = bc.nodeType === 1 && bc.id ? byId(ac.nextSibling, bc.id) : null)) { a.insertBefore(m, ac); node(m, bc); }
      else a.insertBefore(bc, ac);
      bc = next;
    }
    while (ac) { next = ac.nextSibling; a.removeChild(ac); ac = next; }
  }
  function node(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    var i, at;
    for (i = a.attributes.length - 1; i >= 0; i--) { at = a.attributes[i]; if (!b.hasAttribute(at.name)) a.removeAttribute(at.name); }
    for (i = 0; i < b.attributes.length; i++) { at = b.attributes[i]; if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value); }
    children(a, b);
  }
  window.morph = morph;
})();
