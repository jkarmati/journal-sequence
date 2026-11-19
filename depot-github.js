/* Base du Journal de séquence dans un dépôt GitHub PRIVÉ, lue et écrite par l'API GitHub.
 *
 * Imite les fonctions de la base claude.ai utilisées par la page :
 *   db.doc(chemin).set(données)              → Promise
 *   db.doc(chemin).onSnapshot(cb, err)       → cb({exists, id, data()})
 *   db.collection(chemin).onSnapshot(cb, err)→ cb({docs: [{id, data()}], metadata: {fromCache}})
 * Un document = un fichier JSON : « seq/ch05-thales » ↔ seq/ch05-thales.json.
 *
 * - Lecture : liste des fichiers toutes les 20 s quand la page est à l'écran (requête conditionnelle :
 *   rien n'est téléchargé si rien n'a changé), puis seulement les fichiers modifiés.
 * - Écriture : une à la fois, avec le « sha » du fichier lu. Si le fichier a changé entre-temps (la synchro du
 *   PC, ou un autre appareil), il est relu et les deux versions sont fusionnées champ par champ : ce que la page
 *   vient de changer l'emporte, le reste vient de la version relue (aucune coche ni état d'envoi perdu).
 * - Sans réseau : les modifications restent sur l'appareil (localStorage) et repartent dès que possible.
 */
