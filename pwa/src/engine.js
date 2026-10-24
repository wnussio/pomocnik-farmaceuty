// Logika aplikacji bez interfejsu: normalizacja, wyszukiwanie leków i substancji, zamienniki,
// suplementy i sprawdzanie interakcji. Port 1:1 z app/normalize.py, app/store.py,
// app/supplements.py i app/interactions.py (zgodność sprawdza pwa/test_parity.py).
"use strict";

const Engine = (() => {
  const ORTHO = [["ks", "x"], ["th", "t"], ["ph", "f"], ["y", "i"], ["k", "c"], ["w", "v"], ["z", "s"]];
  const SUFFIXES = ["um", "us", "is", "as", "ae", "a", "e", "i"];
  const LEVEL_ORDER = { przeciwwskazane: 0, istotna: 1, niewielka: 2 };
  const PARACETAMOL_KEY = "paracetamol";

  let ignored = new Set();
  let aliases = {};

  /* ---------- normalizacja ---------- */

  function simple(text) {
    const t = (text || "").toLowerCase().replace(/ł/g, "l").normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return t.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).join(" ");
  }

  function stem(word) {
    let w = simple(word).replace(/ /g, "");
    for (const [a, b] of ORTHO) w = w.split(a).join(b);
    w = w.replace(/(.)\1+/g, "$1");
    for (const s of SUFFIXES) {
      if (w.endsWith(s) && w.length - s.length >= 3) { w = w.slice(0, -s.length); break; }
    }
    if (w.endsWith("ic") && w.length > 5) w = w.slice(0, -2);
    if (w.endsWith("i") && w.length > 3) w = w.slice(0, -1);
    return w;
  }

  function substanceTokens(name) {
    const words = simple(name).split(" ").filter((w) => /^[a-z]+$/.test(w) && w.length > 1);
    const keep = words.filter((w) => !ignored.has(w));
    return (keep.length ? keep : words).map(stem);
  }

  function queryTokens(query) {
    let q = simple(query);
    for (const [pl, latin] of Object.entries(aliases)) {
      if (q === pl || q.startsWith(pl + " ")) { q = latin + q.slice(pl.length); break; }
    }
    return q ? substanceTokens(q) : [];
  }

  function trigrams(text) {
    const t = `  ${text} `;
    const out = new Set();
    for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
    return out;
  }

  function fuzzy(q, getIndex, limit, threshold = 0.35) {
    const index = getIndex();
    const qTri = trigrams(q);
    const counts = new Map();
    for (const tri of qTri) for (const cand of index.get(tri) || []) counts.set(cand, (counts.get(cand) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400);
    const out = [];
    for (const [cand, common] of top) {
      const sim = (2 * common) / (qTri.size + trigrams(cand).size);
      if (sim >= threshold) out.push([cand, sim]);
    }
    return out.sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function buildTrigramIndex(texts) {
    const index = new Map();
    for (const text of texts) for (const tri of trigrams(text)) {
      if (!index.has(tri)) index.set(tri, new Set());
      index.get(tri).add(text);
    }
    return index;
  }

  const pyCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);  // porządek jak sorted() w Pythonie

  /* ---------- baza leków ---------- */

  class Store {
    constructor(raw) {
      this.meta = raw.meta;
      this.keyNames = raw.nazwy_substancji;
      const subs = raw.substancje.map(([key, name, tokens]) => ({ key, name, tokens: tokens ? tokens.split(" ") : [] }));
      this.products = new Map();
      this.names = new Map();
      this.byKey = new Map();
      for (const r of raw.leki) {
        const [id, name, strength, formI, groupI, holderI, cats, flags, atc, routeIs, subList] = r;
        const p = {
          id, name, strength, form: raw.postacie[formI], formGroup: raw.grupy_postaci[groupI],
          holder: raw.podmioty[holderI], categories: cats ? cats.split(",") : [],
          active: Boolean(flags & 1), topical: Boolean(flags & 2), atc: atc ? atc.split(",") : [],
          routes: routeIs.map((i) => raw.drogi[i]),
          substances: subList.map(([si, text, value, dimI]) => ({
            ...subs[si], text, value, dim: dimI >= 0 ? raw.wymiary[dimI] : null })),
          searchName: simple(name),
        };
        p.keys = new Set(p.substances.map((s) => s.key));
        this.products.set(id, p);
        if (!this.names.has(p.searchName)) this.names.set(p.searchName, []);
        this.names.get(p.searchName).push(id);
        for (const s of p.substances) {
          if (!s.key) continue;
          if (!this.byKey.has(s.key)) this.byKey.set(s.key, []);
          this.byKey.get(s.key).push(id);
        }
      }
      this.keyCounts = new Map([...this.byKey].map(([k, ids]) => [k, new Set(ids).size]));
      this.gtin = null;  // ładowane przy pierwszym wyszukiwaniu po EAN
      this._nameTri = null;
      this._keyTri = null;
    }

    nameTrigrams() { return this._nameTri || (this._nameTri = buildTrigramIndex(this.names.keys())); }
    keyTrigrams() { return this._keyTri || (this._keyTri = buildTrigramIndex(Object.keys(this.keyNames))); }

    isEanQuery(query) {
      const digits = query.replace(/\D/g, "");
      return digits.length >= 8 && digits.length >= query.trim().length - 1;
    }

    searchProducts(query, limit = 40) {
      if (this.isEanQuery(query)) {
        const id = this.gtin && this.gtin[query.replace(/\D/g, "").replace(/^0+/, "")];
        return id ? [this.products.get(id)] : [];
      }
      const q = simple(query);
      if (!q) return [];
      const qWords = q.split(" ");
      const scored = new Map();
      for (const name of this.names.keys()) {
        if (name.startsWith(q)) scored.set(name, 3 - name.length / 1000);
        else if (qWords.every((qw) => name.split(" ").some((w) => w.startsWith(qw)))) scored.set(name, 2 - name.length / 1000);
        else if (name.includes(q)) scored.set(name, 1.5);
      }
      if (scored.size < 5) {
        for (const [name, sim] of fuzzy(q, () => this.nameTrigrams(), 15)) if (!scored.has(name)) scored.set(name, sim);
      }
      const ranked = [...scored.keys()].sort((a, b) => scored.get(b) - scored.get(a) || pyCompare(a, b));
      const results = [];
      for (const name of ranked) {
        const group = this.names.get(name).map((i) => this.products.get(i)).sort((a, b) =>
          (a.active === b.active ? 0 : a.active ? -1 : 1) || pyCompare(a.strength, b.strength) || pyCompare(a.form, b.form));
        results.push(...group);
        if (results.length >= limit) break;
      }
      return results.slice(0, limit);
    }

    searchSubstances(query, limit = 20) {
      const qTokens = queryTokens(query);
      if (!qTokens.length) return [];
      let hits = Object.keys(this.keyNames).filter((k) =>
        qTokens.every((qt) => k.split(" ").some((t) => t.startsWith(qt))));
      if (!hits.length) hits = fuzzy(qTokens.join(" "), () => this.keyTrigrams(), limit, 0.4).map(([k]) => k);
      const exact = qTokens.join(" ");
      hits.sort((a, b) => ((a !== exact) - (b !== exact)) || (a.split(" ").length - b.split(" ").length)
        || ((this.keyCounts.get(b) || 0) - (this.keyCounts.get(a) || 0)));
      return hits.slice(0, limit).map((k) => ({ klucz: k, nazwa: this.keyNames[k], liczba_lekow: this.keyCounts.get(k) || 0 }));
    }

    equivalents(keys, includeCombinations) {
      const wanted = new Set(keys);
      if (!wanted.size) return [];
      const lists = [...wanted].map((k) => new Set(this.byKey.get(k) || []));
      const ids = [...lists[0]].filter((id) => lists.every((l) => l.has(id)));
      const out = [];
      for (const id of ids) {
        const p = this.products.get(id);
        const same = p.keys.size === wanted.size && [...wanted].every((k) => p.keys.has(k));
        const superset = p.keys.size > wanted.size && [...wanted].every((k) => p.keys.has(k));
        if (same || (includeCombinations && superset)) out.push(p);
      }
      return out.sort((a, b) => pyCompare(a.name.toLowerCase(), b.name.toLowerCase()) || pyCompare(a.strength, b.strength) || a.id - b.id);
    }

    substanceName(key) { return this.keyNames[key] || key; }

    checkItem(p) {
      return { label: `${p.name} ${p.strength}`.trim(), atc: p.atc, topical: p.topical,
               substances: p.substances.map((s) => [s.key, s.tokens, s.name]) };
    }
  }

  /* ---------- suplementy ---------- */

  class Supplements {
    constructor(raw) {
      this.status = raw.status;
      this.items = raw.skladniki.map((s) => ({ ...s, words: s.szukaj.split(" "), stems: new Set(s.rdzenie) }));
      this.byId = new Map(this.items.map((s) => [s.id, s]));
    }

    search(query) {
      const q = simple(query);
      if (!q) return this.items;
      const qWords = q.split(" ");
      return this.items.filter((s) => qWords.every((qw) => s.words.some((w) => w.startsWith(qw)) || s.stems.has(stem(qw))));
    }

    checkItem(id) {
      const s = this.byId.get(id);
      return s && { label: s.nazwa, atc: s.atc, topical: false, substances: s.substancje };
    }
  }

  /* ---------- interakcje ---------- */

  function matchGroups(item, groups) {
    const out = new Map();
    for (const g of groups) {
      let hits = item.substances.filter(([, tokens]) => tokens.some((t) => g.tokens.has(t))).map(([k, , n]) => [k, n]);
      if (!hits.length && g.atc.length && item.atc.some((c) => g.atc.some((pre) => c.startsWith(pre)))) {
        hits = item.substances.length ? item.substances.map(([k, , n]) => [k, n]) : [[null, item.label]];
      }
      if (hits.length) out.set(g.id, hits);
    }
    return out;
  }

  class Interactions {
    constructor(raw) {
      this.status = raw.status;
      this.version = raw.wersja;
      this.groups = Object.entries(raw.grupy).map(([id, g]) => ({ id, name: g.nazwa, tokens: new Set(g.tokeny), atc: g.atc, within: g.w_obrebie }));
      this.byId = new Map(this.groups.map((g) => [g.id, g]));
      this.rules = raw.reguly;
    }

    get summary() {
      return { status: this.status, wersja: this.version, liczba_grup: this.groups.length, liczba_regul: this.rules.length };
    }

    matchGroups(item) { return matchGroups(item, this.groups); }

    check(items) {
      const notes = [];
      const active = [];
      items.forEach((item, idx) => {
        if (item.topical) notes.push(`${item.label}: lek o działaniu miejscowym – pominięty w analizie interakcji ogólnoustrojowych.`);
        else active.push(idx);
      });
      const matches = new Map(active.map((idx) => [idx, this.matchGroups(items[idx])]));
      const results = [];
      active.forEach((i, n) => { for (const j of active.slice(n + 1)) results.push(...this.checkPair(i, j, items, matches)); });
      results.sort((a, b) => LEVEL_ORDER[a.poziom] - LEVEL_ORDER[b.poziom] || a.pozycje[0] - b.pozycje[0] || a.pozycje[1] - b.pozycje[1]);
      return { wyniki: results, uwagi: notes, baza: this.summary };
    }

    checkPair(i, j, items, matches) {
      const a = items[i], b = items[j];
      const ma = matches.get(i), mb = matches.get(j);
      const found = [];
      const uniqSorted = (xs) => [...new Set(xs)].sort(pyCompare);
      const result = (typ, poziom, tytul, opis, zalecenie, subsA, subsB, swapped = false) => {
        const pair = [[a, subsA], [b, subsB]];
        if (swapped) pair.reverse();
        found.push({ typ, poziom, tytul, opis, zalecenie, pozycje: [i, j],
                     leki: pair.map(([item, subs]) => ({ nazwa: item.label, substancje: uniqSorted(subs) })) });
      };
      const keysOf = (item) => new Set(item.substances.map(([k]) => k).filter(Boolean));
      const ka = keysOf(a), kb = keysOf(b);

      for (const key of [...ka].filter((k) => kb.has(k)).sort(pyCompare)) {
        const name = a.substances.find(([k]) => k === key)[2];
        const opis = key === PARACETAMOL_KEY
          ? "Oba leki zawierają paracetamol – ryzyko przekroczenia dawki dobowej (maks. zwykle 4 g/dobę u dorosłych, mniej u osób z chorobami wątroby lub pijących alkohol) i ciężkiego uszkodzenia wątroby."
          : `Oba leki zawierają tę samą substancję czynną (${name}) – ryzyko przedawkowania.`;
        result("dublowanie_substancji", "istotna", `Dublowanie substancji: ${name}`, opis,
               "Sprawdzić łączną dawkę dobową; zwykle stosować tylko jeden z tych leków.", [name], [name]);
      }

      for (const rule of this.rules) {
        for (const [swapped, mx, my] of [[false, ma, mb], [true, mb, ma]]) {
          if (mx.has(rule.a) && my.has(rule.b)) {
            const subsX = mx.get(rule.a).map(([, n]) => n);
            const subsY = my.get(rule.b).map(([, n]) => n);
            const [subsA, subsB] = swapped ? [subsY, subsX] : [subsX, subsY];
            const tytul = `${this.byId.get(rule.a).name} + ${this.byId.get(rule.b).name}`;
            result("regula", rule.poziom, tytul, rule.opis, rule.zalecenie || "", subsA, subsB, swapped);
            break;
          }
        }
      }

      let groupHit = false;
      for (const g of this.groups) {
        if (!ma.has(g.id) || !mb.has(g.id)) continue;
        const keysA = new Set(ma.get(g.id).map(([k]) => k));
        const keysB = new Set(mb.get(g.id).map(([k]) => k));
        const sameKeys = keysA.size === keysB.size && [...keysA].every((k) => keysB.has(k));
        if (sameKeys && !keysA.has(null)) continue;
        groupHit = true;
        if (g.within) {
          result("w_obrebie_grupy", g.within.poziom, g.name, g.within.opis, g.within.zalecenie || "",
                 ma.get(g.id).map(([, n]) => n), mb.get(g.id).map(([, n]) => n));
        }
      }

      if (!groupHit && !found.length) {
        const pre = (item) => new Set(item.atc.filter((c) => c.length >= 5).map((c) => c.slice(0, 5)));
        const pb = pre(b);
        const shared = [...pre(a)].filter((c) => pb.has(c)).sort(pyCompare);
        const sameKeys = ka.size === kb.size && [...ka].every((k) => kb.has(k));
        if (shared.length && !sameKeys) {
          const codes = shared.join(", ");
          result("dublowanie_atc", "niewielka", `Ta sama podgrupa terapeutyczna (ATC ${codes})`,
                 "Oba leki należą do tej samej podgrupy ATC – możliwe dublowanie terapii.",
                 "Sprawdzić, czy jednoczesne stosowanie jest zamierzone.",
                 a.substances.map(([, , n]) => n), b.substances.map(([, , n]) => n));
        }
      }
      return found;
    }
  }

  /* ---------- pacjent: wiek, ciąża, karmienie (port app/patient.py) ---------- */

  const ADULT = "dorosly";

  function ageLabel(months) {
    if (months % 12) return `poniżej ${months} miesięcy`;
    const years = months / 12;
    return years === 1 ? "poniżej 1 roku" : `poniżej ${years} lat`;
  }

  function conditionTitle(rule) {
    if (rule.warunek === "wiek") return `Wiek: ${ageLabel(rule.ponizej_mies)}`;
    return rule.warunek === "ciaza" ? "Ciąża" : "Karmienie piersią";
  }

  class PatientRules {
    constructor(raw, interactions) {
      this.status = raw.status;
      this.bands = new Map(raw.wiek_przedzialy.map((b) => [b.id, b]));
      const own = Object.entries(raw.grupy).map(([id, g]) => ({ id, name: g.nazwa, tokens: new Set(g.tokeny), atc: g.atc, within: null }));
      this.groups = [...interactions.groups, ...own];
      this.byId = new Map(this.groups.map((g) => [g.id, g]));
      this.rules = raw.reguly;
    }

    profileLabel(profile) {
      const parts = [];
      if (profile.wiek && profile.wiek !== ADULT) parts.push(this.bands.get(profile.wiek).nazwa);
      if (profile.ciaza) parts.push("ciąża");
      if (profile.karmienie) parts.push("karmienie piersią");
      return parts.join(", ");
    }

    applies(rule, profile, item) {
      if (rule.droga === "ogolna" && item.topical) return false;
      if (rule.droga === "miejscowa" && !item.topical) return false;
      if (rule.warunek === "wiek") return this.bands.get(profile.wiek || ADULT).od_mies < rule.ponizej_mies;
      return Boolean(profile[rule.warunek]);
    }

    check(items, profile) {
      if (!this.profileLabel(profile)) return [];
      const best = new Map();
      items.forEach((item, idx) => {
        const matched = matchGroups(item, this.groups);
        this.rules.forEach((rule, order) => {
          if (!matched.has(rule.grupa) || !this.applies(rule, profile, item)) return;
          const key = `${idx}|${rule.warunek}|${rule.grupa}`;
          const current = best.get(key);
          if (!current || LEVEL_ORDER[rule.poziom] < LEVEL_ORDER[current.rule.poziom]) {
            best.set(key, { idx, order, rule, item, hits: matched.get(rule.grupa) });
          }
        });
      });
      return [...best.values()]
        .sort((a, b) => LEVEL_ORDER[a.rule.poziom] - LEVEL_ORDER[b.rule.poziom] || a.idx - b.idx || a.order - b.order)
        .map(({ idx, rule, item, hits }) => ({
          warunek: rule.warunek, tytul: conditionTitle(rule), poziom: rule.poziom, pozycja: idx, lek: item.label,
          substancje: [...new Set(hits.map(([, n]) => n))].sort(pyCompare), grupa: this.byId.get(rule.grupa).name,
          opis: rule.opis, zalecenie: rule.zalecenie || "",
        }));
    }
  }

  const ALCOHOL_ITEM = () => ({ label: "Alkohol", atc: [], topical: false,
                                substances: [["alkohol", [stem("Alkohol")], "Alkohol (etanol)"]] });

  function configure(norm) {
    ignored = new Set(norm.ignorowane);
    aliases = norm.aliasy;
  }

  return { configure, simple, stem, substanceTokens, queryTokens, Store, Supplements, Interactions, PatientRules, ALCOHOL_ITEM };
})();
