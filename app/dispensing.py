"""Ostrzeżenia przy wydaniu leku (data/ostrzezenia.json): prowadzenie pojazdów, fotouczulenie, żywność.

Dotyczą pojedynczych pozycji listy (jak ostrzeżenia dla pacjenta), niezależnie od profilu pacjenta.
"""
import json
from pathlib import Path

from .interactions import LEVEL_ORDER, CheckItem, match_groups, parse_group
from .patient import ROUTES, PatientRules


class DispensingRules:
    def __init__(self, path: Path, patient: PatientRules):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.status = data.get("status", "")
        self.kinds = data["rodzaje"]
        own = {gid: parse_group(gid, g) for gid, g in data.get("grupy", {}).items()}
        clash = own.keys() & patient.groups.keys()
        if clash:
            raise ValueError(f"ostrzezenia.json: grupy o nazwach zajętych w interakcje.json / pacjent.json: {sorted(clash)}")
        self.groups = {**patient.groups, **own}
        self.rules = data["reguly"]
        for r in self.rules:
            where = f"Reguła {r.get('rodzaj')}/{r.get('grupa')}"
            if r.get("rodzaj") not in self.kinds:
                raise ValueError(f"{where}: nieznany rodzaj")
            if r.get("grupa") not in self.groups:
                raise ValueError(f"{where}: brak grupy")
            if r.get("poziom") not in LEVEL_ORDER:
                raise ValueError(f"{where}: nieznany poziom")
            if r.get("droga") not in ROUTES:
                raise ValueError(f"{where}: nieznana droga {r.get('droga')}")

    @property
    def kind_list(self) -> list[dict]:
        return [{"id": k, **v} for k, v in self.kinds.items()]

    def check(self, items: list[CheckItem]) -> list[dict]:
        best: dict[tuple, tuple] = {}
        for idx, item in enumerate(items):
            matched = match_groups(item, self.groups.values())
            for order, rule in enumerate(self.rules):
                if rule["grupa"] not in matched:
                    continue
                if (rule.get("droga") == "ogolna" and item.topical) or (rule.get("droga") == "miejscowa" and not item.topical):
                    continue
                key = (idx, rule["rodzaj"], rule["grupa"])
                current = best.get(key)
                if current is None or LEVEL_ORDER[rule["poziom"]] < LEVEL_ORDER[current[1]["poziom"]]:
                    best[key] = (order, rule, item, matched[rule["grupa"]])
        results = []
        for (idx, _, _), (order, rule, item, hits) in best.items():
            results.append({
                "rodzaj": rule["rodzaj"], "tytul": self.kinds[rule["rodzaj"]]["nazwa"], "poziom": rule["poziom"],
                "pozycja": idx, "lek": item.label, "substancje": sorted({n for _, n in hits}),
                "grupa": self.groups[rule["grupa"]].name, "opis": rule["opis"],
                "zalecenie": rule.get("zalecenie", ""), "_order": order,
            })
        results.sort(key=lambda r: (r["pozycja"], LEVEL_ORDER[r["poziom"]], r["_order"]))
        for r in results:
            del r["_order"]
        return results
