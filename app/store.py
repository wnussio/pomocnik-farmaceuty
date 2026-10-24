"""Baza leków w pamięci: wczytanie z SQLite, wyszukiwanie leków i substancji, zamienniki."""
import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from .normalize import query_tokens, simple, substance_key, substance_tokens

MASS_UNITS = {"mg": 1.0, "g": 1000.0, "mcg": 0.001, "µg": 0.001, "ug": 0.001, "ng": 1e-6, "kg": 1e6}
UNIT_ALIASES = {"j.m.": "j.m.", "jm": "j.m.", "iu": "j.m.", "j.": "j.m.", "j": "j.m.", "u": "j.m."}

# Drogi podania o działaniu miejscowym - takie leki pomijamy w analizie interakcji ogólnoustrojowych.
TOPICAL_ROUTE_MARKERS = ("na skór", "podanie na skór", "do oka", "do ucha", "donosow", "do nosa",
                         "śluzówk", "dziąs", "dopochwow", "ciałka szklistego", "do pęcherza")

FORM_GROUPS = [
    ("tabletki", "Tabletki"), ("kapsułki", "Kapsułki"), ("drażetki", "Tabletki"),
    ("syrop", "Syrop"), ("zawiesina doustna", "Zawiesina doustna"),
    ("krople doustne", "Krople / roztwór doustny"), ("roztwór doustny", "Krople / roztwór doustny"),
    ("granulat", "Granulat / proszek doustny"), ("proszek do sporządzania roztworu doustnego", "Granulat / proszek doustny"),
    ("proszek do sporządzania zawiesiny doustnej", "Granulat / proszek doustny"), ("saszetk", "Granulat / proszek doustny"),
    ("czopki", "Czopki"), ("wstrzykiwań", "Iniekcje / infuzje"), ("infuzji", "Iniekcje / infuzje"),
    ("krople do oczu", "Do oczu"), ("do oczu", "Do oczu"), ("do nosa", "Do nosa"), ("do ucha", "Do ucha"),
    ("inhalac", "Wziewne"), ("wziewn", "Wziewne"), ("plaster", "Plastry"), ("system transdermalny", "Plastry"),
    ("krem", "Krem / maść / żel"), ("maść", "Krem / maść / żel"), ("żel", "Krem / maść / żel"),
    ("pastylki", "Pastylki / do ssania"), ("do ssania", "Pastylki / do ssania"),
]


def _num(text: str):
    try:
        return float(str(text).replace(",", ".").replace(" ", ""))
    except ValueError:
        return None


def strength_value(amount: str, unit: str, prep_amount: str = "", prep_unit: str = ""):
    """Zamienia ilość substancji na (wartość, wymiar), np. ("4", "mg", "5", "ml") -> (0.8, "mg/ml")."""
    value = _num(amount)
    if value is None or not unit:
        return None
    numerator, _, denominator = unit.strip().lower().partition("/")
    numerator = numerator.strip()
    if numerator in MASS_UNITS:
        value, dim = value * MASS_UNITS[numerator], "mg"
    elif numerator == "%":
        return round(value, 6), "%"
    else:
        dim = UNIT_ALIASES.get(numerator, numerator)
    if not denominator and prep_amount and prep_unit:
        denominator = f"{prep_amount} {prep_unit}"
    if denominator:
        m = re.match(r"\s*([\d.,]*)\s*(.*)", denominator)
        den_value, den_unit = _num(m.group(1)) or 1.0, m.group(2).strip().lower()
        if den_unit == "l":
            den_value, den_unit = den_value * 1000, "ml"
        if den_unit.startswith("dawk"):
            den_unit = "dawka"
        value /= den_value
        dim = f"{dim}/{den_unit}"
    return round(value, 6), dim


_STRENGTH_RE = re.compile(r"([\d][\d\s.,]*)\s*([a-zA-Zµ%.]+(?:\s*/\s*[\d.,]*\s*[a-zA-Ząćęłńóśźż.]+)?)")


def _strengths_from_text(text: str) -> list:
    """Awaryjnie: moce z pola "moc" produktu, np. "5 mg + 10 mg"."""
    out = []
    for part in (text or "").split("+"):
        m = _STRENGTH_RE.search(part)
        out.append(strength_value(m.group(1), m.group(2)) if m else None)
    return out


