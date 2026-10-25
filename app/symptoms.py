"""Dobór leku bez recepty do objawu (data/objawy.json) – pomoc w rozmowie z pacjentem, nie porada medyczna.

Każda opcja wskazuje substancję (jednoskładnikowe leki OTC z rejestru) lub prefiks ATC (także preparaty
złożone). Podpowiedź można sprawdzić jak zwykłą pozycję listy: interakcje, ostrzeżenia dla pacjenta i przy wydaniu.
"""
import json
from pathlib import Path

from .interactions import CheckItem
from .normalize import simple, stem, substance_tokens
from .patient import ROUTES

OTC = "OTC"


def option_tokens(sid: str, names: list[str]) -> list[str]:
    out = []
    for name in names:
        tokens = substance_tokens(name)
        if len(tokens) != 1:
            raise ValueError(f"Objaw {sid}: '{name}' musi wskazywać jedno słowo identyfikujące substancję")
        out.append(tokens[0])
    return out


class SymptomDB:
    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.status = data.get("status", "")
        self.questions = data.get("pytania", [])
        self.items: dict[str, dict] = {}
        self._search: dict[str, tuple[str, set]] = {}
        for s in data["objawy"]:
            if s["id"] in self.items:
                raise ValueError(f"Objawy: zduplikowane id '{s['id']}'")
            for opt in s["opcje"]:
                if not opt.get("substancje") and not opt.get("atc"):
                    raise ValueError(f"Objaw {s['id']}: opcja '{opt.get('nazwa')}' bez substancji i ATC")
                if opt.get("droga") not in ROUTES:
                    raise ValueError(f"Objaw {s['id']}: nieznana droga {opt.get('droga')}")
                if not all(isinstance(m, str) and m == m.lower() for m in opt.get("drogi", [])):
                    raise ValueError(f"Objaw {s['id']}: 'drogi' to lista fragmentów nazw dróg podania (małe litery)")
                opt["_tokeny"] = option_tokens(s["id"], opt.get("substancje", []))
            self.items[s["id"]] = s
            words = simple(" ".join([s["nazwa"], s["kategoria"], *s.get("szukaj", [])]))
            self._search[s["id"]] = (words, {stem(w) for w in words.split()})

    def summary(self, s: dict) -> dict:
        return {"id": s["id"], "nazwa": s["nazwa"], "kategoria": s["kategoria"]}

    def search(self, query: str) -> list[dict]:
        q = simple(query)
        if not q:
            return [self.summary(s) for s in self.items.values()]
        q_words = q.split()
        hits = []
        for sid, (words, stems) in self._search.items():
            word_list = words.split()
            if all(any(w.startswith(qw) for w in word_list) or stem(qw) in stems for qw in q_words):
                hits.append(sid)
        return [self.summary(self.items[sid]) for sid in hits]

    @staticmethod
    def option_item(opt: dict) -> CheckItem:
        """Podpowiedź jako pozycja listy (bez konkretnego produktu) – do sprawdzenia ostrzeżeń."""
        substances = [(tok, [tok], name) for tok, name in zip(opt["_tokeny"], opt.get("substancje", []))]
        return CheckItem(label=opt["nazwa"], substances=substances, atc=list(opt.get("atc", [])),
                         topical=opt.get("droga") == "miejscowa")

    @staticmethod
    def matches(opt: dict, product) -> bool:
        if not product.active or OTC not in product.categories:
            return False
        if (opt.get("droga") == "ogolna" and product.topical) or (opt.get("droga") == "miejscowa" and not product.topical):
            return False
        if opt.get("drogi") and not any(m in r.lower() for r in product.routes for m in opt["drogi"]):
            return False
        tokens = set(opt["_tokeny"])
        if tokens and len(product.substances) == 1 and tokens.intersection(product.substances[0].tokens):
            return True
        return any(code.startswith(tuple(opt.get("atc", ()))) for code in product.atc) if opt.get("atc") else False

    def products(self, store, opt: dict) -> list:
        found = [p for p in store.products.values() if self.matches(opt, p)]
        return sorted(found, key=lambda p: (p.name.lower(), p.strength, p.form, p.id))
