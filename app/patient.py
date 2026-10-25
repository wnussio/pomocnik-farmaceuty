"""Ostrzeżenia zależne od pacjenta (wiek – dzieci i seniorzy, ciąża, karmienie piersią) – data/pacjent.json.

W odróżnieniu od interakcji dotyczą pojedynczych pozycji listy i obejmują też leki miejscowe.
"""
import json
from pathlib import Path

from .interactions import LEVEL_ORDER, CheckItem, InteractionDB, match_groups, parse_group

CONDITIONS = ("wiek", "wiek_od", "ciaza", "karmienie")
ROUTES = (None, "ogolna", "miejscowa")
ADULT = "dorosly"


def age_label(months: int) -> str:
    if months % 12:
        return f"poniżej {months} miesięcy"
    years = months // 12
    return "poniżej 1 roku" if years == 1 else f"poniżej {years} lat"


def condition_title(rule: dict) -> str:
    if rule["warunek"] == "wiek":
        return f"Wiek: {age_label(rule['ponizej_mies'])}"
    if rule["warunek"] == "wiek_od":
        return f"Wiek: {rule['od_mies'] // 12} lat i więcej"
    return "Ciąża" if rule["warunek"] == "ciaza" else "Karmienie piersią"


class PatientRules:
    def __init__(self, path: Path, interactions: InteractionDB):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.status = data.get("status", "")
        self.bands = {b["id"]: b for b in data["wiek_przedzialy"]}
        own = {gid: parse_group(gid, g) for gid, g in data.get("grupy", {}).items()}
        clash = own.keys() & interactions.groups.keys()
        if clash:
            raise ValueError(f"pacjent.json: grupy o nazwach zajętych w interakcje.json: {sorted(clash)}")
        self.groups = {**interactions.groups, **own}
        self.rules = data["reguly"]
        for r in self.rules:
            where = f"Reguła {r.get('warunek')}/{r.get('grupa')}"
            if r.get("warunek") not in CONDITIONS:
                raise ValueError(f"{where}: nieznany warunek")
            if r.get("grupa") not in self.groups:
                raise ValueError(f"{where}: brak grupy")
            if r.get("poziom") not in LEVEL_ORDER:
                raise ValueError(f"{where}: nieznany poziom")
            if r.get("droga") not in ROUTES:
                raise ValueError(f"{where}: nieznana droga {r.get('droga')}")
            if r["warunek"] == "wiek" and not isinstance(r.get("ponizej_mies"), int):
                raise ValueError(f"{where}: brak progu 'ponizej_mies'")
            if r["warunek"] == "wiek_od" and not isinstance(r.get("od_mies"), int):
                raise ValueError(f"{where}: brak progu 'od_mies'")

    @property
    def age_bands(self) -> list[dict]:
        return [{"id": b["id"], "nazwa": b["nazwa"]} for b in self.bands.values()]

    def profile_label(self, profile: dict) -> str:
        parts = []
        if profile.get("wiek") and profile["wiek"] != ADULT:
            parts.append(self.bands[profile["wiek"]]["nazwa"])
        if profile.get("ciaza"):
            parts.append("ciąża")
        if profile.get("karmienie"):
            parts.append("karmienie piersią")
        return ", ".join(parts)

    def _applies(self, rule: dict, profile: dict, item: CheckItem) -> bool:
        if rule.get("droga") == "ogolna" and item.topical:
            return False
        if rule.get("droga") == "miejscowa" and not item.topical:
            return False
        if rule["warunek"] in ("wiek", "wiek_od"):
            band = self.bands.get(profile.get("wiek") or ADULT)
            if band is None:
                raise ValueError(f"Nieznany przedział wieku: {profile.get('wiek')}")
            if rule["warunek"] == "wiek_od":
                return band["od_mies"] >= rule["od_mies"]
            return band["od_mies"] < rule["ponizej_mies"]
        return bool(profile.get(rule["warunek"]))

    def check(self, items: list[CheckItem], profile: dict) -> list[dict]:
        if not self.profile_label(profile):
            return []
        best: dict[tuple, tuple] = {}
        for idx, item in enumerate(items):
            matched = match_groups(item, self.groups.values())
            for order, rule in enumerate(self.rules):
                if rule["grupa"] not in matched or not self._applies(rule, profile, item):
                    continue
                key = (idx, rule["warunek"], rule["grupa"])
                current = best.get(key)
                if current is None or LEVEL_ORDER[rule["poziom"]] < LEVEL_ORDER[current[1]["poziom"]]:
                    best[key] = (order, rule, item, matched[rule["grupa"]])
        results = []
        for (idx, _, _), (order, rule, item, hits) in best.items():
            results.append({
                "warunek": rule["warunek"], "tytul": condition_title(rule), "poziom": rule["poziom"],
                "pozycja": idx, "lek": item.label, "substancje": sorted({n for _, n in hits}),
                "grupa": self.groups[rule["grupa"]].name, "opis": rule["opis"],
                "zalecenie": rule.get("zalecenie", ""), "_order": order,
            })
        results.sort(key=lambda r: (LEVEL_ORDER[r["poziom"]], r["pozycja"], r["_order"]))
        for r in results:
            del r["_order"]
        return results
