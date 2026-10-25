"""Sprawdza, czy silnik JavaScript (pwa/src/engine.js) daje te same wyniki co Python.

    python -m pwa.build && python -m pwa.test_parity

Uruchamia lokalny serwer z pwa/dist i przeglądarkę Edge/Chrome w trybie headless.
"""
import functools
import html
import http.server
import json
import random
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from app import importer
from app.dispensing import DispensingRules
from app.interactions import ALCOHOL_ITEM, CheckItem, InteractionDB
from app.patient import PatientRules
from app.store import Store
from app.supplements import SupplementDB
from app.symptoms import SymptomDB
from pwa.build import DIST_DIR

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google-chrome", "chromium",
]

PRODUCT_QUERIES = ["apap", "ketonal", "nurofen forte", "zolpidem", "warfin", "ibuprofen", "polocard", "xarelto",
                   "euthyrox", "amlodipina", "metformax", "5909991023652", "05909990296026", "ketonl", "aspiryna"]
SUBSTANCE_QUERIES = ["paracetamol", "amlodypina", "ibupro", "kwas acetylosalicylowy", "dziurawiec", "lewotyroksyna",
                     "klopidogrel", "warfaryna", "lit", "metformina", "perindopryl", "parcetamol", "wit"]
EQ_KEYS = [["paracetamol"], ["amlodipin"], ["ibuprofen"], ["perindopril", "amlodipin"]]
SUPP_QUERIES = ["", "magn", "d3", "omega", "ryż", "miłorząb", "kurkum", "wit k", "psyllium"]
SYMPTOM_QUERIES = ["", "ból", "glowy", "kaszel", "rozwolnienie", "alergia", "pęcherz", "grzybica stóp", "xyz"]

JS_RUNNER = """<!doctype html><meta charset="utf-8"><script src="engine.js"></script><pre id="out"></pre>
<script>
(async () => {
  const get = (p) => fetch(p).then((r) => r.json());
  const cases = await get("parity-cases.json");
  Engine.configure(await get("data/normalizacja.json"));
  const raw = await get("data/leki.json");
  const store = new Engine.Store(raw);
  store.gtin = await get("data/ean.json");
  const inter = new Engine.Interactions(await get("data/interakcje.json"));
  const supp = new Engine.Supplements(await get("data/suplementy.json"));
  const patient = new Engine.PatientRules(await get("data/pacjent.json"), inter);
  const disp = new Engine.DispensingRules(await get("data/ostrzezenia.json"), patient);
  const symptoms = new Engine.Symptoms(await get("data/objawy.json"));
  const item = (x) => x.alkohol ? Engine.ALCOHOL_ITEM() : x.suplement ? supp.checkItem(x.suplement)
                    : store.checkItem(store.products.get(x.id));
  const out = {
    tokens: raw.substancje.map(([, name]) => Engine.substanceTokens(name).join(" ")),
    products: cases.products.map((q) => store.searchProducts(q).slice(0, 10).map((p) => p.id)),
    substances: cases.substances.map((q) => store.searchSubstances(q).map((s) => s.klucz)),
    equivalents: cases.equivalents.map(([keys, combos]) => store.equivalents(keys, combos).map((p) => p.id)),
    supplements: cases.supplements.map((q) => supp.search(q).map((s) => s.id)),
    interactions: cases.interactions.map((items) => inter.check(items.map(item))),
    patient: cases.patient.map(([items, profile]) => patient.check(items.map(item), profile)),
    dispensing: cases.dispensing.map((items) => disp.check(items.map(item))),
    symptom_search: cases.symptom_search.map((q) => symptoms.search(q).map((s) => s.id)),
    symptom_products: symptoms.items.flatMap((s) => s.opcje.map((o) => symptoms.products(store, o).map((p) => p.id))),
    symptom_warnings: symptoms.items.flatMap((s) => s.opcje.map((o) => disp.check([symptoms.optionItem(o)]))),
  };
  document.getElementById("out").textContent = JSON.stringify(out);
})().catch((e) => { document.getElementById("out").textContent = "BLAD " + e.stack; });
</script>"""


def _normalize_check(res: dict) -> dict:
    # Kolejność wyników o tym samym poziomie dla jednej pary nie jest istotna.
    rows = sorted(json.dumps(r, ensure_ascii=False, sort_keys=True) for r in res["wyniki"])
    return {"wyniki": rows, "uwagi": res["uwagi"]}


def _browser() -> str:
    for b in BROWSERS:
        if Path(b).exists() or shutil.which(b):
            return b
    sys.exit("Nie znaleziono przeglądarki Edge/Chrome")