(function (global) {
  'use strict';

  // ---------- outils ----------
  const estObjet = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const copie = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function egal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => egal(x, b[i]));
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && egal(a[k], b[k]));
  }
  // Fusion à trois versions : base (ce que la page avait lu), mien (ce que la page veut écrire), leur (version
  // actuelle du dépôt). Champ par champ : changé seulement de mon côté → le mien ; seulement de leur côté → le leur ;
  // des deux côtés → on descend dans les objets, et pour une valeur simple la modification de la page l'emporte.
  function fusion3(base, mien, leur) {
    if (egal(mien, base)) return copie(leur);
    if (egal(leur, base) || egal(leur, mien)) return copie(mien);
    // Nouvelle demande d'envoi faite sur la page (nouveau « valideLe ») : elle est prise en entier, sans
    // mélange avec un état d'envoi plus ancien écrit entre-temps par le PC.
    if (estObjet(mien) && 'valideLe' in mien && mien.valideLe !== (estObjet(base) ? base.valideLe : undefined)) return copie(mien);
    if (estObjet(mien) && estObjet(leur)) {
      const b = estObjet(base) ? base : {};
      const out = {};
      for (const k of new Set([...Object.keys(leur), ...Object.keys(mien)])) {
        const v = fusion3(b[k], mien[k], leur[k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return copie(mien);
  }
  function versBase64(texte) {
    const o = new TextEncoder().encode(texte);
    let bin = '';
    for (let i = 0; i < o.length; i += 0x8000) bin += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function depuisBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  const enFichier = data => JSON.stringify(data, null, 1) + '\n';
  const lireLS = (cle, defaut) => { try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; } catch (e) { return defaut; } };
  const ecrireLS = (cle, v) => { try { if (v === null) localStorage.removeItem(cle); else localStorage.setItem(cle, JSON.stringify(v)); } catch (e) { /* stockage plein ou bloqué */ } };

  class ErreurDepot extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }

  function ouvrir({ depot, jeton, api = 'https://api.github.com', branche = 'main', periode = 20000, surEtat = () => {} }) {
    const R = `${api.replace(/\/$/, '')}/repos/${depot}`;
    const CLE_CACHE = 'journal.cache.' + depot, CLE_ATTENTE = 'journal.attente.' + depot;
    const contenus = {};                 // doc → {sha, data} : dernière version connue du dépôt
    const anciens = {};                  // doc → Set(sha) remplacés par nos écritures (listes de fichiers en retard)
    let attente = lireLS(CLE_ATTENTE, {}); // doc → {data, base} : écritures pas encore faites
    let etag = null, charge = false, depuisCache = true, horsLigne = false, erreur = null;
    const ecDocs = new Map(), ecCols = new Map();
    let chaine = Promise.resolve();      // une opération réseau à la fois
    const enFile = f => (chaine = chaine.then(f, f));

    const cache = lireLS(CLE_CACHE, null);
    if (cache && cache.contenus) { Object.assign(contenus, cache.contenus); etag = cache.etag || null; charge = true; }
    const sauverCache = () => ecrireLS(CLE_CACHE, { etag, contenus });
    const sauverAttente = () => ecrireLS(CLE_ATTENTE, Object.keys(attente).length ? attente : null);
    const signaler = () => surEtat({ attente: Object.keys(attente).length, horsLigne, erreur, frais: !depuisCache });

    async function appel(methode, chemin, corps, entetes) {
      let r;
      try {
        r = await fetch(R + chemin, {
          method: methode, cache: 'no-store',
          headers: Object.assign({ Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + jeton,
            'X-GitHub-Api-Version': '2022-11-28' }, corps ? { 'Content-Type': 'application/json' } : {}, entetes || {}),
          body: corps ? JSON.stringify(corps) : undefined,
        });
      } catch (e) {
        throw new ErreurDepot('reseau', 'pas de réseau');
      }
      horsLigne = false;
      return r;
    }
    async function echec(r) {
      let m = '';
      try { m = (await r.json()).message || ''; } catch (e) { /* vide */ }
      if (r.status === 401) return new ErreurDepot('jeton', 'jeton refusé par GitHub (expiré ou révoqué ?)');
      if (r.status === 403 && /rate limit/i.test(m)) return new ErreurDepot('quota', 'trop de requêtes, nouvel essai dans un moment');
      if (r.status === 403 || r.status === 404) return new ErreurDepot('acces', `ce jeton n’a pas accès au dépôt ${depot}`);
      return new ErreurDepot('github', `GitHub ${r.status}${m ? ' : ' + m : ''}`);
    }
    const cheminFichier = doc => '/contents/' + (doc + '.json').split('/').map(encodeURIComponent).join('/');

    // ---------- lecture ----------
    const vu = doc => (attente[doc] ? attente[doc].data : (contenus[doc] ? contenus[doc].data : undefined));
    const snapDoc = doc => { const d = vu(doc); return { id: doc.split('/').pop(), exists: d !== undefined, data: () => copie(d) }; };
    function snapCol(col) {
      const ids = new Set([...Object.keys(contenus), ...Object.keys(attente)]);
      const docs = [...ids].filter(d => d.startsWith(col + '/') && !d.slice(col.length + 1).includes('/'))
        .sort().map(d => ({ id: d.slice(col.length + 1), data: () => copie(vu(d)) }));
      return { docs, metadata: { fromCache: depuisCache } };
    }
    function notifier(docs) {
      const tous = docs === null;
      for (const [doc, cbs] of ecDocs) if (tous || docs.includes(doc)) for (const [cb] of cbs) cb(snapDoc(doc));
      for (const [col, cbs] of ecCols) {
        if (tous || docs.some(d => d.startsWith(col + '/') && !d.slice(col.length + 1).includes('/'))) for (const [cb] of cbs) cb(snapCol(col));
      }
    }
    function erreurLecture(e) {
      for (const cbs of [...ecDocs.values(), ...ecCols.values()]) for (const [, err] of cbs) if (err) err(e);
    }

    async function rafraichir() {
      const r = await appel('GET', `/git/trees/${branche}?recursive=1`, null, etag ? { 'If-None-Match': etag } : {});
      if (r.status === 304) {
        if (depuisCache) { depuisCache = false; notifier(null); }
        return;
      }
      if (!r.ok) throw await echec(r);
      const arbre = await r.json();
      const shas = {};
      for (const e of arbre.tree || []) if (e.type === 'blob' && e.path.endsWith('.json')) shas[e.path.slice(0, -5)] = e.sha;
      const changes = Object.keys(shas).filter(d => !(contenus[d] && contenus[d].sha === shas[d])
        && !(anciens[d] && anciens[d].has(shas[d])) && !attente[d]);
      await Promise.all(changes.map(async doc => {
        const b = await appel('GET', `/git/blobs/${shas[doc]}`);
        if (!b.ok) throw await echec(b);
        contenus[doc] = { sha: shas[doc], data: JSON.parse(depuisBase64((await b.json()).content)) };
      }));
      const supprimes = Object.keys(contenus).filter(d => !(d in shas) && !attente[d] && !(anciens[d]));
      for (const d of supprimes) delete contenus[d];
      etag = r.headers.get('ETag');
      const premier = depuisCache || !charge;
      charge = true; depuisCache = false;
      sauverCache();
      notifier(premier ? null : changes.concat(supprimes));
    }

    // ---------- écriture ----------
    async function ecrireUn(doc) {
      const a = attente[doc];
      if (!a) return;
      let sha = contenus[doc] ? contenus[doc].sha : null;
      let data = a.data;
      for (let essai = 0; essai < 5; essai++) {
        const r = await appel('PUT', cheminFichier(doc),
          Object.assign({ message: `Journal : ${doc}`, branch: branche, content: versBase64(enFichier(data)) }, sha ? { sha } : {}));
        if (r.ok) {
          const nv = (await r.json()).content.sha;
          if (sha) (anciens[doc] = anciens[doc] || new Set()).add(sha);
          contenus[doc] = { sha: nv, data };
          if (attente[doc] === a) delete attente[doc];
          else if (attente[doc]) attente[doc].base = copie(data);  // modifié encore pendant l'envoi : repart de là
          sauverAttente(); sauverCache();
          if (!egal(data, a.data)) notifier([doc]);  // fusion : la page reçoit la version fusionnée
          return;
        }
        let msg = '';
        if (r.status === 409 || r.status === 422) {
          try { msg = (await r.clone().json()).message || ''; } catch (e) { /* vide */ }
        }
        if (r.status === 409 || (r.status === 422 && /sha/i.test(msg))) {
          // Le fichier a changé (ou existe déjà) : on relit la version du dépôt et on fusionne.
          const f = await appel('GET', cheminFichier(doc) + `?ref=${encodeURIComponent(branche)}`);
          if (f.status === 404) { sha = null; data = a.data; continue; }
          if (!f.ok) throw await echec(f);
          const j = await f.json();
          const leur = JSON.parse(depuisBase64(j.content));
          if (sha) (anciens[doc] = anciens[doc] || new Set()).add(sha);
          sha = j.sha;
          contenus[doc] = { sha, data: leur };
          data = fusion3(a.base === null ? undefined : a.base, a.data, leur);
          continue;
        }
        throw await echec(r);
      }
      throw new ErreurDepot('conflit', 'le document change sans arrêt, nouvel essai plus tard');
    }
    async function viderAttente() {
      for (const doc of Object.keys(attente)) await ecrireUn(doc);
    }
    let relance = null;
    function gererEchec(e) {
      if (e.code === 'reseau') horsLigne = true;
      else erreur = e;
      signaler();
      if (!relance) relance = setTimeout(() => { relance = null; synchroniser(); }, 30000);
      if (e.code !== 'reseau') throw e;
    }
    function set(doc, data) {
      const prec = attente[doc];
      attente[doc] = { data: copie(data), base: prec ? prec.base : (contenus[doc] ? copie(contenus[doc].data) : null) };
      sauverAttente(); signaler();
      return enFile(async () => {
        try { await ecrireUn(doc); erreur = null; } catch (e) { gererEchec(e); }
        signaler();
      });
    }

    function synchroniser() {
      return enFile(async () => {
        try { await viderAttente(); await rafraichir(); erreur = null; }
        catch (e) {
          if (e.code !== 'reseau') erreurLecture(e);
          try { gererEchec(e); } catch (e2) { /* déjà signalé */ }
        }
        signaler();
      });
    }

    function ecouter(table, cle, cb, err, snap) {
      if (!table.has(cle)) table.set(cle, new Set());
      const paire = [cb, err];
      table.get(cle).add(paire);
      if (charge) setTimeout(() => cb(snap(cle)), 0);
      return () => table.get(cle).delete(paire);
    }

    let minuteur = null;
    function demarrer() {
      synchroniser();
      minuteur = setInterval(() => { if (document.visibilityState === 'visible') synchroniser(); }, periode);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synchroniser(); });
      global.addEventListener('online', () => synchroniser());
      signaler();
    }

    return {
      db: {
        doc: chemin => ({ set: d => set(chemin, d), onSnapshot: (cb, err) => ecouter(ecDocs, chemin, cb, err, snapDoc) }),
        collection: chemin => ({ onSnapshot: (cb, err) => ecouter(ecCols, chemin, cb, err, snapCol) }),
      },
      demarrer, synchroniser,
      enAttente: () => Object.keys(attente).length,
      arreter: () => clearInterval(minuteur),
    };
  }

  // Vérifie un jeton avant de l'enregistrer : accès au dépôt, dépôt privé, droit d'écriture.
  async function verifier({ depot, jeton, api = 'https://api.github.com' }) {
    let r;
    try {
      r = await fetch(`${api.replace(/\/$/, '')}/repos/${depot}`, { cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + jeton, 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (e) { throw new ErreurDepot('reseau', 'pas de réseau'); }
    if (r.status === 401) throw new ErreurDepot('jeton', 'GitHub refuse ce jeton (mal copié, expiré ou révoqué ?)');
    if (r.status === 403 || r.status === 404) throw new ErreurDepot('acces', `ce jeton n’a pas accès au dépôt ${depot}`);
    if (!r.ok) throw new ErreurDepot('github', 'GitHub ' + r.status);
    const info = await r.json();
    if (!info.private) throw new ErreurDepot('public', `le dépôt ${depot} est PUBLIC : le Journal refuse de s’en servir (tes notes seraient lisibles par tous)`);
    if (info.permissions && !info.permissions.push) throw new ErreurDepot('lecture', 'ce jeton peut lire mais pas écrire : donne-lui « Contents : Read and write »');
    return info;
  }

  global.DepotGitHub = { ouvrir, verifier, fusion3, egal, ErreurDepot, _base64: { versBase64, depuisBase64 } };
})(typeof window !== 'undefined' ? window : globalThis);