def form_group(form: str) -> str:
    low = (form or "").lower()
    for marker, label in FORM_GROUPS:
        if marker in low:
            return label
    return (form or "Inna").split(",")[0].split(" ")[0].capitalize() or "Inna"


@dataclass
class Substance:
    key: str
    tokens: list
    name: str
    text: str           # moc do wyświetlenia
    value: float | None
    dim: str | None


@dataclass
class Product:
    id: int
    name: str
    common_name: str
    strength: str
    form: str
    holder: str
    permit_no: str
    permit_validity: str
    leaflet_url: str
    spc_url: str
    atc: list
    routes: list
    substances: list
    packages: list
    form_group: str = ""
    search_name: str = ""
    categories: list = field(default_factory=list)
    active: bool = True
    topical: bool = False

    @property
    def keys(self) -> frozenset:
        return frozenset(s.key for s in self.substances)

    def summary(self) -> dict:
        return {
            "id": self.id, "nazwa": self.name, "moc": self.strength, "postac": self.form,
            "postac_grupa": self.form_group, "podmiot": self.holder, "kategorie": self.categories,
            "aktywny": self.active, "miejscowy": self.topical, "atc": self.atc, "drogi": self.routes,
            "substancje": [{"klucz": s.key, "nazwa": s.name, "moc": s.text, "wartosc": s.value,
                            "wymiar": s.dim} for s in self.substances],
        }

    def details(self) -> dict:
        return self.summary() | {
            "nazwa_powszechna": self.common_name, "numer_pozwolenia": self.permit_no,
            "waznosc_pozwolenia": self.permit_validity, "ulotka": self.leaflet_url, "chpl": self.spc_url,
            "opakowania": [{"gtin": p["gtin"], "kategoria": p["category"], "opis": p["description"],
                            "skasowane": p["deleted"], "import_rownolegly": p["parallel"]}
                           for p in self.packages],
        }


def _build_substances(raw: list, product_strength: str) -> list:
    fallback = _strengths_from_text(product_strength)
    out = []
    for i, s in enumerate(raw):
        sv = strength_value(s["amount"], s["unit"], s["prep_amount"], s["prep_unit"])
        if sv is None and len(fallback) == len(raw):
            sv = fallback[i]
        if s["amount"]:
            text = f"{s['amount']} {s['unit']}".strip()
            if s["prep_amount"]:
                text += f"/{s['prep_amount']} {s['prep_unit']}".rstrip()
        else:
            text = s["other"] or (product_strength if len(raw) == 1 else "")
        out.append(Substance(key=substance_key(s["name"]), tokens=substance_tokens(s["name"]),
                             name=s["name"], text=text, value=sv[0] if sv else None,
                             dim=sv[1] if sv else None))
    return out