def main() -> int:
    store = Store(importer.DB_PATH)
    inter = InteractionDB(importer.DATA_DIR / "interakcje.json")
    supp = SupplementDB(importer.DATA_DIR / "suplementy.json")
    patient = PatientRules(importer.DATA_DIR / "pacjent.json", inter)
    disp = DispensingRules(importer.DATA_DIR / "ostrzezenia.json", patient)
    symptoms = SymptomDB(importer.DATA_DIR / "objawy.json")

    rng = random.Random(42)
    systemic = [p for p in store.products.values() if p.substances]
    pool = [p for p in systemic if any(inter.match_groups(
        CheckItem(p.name, [(s.key, s.tokens, s.name) for s in p.substances], p.atc)))]
    combos = []
    for _ in range(400):
        items = [{"id": p.id} for p in rng.sample(pool, rng.randint(2, 4))]
        if rng.random() < 0.4:
            items.append({"suplement": rng.choice(list(supp.items))})
        if rng.random() < 0.1:
            items.append({"alkohol": True})
        combos.append(items)

    # Dla ostrzeżeń pacjenta: pule z lekami miejscowymi i grupami z pacjent.json.
    patient_pool = [p for p in systemic if any(patient.groups[r["grupa"]].tokens & set(t for s in p.substances for t in s.tokens)
                                               for r in patient.rules)]
    patient_cases = []
    for _ in range(300):
        items = [{"id": p.id} for p in rng.sample(patient_pool, rng.randint(1, 4))]
        if rng.random() < 0.5:
            items.append({"suplement": rng.choice(list(supp.items))})
        profile = {"wiek": rng.choice(list(patient.bands)), "ciaza": rng.random() < 0.3, "karmienie": rng.random() < 0.3}
        patient_cases.append([items, profile])

    # Ostrzeżenia przy wydaniu: leki z grup reguł, także miejscowe.
    disp_pool = [p for p in store.products.values() if p.substances and any(
        disp.groups[r["grupa"]].tokens & set(t for s in p.substances for t in s.tokens) for r in disp.rules)]
    dispensing_cases = [[{"id": p.id} for p in rng.sample(disp_pool, rng.randint(1, 4))] for _ in range(300)]

    def py_item(x):
        if x.get("alkohol"):
            return ALCOHOL_ITEM
        if x.get("suplement"):
            return supp.check_item(x["suplement"])
        p = store.products[x["id"]]
        return CheckItem(f"{p.name} {p.strength}".strip(), [(s.key, s.tokens, s.name) for s in p.substances],
                         p.atc, p.topical)

    raw = json.loads((DIST_DIR / "data" / "leki.json").read_text(encoding="utf-8"))
    from app.normalize import substance_tokens
    expected = {
        "tokens": [" ".join(substance_tokens(name)) for _, name, _ in raw["substancje"]],
        "products": [[p.id for p in store.search_products(q)[:10]] for q in PRODUCT_QUERIES],
        "substances": [[s["klucz"] for s in store.search_substances(q)] for q in SUBSTANCE_QUERIES],
        "equivalents": [[p.id for p in store.equivalents(k, c)] for k in EQ_KEYS for c in (False, True)],
        "supplements": [[s["id"] for s in supp.search(q)] for q in SUPP_QUERIES],
        "interactions": [_normalize_check(inter.check([py_item(x) for x in items])) for items in combos],
        "patient": [patient.check([py_item(x) for x in items], profile) for items, profile in patient_cases],
        "dispensing": [disp.check([py_item(x) for x in items]) for items in dispensing_cases],
        "symptom_search": [[s["id"] for s in symptoms.search(q)] for q in SYMPTOM_QUERIES],
        "symptom_products": [[p.id for p in symptoms.products(store, o)] for s in symptoms.items.values() for o in s["opcje"]],
        "symptom_warnings": [disp.check([symptoms.option_item(o)]) for s in symptoms.items.values() for o in s["opcje"]],
    }
    cases = {"products": PRODUCT_QUERIES, "substances": SUBSTANCE_QUERIES,
             "equivalents": [[k, c] for k in EQ_KEYS for c in (False, True)],
             "supplements": SUPP_QUERIES, "interactions": combos, "patient": patient_cases,
             "dispensing": dispensing_cases, "symptom_search": SYMPTOM_QUERIES}

    (DIST_DIR / "parity-cases.json").write_text(json.dumps(cases), encoding="utf-8")
    (DIST_DIR / "parity.html").write_text(JS_RUNNER, encoding="utf-8")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST_DIR))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        dom = subprocess.run([_browser(), "--headless=new", "--disable-gpu", "--virtual-time-budget=60000",
                              "--dump-dom", f"http://127.0.0.1:{server.server_port}/parity.html"],
                             capture_output=True, timeout=180).stdout.decode("utf-8")
    finally:
        server.shutdown()
        (DIST_DIR / "parity-cases.json").unlink()
        (DIST_DIR / "parity.html").unlink()

    text = html.unescape(dom.split('<pre id="out">', 1)[1].split("</pre>", 1)[0])
    if not text.startswith("{"):
        print("Błąd po stronie JS:", text[:2000])
        return 1
    got = json.loads(text)
    got["interactions"] = [_normalize_check(r) for r in got["interactions"]]

    failures = 0
    for section, exp in expected.items():
        bad = [i for i, (e, g) in enumerate(zip(exp, got[section])) if e != g]
        status = "OK" if not bad and len(exp) == len(got[section]) else f"{len(bad)} różnic"
        print(f"{section:13} {len(exp):6} przypadków: {status}")
        for i in bad[:3]:
            print("   przypadek", i, "\n   Python:", str(exp[i])[:400], "\n   JS:    ", str(got[section][i])[:400])
        failures += len(bad)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
