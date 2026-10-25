"use strict";

const $ = (sel) => document.querySelector(sel);
const LIST_KEY = "farmacja.lista";
const LEVEL_LABELS = {
  przeciwwskazane: "Przeciwwskazane / unikać",
  istotna: "Istotna – monitorować / modyfikować",
  niewielka: "Niewielka / informacyjna",
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Błąd ${res.status}`);
  }
  return res.json();
}

function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function categoryBadges(cats) {
  return (cats || []).map((c) => `<span class="badge ${c === "OTC" ? "otc" : "rx"}">${esc(c)}</span>`).join("");
}

const FREE_LABELS = { S: "bezpłatny dla seniorów 65+", DZ: "bezpłatny dla dzieci i młodzieży do 18 lat", C: "bezpłatny dla kobiet w ciąży" };
const zl = (v) => `${v.toFixed(2).replace(".", ",")} zł`;

function refundBadges(r) {
  if (!r) return "";
  const pay = r.min_doplata != null ? `Ref. od ${zl(r.min_doplata)}` : "Ref.";
  return `<span class="badge ref" title="Lek refundowany – najniższa dopłata pacjenta (lista MZ)">${esc(pay)}</span>`
    + r.bezplatny.map((c) => `<span class="badge free" title="${esc(FREE_LABELS[c])}">${esc(c)}</span>`).join("");
}

// Ostrzeżenie dotyczące jednej pozycji (pacjent, wydanie). withDrug=false – gdy pozycja jest oczywista (karta leku).
function warnCard(w, withDrug = true) {
  const subs = w.substancje.join(", ");
  return `
    <article class="ix ${w.poziom}">
      <div class="ix-level">${esc(LEVEL_LABELS[w.poziom])} · ${esc(w.tytul)}</div>
      ${withDrug ? `<div class="ix-drugs">${esc(w.lek)} <span class="s">(${esc(subs === w.lek ? "suplement diety" : subs)})</span></div>` : ""}
      <div class="ix-title">${esc(w.grupa)}</div>
      <p>${esc(w.opis)}</p>
      ${w.zalecenie ? `<p class="advice">Zalecenie: ${esc(w.zalecenie)}</p>` : ""}
    </article>`;
}

function ixCard(w) {
  return `
    <article class="ix ${w.poziom}">
      <div class="ix-level">${esc(LEVEL_LABELS[w.poziom])}</div>
      <div class="ix-drugs">${w.leki.map((l) => {
        const subs = l.substancje.join(", ");
        const note = subs === l.nazwa ? "suplement diety" : subs;  // suplement: nazwa = składnik
        return `${esc(l.nazwa)} <span class="s">(${esc(note)})</span>`;
      }).join(" + ")}</div>
      <div class="ix-title">${esc(w.tytul)}</div>
      <p>${esc(w.opis)}</p>
      ${w.zalecenie ? `<p class="advice">Zalecenie: ${esc(w.zalecenie)}</p>` : ""}
    </article>`;
}

function dispensingSection(warnings, withDrug = true) {
  if (!warnings.length) return "";
  return `<h3 class="section-title">Przy wydaniu: pojazdy, słońce, żywność</h3>${warnings.map((w) => warnCard(w, withDrug)).join("")}`;
}

function substancesText(p) {
  return p.substancje.map((s) => `${s.nazwa}${s.moc ? " " + s.moc : ""}`).join(" + ");
}

/* ---------- zakładki ---------- */

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `panel-${name}`));
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  showTab(t.dataset.tab);
  if (t.dataset.tab === "interakcje") runCheck();
  if (t.dataset.tab === "objawy" && currentSymptom) openSymptom(currentSymptom);
}));

/* ---------- lista do sprawdzenia ---------- */

function loadList() {
  try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch { return []; }
}
let checkList = loadList();

function saveList() {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(checkList)); } catch { /* tryb prywatny */ }
  renderList();
  renderSupplements($("#supplement-q").value);  // oznaczenie „na liście”
  refreshSymptom();
}

function addToList(p) {
  if (checkList.some((x) => x.id === p.id)) { toast("Ten lek jest już na liście"); return; }
  checkList.push({ id: p.id, nazwa: p.nazwa, moc: p.moc, postac: p.postac });
  saveList();
  toast(`Dodano: ${p.nazwa}`);
}

function renderList() {
  const ul = $("#check-list");
  $("#tab-count").textContent = checkList.length || "";
  if (!checkList.length) {
    ul.innerHTML = `<li class="empty-li">Brak leków na liście.</li>`;
    return;
  }
  ul.innerHTML = checkList.map((x, i) => `
    <li>
      <span>${esc(x.nazwa)}<span class="meta">${esc([x.moc, x.postac].filter(Boolean).join(" · "))}</span></span>
      <button type="button" title="Usuń z listy" data-remove="${i}">×</button>
    </li>`).join("");
}
$("#check-list").addEventListener("click", (e) => {
  const i = e.target.dataset.remove;
  if (i === undefined) return;
  checkList.splice(Number(i), 1);
  saveList();
  if (!$("#panel-interakcje").classList.contains("hidden")) runCheck();
});
$("#clear-list").addEventListener("click", () => { checkList = []; saveList(); runCheck(); });
$("#add-alcohol").addEventListener("click", () => {
  if (checkList.some((x) => x.specjalny === "alkohol")) return;
  checkList.push({ specjalny: "alkohol", nazwa: "Alkohol", postac: "pozycja specjalna" });
  saveList();
});
$("#check-btn").addEventListener("click", () => { showTab("interakcje"); runCheck(); });

/* ---------- 1. wyszukiwanie leku ---------- */

let productResults = [];
let selectedProductId = null;

const searchProducts = debounce(async (q) => {
  if (!q.trim()) { $("#product-results").innerHTML = ""; return; }
  productResults = await api(`/api/leki?q=${encodeURIComponent(q)}`);
  renderProductResults(q);
  if (productResults.length === 1 && /^\d{8,14}$/.test(q.trim())) openProduct(productResults[0].id);
});

function productRow(p, extra = "") {
  return `
    <li class="result${p.id === selectedProductId ? " selected" : ""}" data-id="${p.id}">
      <div class="main">
        <div class="name">${esc(p.nazwa)} <span class="meta">${esc(p.moc)}</span></div>
        <div class="meta">${esc(p.postac)} · ${esc(p.podmiot)} ${categoryBadges(p.kategorie)}${refundBadges(p.refundacja)}</div>
        <div class="subs">${esc(substancesText(p))}</div>
      </div>
      ${extra}
      <button class="btn btn-small btn-ghost btn-add" type="button" data-add="${p.id}">+ do listy</button>
    </li>`;
}

function renderProductResults(q) {
  const ul = $("#product-results");
  const onlyRefunded = $("#p-refunded").checked;
  const list = onlyRefunded ? productResults.filter((p) => p.refundacja) : productResults;
  ul.innerHTML = list.length
    ? list.map((p) => productRow(p)).join("")
    : `<li class="empty">Nie znaleziono ${onlyRefunded ? "refundowanego " : ""}leku „${esc(q)}”.</li>`;
}
$("#p-refunded").addEventListener("change", () => {
  if ($("#product-q").value.trim()) renderProductResults($("#product-q").value);
});

function handleResultClick(list, e) {
  const add = e.target.closest("[data-add]");
  const row = e.target.closest("[data-id]");
  if (add) {
    const p = list.find((x) => x.id === Number(add.dataset.add));
    if (p) addToList(p);
  } else if (row) {
    showTab("lek");
    openProduct(Number(row.dataset.id));
  }
}
$("#product-results").addEventListener("click", (e) => handleResultClick(productResults, e));
$("#product-q").addEventListener("input", (e) => searchProducts(e.target.value));

async function openProduct(id) {
  selectedProductId = id;
  document.querySelectorAll("#product-results .result").forEach((r) =>
    r.classList.toggle("selected", Number(r.dataset.id) === id));
  const p = await api(`/api/leki/${id}`);
  const packages = p.opakowania.filter((o) => !o.skasowane);
  $("#product-card").innerHTML = `
    <article class="card">
      <h2>${esc(p.nazwa)}</h2>
      <p class="sub">${esc(p.moc)} · ${esc(p.postac)} ${categoryBadges(p.kategorie)}${refundBadges(p.refundacja)}</p>
      ${p.miejscowy ? `<p class="notice">Lek o działaniu miejscowym.</p>` : ""}
      ${dispensingSection(p.ostrzezenia, false)}
      <h3>Substancje czynne</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Substancja</th><th>Ilość</th><th></th></tr></thead>
        <tbody>${p.substancje.map((s) => `
          <tr><td>${esc(s.nazwa)}</td><td>${esc(s.moc)}</td>
          <td><button class="btn btn-small btn-ghost" type="button" data-eq-key="${esc(s.klucz)}">zamienniki</button></td></tr>`).join("")
          || `<tr><td colspan="3" class="empty">Brak danych o substancjach w rejestrze.</td></tr>`}
        </tbody>
      </table></div>
      <h3>Informacje</h3>
      <dl class="kv">
        <dt>Nazwa powszechna</dt><dd>${esc(p.nazwa_powszechna) || "–"}</dd>
        <dt>Podmiot odpowiedzialny</dt><dd>${esc(p.podmiot)}</dd>
        <dt>Kod ATC</dt><dd>${esc(p.atc.join(", ")) || "–"}</dd>
        <dt>Droga podania</dt><dd>${esc(p.drogi.join(", ")) || "–"}</dd>
        <dt>Nr pozwolenia</dt><dd>${esc(p.numer_pozwolenia)} (ważne: ${esc(p.waznosc_pozwolenia) || "–"})</dd>
        <dt>Dokumenty</dt><dd>
          ${p.chpl ? `<a href="${esc(p.chpl)}" target="_blank" rel="noopener">ChPL</a>` : ""}
          ${p.ulotka ? ` · <a href="${esc(p.ulotka)}" target="_blank" rel="noopener">Ulotka</a>` : ""}
        </dd>
      </dl>
      <h3>Opakowania (${packages.length})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>EAN / GTIN</th><th>Opakowanie</th><th>Kat.</th><th>Refundacja</th></tr></thead>
        <tbody>${packages.map((o) => `
          <tr><td>${esc(o.gtin)}</td><td>${esc(o.opis)}${o.import_rownolegly ? ` <span class="meta">(import równoległy: ${esc(o.import_rownolegly)})</span>` : ""}</td>
          <td>${categoryBadges([o.kategoria])}</td>
          <td>${o.refundacja ? esc([...new Set(o.refundacja.wskazania.map((w) => w.odplatnosc))].join(", ")) : "–"}</td></tr>`).join("")}
        </tbody>
      </table></div>
      ${refundSection(packages)}
      <div class="card-actions">
        <button class="btn btn-primary" type="button" id="card-add">+ Dodaj do listy</button>
        ${p.substancje.length ? `<button class="btn btn-ghost" type="button" id="card-eq">Znajdź zamienniki (ta sama moc)</button>` : ""}
      </div>
    </article>`;
  $("#card-add").addEventListener("click", () => addToList(p));
  $("#card-eq")?.addEventListener("click", () => openEquivalents(p.substancje.map((s) => s.klucz), p));
  $("#product-card").querySelectorAll("[data-eq-key]").forEach((b) =>
    b.addEventListener("click", () => openEquivalents([b.dataset.eqKey], null)));
}

function refundSection(packages) {
  const refunded = packages.filter((o) => o.refundacja);
  if (!refunded.length) return "";
  return `<h3>Refundacja (lista MZ)</h3>${refunded.map((o) => {
    const r = o.refundacja;
    const free = Object.entries(r.bezplatny).map(([c, note]) =>
      `<span class="badge free">${esc(c)}</span> ${esc(FREE_LABELS[c])}${note ? ` – ${esc(note)}` : ""}`).join("<br>");
    return `
      <div class="refund">
        <div class="refund-head"><strong>${esc(o.opis)}</strong> <span class="meta">EAN ${esc(o.gtin)}</span></div>
        <div class="meta">Cena detaliczna ${esc(r.cena)} zł · limit finansowania ${esc(r.limit)} zł · grupa limitowa ${esc(r.grupa_limitowa)}</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Zakres wskazań</th><th>Odpłatność</th><th>Dopłata pacjenta</th></tr></thead>
          <tbody>${r.wskazania.map((w) => `<tr><td>${esc(w.zakres)}</td><td>${esc(w.odplatnosc)}</td><td>${esc(w.doplata)} zł</td></tr>`).join("")}</tbody>
        </table></div>
        ${free ? `<p class="meta">${free}</p>` : ""}
      </div>`;
  }).join("")}
  <p class="hint">Kwoty z obwieszczenia MZ; dopłata zależy od wskazania na recepcie. Sprawdź w systemie aptecznym.</p>`;
}

/* ---------- objawy: dobór leku bez recepty (nie jest poradą medyczną) ---------- */

let symptomList = [], symptomQuestions = [], currentSymptom = null, symptomProducts = [];

const searchSymptoms = debounce(async (q) => {
  const data = await api(`/api/objawy?q=${encodeURIComponent(q)}`);
  symptomList = data.objawy;
  symptomQuestions = data.pytania;
  renderSymptomList(q);
});

function renderSymptomList(q) {
  const box = $("#symptom-list");
  box.classList.toggle("hidden", Boolean(currentSymptom));
  if (!symptomList.length) { box.innerHTML = `<p class="empty">Nie znaleziono objawu „${esc(q)}”.</p>`; return; }
  const cats = [...new Set(symptomList.map((s) => s.kategoria))];
  box.innerHTML = cats.map((c) => `
    <h3 class="group-title">${esc(c)}</h3>
    <div class="symptom-chips">${symptomList.filter((s) => s.kategoria === c).map((s) => `
      <button type="button" class="symptom-chip" data-symptom="${esc(s.id)}">${esc(s.nazwa)}</button>`).join("")}</div>`).join("");
}
$("#symptom-q").addEventListener("input", (e) => {
  currentSymptom = null;
  $("#symptom-card").innerHTML = "";
  searchSymptoms(e.target.value);
});
$("#symptom-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-symptom]");
  if (b) openSymptom(b.dataset.symptom);
});

const LEVEL_RANK = { przeciwwskazane: 0, istotna: 1, niewielka: 2 };

function optionStatus(o) {
  const levels = [...o.interakcje, ...o.pacjent].map((w) => w.poziom);
  if (levels.includes("przeciwwskazane")) return ["przeciwwskazane", "Przeciwwskazane / unikać – dla tego pacjenta lub z lekami z listy"];
  if (levels.includes("istotna")) return ["istotna", "Uwaga – ostrzeżenia dla tego pacjenta lub z lekami z listy"];
  if (levels.length) return ["niewielka", "Ostrzeżenia informacyjne"];
  return ["ok", "Brak ostrzeżeń w bazie aplikacji dla pacjenta i listy – sprawdź ChPL"];
}

function optionCard(o, profile) {
  const [status, label] = optionStatus(o);
  const first = o.produkty.slice(0, 4), rest = o.produkty.slice(4);
  const sorted = (xs) => [...xs].sort((a, b) => LEVEL_RANK[a.poziom] - LEVEL_RANK[b.poziom]);
  return `
    <article class="option ${status}">
      <div class="option-head"><h4>${esc(o.nazwa)}</h4><span class="pill ${status}">${esc(label)}</span></div>
      ${o.uwagi ? `<p class="option-note">${esc(o.uwagi)}</p>` : ""}
      ${o.interakcje.length ? `<div class="option-block"><div class="option-block-title">Interakcje z lekami z listy</div>${sorted(o.interakcje).map(ixCard).join("")}</div>` : ""}
      ${o.pacjent.length ? `<div class="option-block"><div class="option-block-title">Pacjent: ${esc(profile)}</div>${o.pacjent.map((w) => warnCard(w, false)).join("")}</div>` : ""}
      ${o.wydanie.length ? `<details class="option-block"><summary>Przy wydaniu: ${esc([...new Set(o.wydanie.map((w) => w.tytul))].join(", "))} (${o.wydanie.length})</summary>
        ${o.wydanie.map((w) => warnCard(w, false)).join("")}</details>` : ""}
      ${o.produkty.length ? `<ul class="results">${first.map((p) => productRow(p)).join("")}</ul>
        ${rest.length ? `<details><summary>Pokaż wszystkie leki OTC (${o.produkty.length})</summary><ul class="results">${rest.map((p) => productRow(p)).join("")}</ul></details>` : ""}`
        : `<p class="empty">Brak leków OTC z tą substancją w rejestrze.</p>`}
    </article>`;
}

async function openSymptom(id) {
  currentSymptom = id;
  renderSymptomList($("#symptom-q").value);
  let s;
  try {
    s = await api(`/api/objawy/${encodeURIComponent(id)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pozycje: requestItems(), pacjent: patient }),
    });
  } catch (err) {
    $("#symptom-card").innerHTML = `<p class="notice">Nie udało się wczytać objawu: ${esc(err.message)}</p>`;
    return;
  }
  if (currentSymptom !== id) return;  // w międzyczasie wybrano inny objaw
  symptomProducts = s.opcje.flatMap((o) => o.produkty);
  const context = [s.profil || "dorosły bez dodatkowych ustawień",
                   checkList.length ? `pozycje na liście: ${checkList.length}` : "lista leków pusta"].join(" · ");
  $("#symptom-card").innerHTML = `
    <button type="button" class="btn btn-link" id="symptom-back">← wszystkie objawy</button>
    <h2 class="symptom-title">${esc(s.nazwa)}</h2>
    <details class="questions"><summary>Najpierw zapytaj pacjenta</summary>
      <ul>${symptomQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></details>
    <div class="red-flags">
      <div class="red-flags-title">Skieruj do lekarza (nie dobieraj leku samodzielnie), jeśli:</div>
      <ul>${s.alarmowe.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
    </div>
    <p class="hint">Podpowiedzi sprawdzone dla: ${esc(context)}. Zmień ustawienia pacjenta lub dodaj leki przyjmowane na stałe, żeby uwzględnić interakcje.</p>
    <h3 class="section-title">Możliwe leki bez recepty</h3>
    ${s.opcje.map((o) => optionCard(o, s.profil)).join("")}
    ${s.porady.length ? `<h3 class="section-title">Postępowanie bez leków</h3><ul class="tips">${s.porady.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p class="medical-warning small">To nie jest porada medyczna. Dawkowanie, przeciwwskazania i ograniczenia wiekowe – zawsze według ChPL / ulotki konkretnego produktu.</p>`;
  $("#symptom-back").addEventListener("click", () => {
    currentSymptom = null;
    $("#symptom-card").innerHTML = "";
    renderSymptomList($("#symptom-q").value);
  });
}
$("#symptom-card").addEventListener("click", (e) => {
  if (e.target.closest("[data-add], [data-id]")) handleResultClick(symptomProducts, e);
});

function refreshSymptom() {
  if (currentSymptom && !$("#panel-objawy").classList.contains("hidden")) openSymptom(currentSymptom);
}

/* ---------- 2. zamienniki ---------- */

const eq = { keys: [], names: {}, products: [], reference: null, refSignature: null };

const searchSubstances = debounce(async (q) => {
  const box = $("#substance-suggestions");
  if (!q.trim()) { box.classList.add("hidden"); return; }
  const hits = await api(`/api/substancje?q=${encodeURIComponent(q)}`);
  box.innerHTML = hits.length
    ? hits.map((h, i) => `<li data-key="${esc(h.klucz)}" data-name="${esc(h.nazwa)}" class="${i === 0 ? "active" : ""}">
        <span>${esc(h.nazwa)}</span><span class="n">${h.liczba_lekow} leków</span></li>`).join("")
    : `<li class="n">Nie znaleziono substancji</li>`;
  box.classList.remove("hidden");
});
$("#substance-q").addEventListener("input", (e) => searchSubstances(e.target.value));
$("#substance-q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const first = $("#substance-suggestions li[data-key]");
  if (first) first.click();
});
$("#substance-suggestions").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  $("#substance-suggestions").classList.add("hidden");
  $("#substance-q").value = "";
  if (!eq.keys.includes(li.dataset.key)) eq.keys.push(li.dataset.key);
  eq.reference = null;
  loadEquivalents();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".substance-picker")) $("#substance-suggestions").classList.add("hidden");
});

function openEquivalents(keys, referenceProduct) {
  eq.keys = [...new Set(keys.filter(Boolean))];
  eq.reference = referenceProduct;
  showTab("zamienniki");
  loadEquivalents();
}

function signatureOf(p) {
  // Wektor mocy wybranych substancji, np. [[500, "mg"]]
  return eq.keys.map((k) => {
    const s = p.substancje.find((x) => x.klucz === k);
    return s && s.wartosc != null ? [s.wartosc, s.wymiar] : [null, null];
  });
}
const sigKey = (sig) => JSON.stringify(sig);

function distance(sig, ref) {
  let d = 0;
  for (let i = 0; i < sig.length; i++) {
    const [v, dim] = sig[i];
    const [rv, rdim] = ref[i];
    if (v == null || rv == null || dim !== rdim || v <= 0 || rv <= 0) return Infinity;
    d += Math.abs(Math.log(v / rv));
  }
  return d;
}

async function loadEquivalents() {
  renderChips();
  if (!eq.keys.length) {
    $("#eq-filters").classList.add("hidden");
    $("#eq-results").innerHTML = `<p class="empty">Wpisz substancję czynną albo otwórz kartę leku i wybierz „Znajdź zamienniki”.</p>`;
    return;
  }
  const combos = $("#f-combos").checked;
  const data = await api(`/api/zamienniki?klucze=${encodeURIComponent(eq.keys.join("|"))}&zlozone=${combos}`);
  data.substancje.forEach((s) => { eq.names[s.klucz] = s.nazwa; });
  eq.products = data.leki;
  renderChips();
  buildFilters();
  renderEquivalents();
}

function renderChips() {
  $("#substance-chips").innerHTML = eq.keys.map((k) => `
    <span class="chip">${esc(eq.names[k] || k)}<button type="button" data-chip="${esc(k)}" title="Usuń">×</button></span>`).join("");
}
$("#substance-chips").addEventListener("click", (e) => {
  const k = e.target.dataset.chip;
  if (!k) return;
  eq.keys = eq.keys.filter((x) => x !== k);
  eq.reference = null;
  loadEquivalents();
});

function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
  sel.value = options.some(([v]) => v === value) ? value : options[0]?.[0] ?? "";
}

function buildFilters() {
  $("#eq-filters").classList.remove("hidden");
  const bySig = new Map();
  for (const p of eq.products) {
    const sig = signatureOf(p);
    if (sig.some(([v]) => v == null)) continue;
    const k = sigKey(sig);
    if (!bySig.has(k)) bySig.set(k, { sig, labels: new Map(), n: 0 });
    const entry = bySig.get(k);
    entry.n++;
    const label = eq.keys.map((key) => p.substancje.find((s) => s.klucz === key)?.moc).join(" + ") || p.moc;
    entry.labels.set(label, (entry.labels.get(label) || 0) + 1);
  }
  const entries = [...bySig.entries()].sort((a, b) => {
    const [va, da] = a[1].sig[0];
    const [vb, db] = b[1].sig[0];
    return da === db ? va - vb : String(da).localeCompare(String(db));
  });
  const options = entries.map(([k, e]) => {
    const label = [...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return [k, `${label} (${e.n})`];
  });
  let wanted = $("#f-strength").value;
  if (eq.reference) {
    wanted = sigKey(signatureOf(eq.reference));
  } else if (!options.some(([k]) => k === wanted)) {
    wanted = entries.sort((a, b) => b[1].n - a[1].n)[0]?.[0];
  }
  fillSelect($("#f-strength"), [["", "— dowolna (bez sortowania) —"], ...options], wanted);

  const forms = [...new Set(eq.products.map((p) => p.postac_grupa))].sort();
  const refForm = eq.reference ? eq.reference.postac_grupa : $("#f-form").value;
  fillSelect($("#f-form"), [["", "wszystkie"], ...forms.map((f) => [f, f])], refForm);

  const routes = [...new Set(eq.products.flatMap((p) => p.drogi))].sort();
  const refRoute = eq.reference ? (eq.reference.drogi[0] || "") : $("#f-route").value;
  fillSelect($("#f-route"), [["", "wszystkie"], ...routes.map((r) => [r, r])], refRoute);
  eq.reference = null;  // dalsze zmiany filtrów należą do użytkownika
}
["#f-strength", "#f-form", "#f-route"].forEach((s) => $(s).addEventListener("change", renderEquivalents));
$("#f-refunded").addEventListener("change", () => { if (eq.keys.length) renderEquivalents(); });
$("#f-combos").addEventListener("change", loadEquivalents);

function renderEquivalents() {
  const form = $("#f-form").value;
  const route = $("#f-route").value;
  const refKey = $("#f-strength").value;
  const ref = refKey ? JSON.parse(refKey) : null;
  const onlyRefunded = $("#f-refunded").checked;
  const list = eq.products.filter((p) => (!form || p.postac_grupa === form) && (!route || p.drogi.includes(route))
    && (!onlyRefunded || p.refundacja));
  const box = $("#eq-results");
  if (!list.length) { box.innerHTML = `<p class="empty">Brak leków spełniających kryteria.</p>`; return; }

  const withDist = list.map((p) => ({ p, d: ref ? distance(signatureOf(p), ref) : 0 }));
  withDist.sort((a, b) => a.d - b.d || a.p.nazwa.localeCompare(b.p.nazwa, "pl"));
  const same = withDist.filter((x) => x.d < 1e-9);
  const other = withDist.filter((x) => x.d >= 1e-9 && Number.isFinite(x.d));
  const incomparable = withDist.filter((x) => !Number.isFinite(x.d));

  const ratio = (x) => {
    const sig = signatureOf(x.p)[0];
    if (!ref || sig[0] == null || !ref[0][0]) return "";
    return `<span class="dist">${Math.round((sig[0] / ref[0][0]) * 100)}% mocy odniesienia</span>`;
  };
  const section = (title, items, withRatio) => items.length ? `
    <h3 class="group-title">${esc(title)} <span class="count">${items.length}</span></h3>
    <ul class="results eq-list">${items.map((x) => productRow(x.p, withRatio ? ratio(x) : "")).join("")}</ul>` : "";

  box.innerHTML = ref
    ? section("Ta sama moc", same, false) + section("Inne moce (od najbliższej)", other, true)
      + section("Moc nieporównywalna / brak danych o mocy", incomparable, false)
    : section("Wszystkie leki", withDist, false);
}
$("#eq-results").addEventListener("click", (e) => handleResultClick(eq.products, e));

/* ---------- suplementy ---------- */

let supplementResults = [];
const SUPP_CATEGORIES = ["Minerały", "Witaminy", "Zioła", "Inne"];

const searchSupplements = debounce(async (q) => {
  supplementResults = await api(`/api/suplementy?q=${encodeURIComponent(q)}`);
  renderSupplements(q);
});

function renderSupplements(q) {
  const box = $("#supplement-results");
  if (!supplementResults.length) {
    box.innerHTML = `<p class="empty">Nie znaleziono składnika „${esc(q)}”. Sprawdź, czy nie jest zarejestrowany jako lek.</p>`;
    return;
  }
  const onList = new Set(checkList.filter((x) => x.suplement).map((x) => x.suplement));
  const card = (s) => `
    <li class="result${onList.has(s.id) ? " on-list" : ""}">
      <div class="main"><div class="name">${esc(s.nazwa)}</div></div>
      <button class="btn btn-small btn-ghost btn-add" type="button" data-supp="${esc(s.id)}"
        ${onList.has(s.id) ? "disabled" : ""}>${onList.has(s.id) ? "na liście" : "+ do listy"}</button>
    </li>`;
  const sections = [];
  if (!q.trim()) {
    const popular = supplementResults.filter((s) => s.popularny);
    if (popular.length) sections.push(["Najczęściej stosowane", popular]);
  }
  for (const cat of SUPP_CATEGORIES) {
    const items = supplementResults.filter((s) => s.kategoria === cat && (q.trim() || !s.popularny));
    if (items.length) sections.push([cat, items]);
  }
  box.innerHTML = sections.map(([title, items]) => `
    <h3 class="group-title">${esc(title)} <span class="count">${items.length}</span></h3>
    <ul class="results supp-grid">${items.map(card).join("")}</ul>`).join("");
}

$("#supplement-q").addEventListener("input", (e) => searchSupplements(e.target.value));
$("#supplement-results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-supp]");
  if (!b) return;
  const s = supplementResults.find((x) => x.id === b.dataset.supp);
  if (!s || checkList.some((x) => x.suplement === s.id)) return;
  checkList.push({ suplement: s.id, nazwa: s.nazwa, postac: "suplement diety" });
  saveList();
  toast(`Dodano: ${s.nazwa}`);
  renderSupplements($("#supplement-q").value);
});

/* ---------- 3. interakcje ---------- */

/* ---------- pacjent (wiek, ciąża, karmienie) ---------- */

const PATIENT_KEY = "farmacja.pacjent";
const ADULT = { wiek: "dorosly", ciaza: false, karmienie: false };

function loadPatient() {
  try { return { ...ADULT, ...JSON.parse(localStorage.getItem(PATIENT_KEY)) }; } catch { return { ...ADULT }; }
}
let patient = loadPatient();
const patientActive = () => patient.wiek !== "dorosly" || patient.ciaza || patient.karmienie;

function savePatient() {
  try { localStorage.setItem(PATIENT_KEY, JSON.stringify(patient)); } catch { /* tryb prywatny */ }
  renderPatient();
  if (!$("#panel-interakcje").classList.contains("hidden")) runCheck();
  refreshSymptom();
}

function renderPatient() {
  $("#p-age").value = patient.wiek;
  $("#p-pregnant").checked = patient.ciaza;
  $("#p-breastfeeding").checked = patient.karmienie;
  $(".patient").classList.toggle("active", patientActive());
}

async function initPatient() {
  const opts = await api("/api/pacjent");
  $("#p-age").innerHTML = opts.przedzialy_wieku.map((b) => `<option value="${esc(b.id)}">${esc(b.nazwa)}</option>`).join("");
  if (!opts.przedzialy_wieku.some((b) => b.id === patient.wiek)) patient = { ...ADULT };
  renderPatient();
}
$("#p-age").addEventListener("change", (e) => { patient.wiek = e.target.value; savePatient(); });
$("#p-pregnant").addEventListener("change", (e) => { patient.ciaza = e.target.checked; savePatient(); });
$("#p-breastfeeding").addEventListener("change", (e) => { patient.karmienie = e.target.checked; savePatient(); });
// Wyczyszczenie listy = nowy pacjent: dane pacjenta też wracają do ustawień domyślnych.
$("#clear-list").addEventListener("click", () => { patient = { ...ADULT }; savePatient(); });

function patientSection(warnings, label) {
  if (!patientActive()) return "";
  const body = warnings.map((w) => warnCard(w)).join("");
  return `<h3 class="section-title">Ostrzeżenia dla pacjenta: ${esc(label)}</h3>
    ${body || `<div class="ok-box">Brak ostrzeżeń w bazie aplikacji dla tego pacjenta. Sprawdź ChPL (dawkowanie i postać dla wieku).</div>`}`;
}

function requestItems() {
  return checkList.map((x) => (
    x.specjalny ? { specjalny: x.specjalny } : x.suplement ? { suplement: x.suplement } : { id: x.id }));
}

async function runCheck() {
  const box = $("#interaction-results");
  if (!checkList.length) {
    box.innerHTML = `<p class="empty">Dodaj leki do listy (przycisk „+ do listy”), a następnie kliknij „Sprawdź interakcje i ostrzeżenia”.
      Interakcje sprawdzają się od dwóch pozycji; ostrzeżenia dla pacjenta i przy wydaniu (pojazdy, słońce, żywność) – już dla jednej.</p>`;
    return;
  }
  box.innerHTML = `<p class="empty">Sprawdzanie…</p>`;
  let data;
  try {
    data = await api("/api/interakcje", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pozycje: requestItems(), pacjent: patient }),
    });
  } catch (err) {
    box.innerHTML = `<p class="notice">Nie udało się sprawdzić interakcji: ${esc(err.message)}</p>`;
    return;
  }
  const counts = { przeciwwskazane: 0, istotna: 0, niewielka: 0 };
  [...data.wyniki, ...data.pacjent].forEach((w) => { counts[w.poziom]++; });
  const summary = Object.entries(counts).filter(([, n]) => n)
    .map(([lvl, n]) => `<span class="pill ${lvl}">${esc(LEVEL_LABELS[lvl])}: ${n}</span>`).join("");
  const notes = data.uwagi.map((u) => `<p class="notice">${esc(u)}</p>`).join("");
  const results = data.wyniki.map(ixCard).join("");
  const interactionsBlock = checkList.length < 2 ? "" : `
    <h3 class="section-title">Interakcje</h3>
    ${notes}
    ${results || `<div class="ok-box">Brak znanych interakcji w bazie aplikacji dla ${checkList.length} pozycji. Sprawdź ChPL.</div>`}`;
  box.innerHTML = `
    ${summary ? `<div class="summary-bar">${summary}</div>` : ""}
    ${patientSection(data.pacjent, data.profil)}
    ${interactionsBlock}
    ${dispensingSection(data.wydanie)}
    <p class="hint" style="margin-top:14px">Baza interakcji: ${esc(data.baza.liczba_regul)} reguł, ${esc(data.baza.liczba_grup)} grup (wersja ${esc(data.baza.wersja)}). ${esc(data.baza.status)}</p>`;
}

/* ---------- status i aktualizacja bazy ---------- */

async function refreshStatus() {
  const s = await api("/api/status");
  const el = $("#data-status");
  if (!s.zaladowano) {
    el.textContent = "Brak bazy leków – kliknij „Aktualizuj bazę leków”.";
  } else {
    el.textContent = `Rejestr Produktów Leczniczych – stan na ${s.stan_na_dzien} · ${s.liczba_produktow} leków · import ${s.zaimportowano.replace("T", " ")}`;
    const refundDate = (s.refundacja.obwieszczenie.match(/na (\d+ \S+ \d{4})/) || [])[1];
    el.textContent += refundDate ? ` · lista refundacyjna na ${refundDate}` : " · brak listy refundacyjnej";
  }
  const btn = $("#update-btn");
  if (s.aktualizacja.trwa) {
    btn.disabled = true;
    btn.textContent = s.aktualizacja.etap || "Aktualizacja…";
    setTimeout(refreshStatus, 2000);
  } else {
    btn.disabled = false;
    btn.textContent = "Aktualizuj bazę leków";
    if (s.aktualizacja.blad) el.textContent += ` · Błąd aktualizacji: ${s.aktualizacja.blad}`;
  }
  return s;
}
$("#update-btn").addEventListener("click", async () => {
  await api("/api/aktualizacja", { method: "POST" });
  refreshStatus();
});

/* ---------- sygnał życia: serwer zamyka się sam po zamknięciu wszystkich kart ---------- */

async function heartbeat() {
  try {
    await fetch("/api/zycie", { method: "POST" });
    $("#server-gone")?.remove();
  } catch {
    if (!$("#server-gone")) {
      document.body.insertAdjacentHTML("afterbegin",
        `<div id="server-gone" class="disclaimer">Aplikacja została zamknięta. Uruchom ją ponownie skrótem „Pomocnik farmaceuty”.</div>`);
    }
  }
}
heartbeat();
setInterval(heartbeat, 5000);
window.addEventListener("pagehide", () => navigator.sendBeacon("/api/zamykanie"));

renderList();
initPatient();
searchSymptoms("");
loadEquivalents();
searchSupplements("");
refreshStatus();