def _trigrams(text: str) -> set:
    t = f"  {text} "
    return {t[i:i + 3] for i in range(len(t) - 2)}


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.products: dict[int, Product] = {}
        self.meta: dict[str, str] = {}
        self.by_gtin: dict[str, int] = {}
        self.by_key: dict[str, list[int]] = defaultdict(list)
        self.key_names: dict[str, str] = {}
        self.key_counts: Counter = Counter()
        self._name_trigrams: dict[str, set] = defaultdict(set)
        self._names: dict[str, list[int]] = defaultdict(list)
        self._key_trigrams: dict[str, set] = defaultdict(set)
        if db_path.exists():
            self._load()

    @property
    def loaded(self) -> bool:
        return bool(self.products)

    def _load(self) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        self.meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        name_variants: dict[str, Counter] = defaultdict(Counter)
        for row in conn.execute("SELECT * FROM products"):
            packages = json.loads(row["packages"])
            routes = [r for r in row["routes"].split("|") if r]
            p = Product(
                id=row["id"], name=row["name"], common_name=row["common_name"], strength=row["strength"],
                form=row["form"], holder=row["holder"], permit_no=row["permit_no"],
                permit_validity=row["permit_validity"], leaflet_url=row["leaflet_url"], spc_url=row["spc_url"],
                atc=[a for a in row["atc"].split(",") if a], routes=routes,
                substances=_build_substances(json.loads(row["substances"]), row["strength"]),
                packages=packages,
            )
            p.form_group = form_group(p.form)
            p.search_name = simple(p.name)
            live = [pk for pk in packages if not pk["deleted"]]
            p.active = bool(live) or not packages
            p.categories = sorted({pk["category"] for pk in (live or packages) if pk["category"]})
            p.topical = bool(routes) and all(
                any(m in r.lower() for m in TOPICAL_ROUTE_MARKERS) and "przezskór" not in r.lower()
                for r in routes)
            self.products[p.id] = p
            for pk in packages:
                if pk["gtin"]:
                    self.by_gtin[pk["gtin"].lstrip("0")] = p.id
            for s in p.substances:
                if s.key:
                    self.by_key[s.key].append(p.id)
                    name_variants[s.key][s.name] += 1
            self._names[p.search_name].append(p.id)
        conn.close()
        for key, variants in name_variants.items():
            single_word = [n for n, _ in variants.most_common() if len(n.split()) == 1]
            self.key_names[key] = single_word[0] if single_word else variants.most_common(1)[0][0]
            self.key_counts[key] = len(set(self.by_key[key]))
            for tri in _trigrams(key):
                self._key_trigrams[tri].add(key)
        for name in self._names:
            for tri in _trigrams(name):
                self._name_trigrams[tri].add(name)

    # --- wyszukiwanie leków -------------------------------------------------------------

    def search_products(self, query: str, limit: int = 40) -> list[Product]:
        digits = re.sub(r"\D", "", query)
        if len(digits) >= 8 and len(digits) >= len(query.strip()) - 1:
            pid = self.by_gtin.get(digits.lstrip("0"))
            return [self.products[pid]] if pid else []
        q = simple(query)
        if not q:
            return []
        q_words = q.split()
        scored: dict[str, float] = {}
        for name in self._names:
            if name.startswith(q):
                scored[name] = 3 - len(name) / 1000
            elif all(any(w.startswith(qw) for w in name.split()) for qw in q_words):
                scored[name] = 2 - len(name) / 1000
            elif q in name:
                scored[name] = 1.5
        if len(scored) < 5:
            for name, sim in self._fuzzy(q, self._name_trigrams, 15):
                scored.setdefault(name, sim)
        ranked = sorted(scored, key=lambda n: (-scored[n], n))
        results = []
        for name in ranked:
            results.extend(sorted((self.products[i] for i in self._names[name]),
                                  key=lambda p: (not p.active, p.strength, p.form)))
            if len(results) >= limit:
                break
        return results[:limit]

    @staticmethod
    def _fuzzy(q: str, index: dict, limit: int, threshold: float = 0.35):
        q_tri = _trigrams(q)
        counts: Counter = Counter()
        for tri in q_tri:
            for cand in index.get(tri, ()):
                counts[cand] += 1
        out = []
        for cand, common in counts.most_common(400):
            sim = 2 * common / (len(q_tri) + len(_trigrams(cand)))
            if sim >= threshold:
                out.append((cand, sim))
        return sorted(out, key=lambda x: -x[1])[:limit]

    # --- substancje i zamienniki --------------------------------------------------------

    def search_substances(self, query: str, limit: int = 20) -> list[dict]:
        q_tokens = query_tokens(query)
        if not q_tokens:
            return []
        hits = [k for k in self.key_names
                if all(any(t.startswith(qt) for t in k.split()) for qt in q_tokens)]
        if not hits:
            hits = [k for k, _ in self._fuzzy(" ".join(q_tokens), self._key_trigrams, limit, 0.4)]
        exact = " ".join(q_tokens)
        hits.sort(key=lambda k: (k != exact, len(k.split()), -self.key_counts[k]))
        return [{"klucz": k, "nazwa": self.key_names[k], "liczba_lekow": self.key_counts[k]}
                for k in hits[:limit]]

    def equivalents(self, keys: list[str], include_combinations: bool) -> list[Product]:
        wanted = frozenset(keys)
        if not wanted:
            return []
        candidate_ids = set.intersection(*(set(self.by_key.get(k, [])) for k in wanted))
        out = []
        for pid in candidate_ids:
            p = self.products[pid]
            if p.keys == wanted or (include_combinations and wanted < p.keys):
                out.append(p)
        return sorted(out, key=lambda p: (p.name.lower(), p.strength, p.id))

    def substance_name(self, key: str) -> str:
        return self.key_names.get(key, key)

