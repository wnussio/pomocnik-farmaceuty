"""Silnik sprawdzania interakcji między lekami z listy.

Wykrywa: reguły z tabeli (para grup), połączenia w obrębie jednej grupy,
dublowanie tej samej substancji czynnej oraz leków z tej samej podgrupy ATC.
"""
import json
from dataclasses import dataclass, field
from pathlib import Path

from .normalize import stem, substance_tokens

LEVELS = ("przeciwwskazane", "istotna", "niewielka")
LEVEL_ORDER = {lvl: i for i, lvl in enumerate(LEVELS)}

PARACETAMOL_KEY = "paracetamol"


@dataclass
class CheckItem:
    """Pozycja listy: lek z rejestru albo pozycja specjalna (np. alkohol)."""
    label: str
    substances: list          # [(klucz, tokeny, nazwa wyświetlana)]
    atc: list = field(default_factory=list)
    topical: bool = False

    @property
    def keys(self) -> frozenset:
        return frozenset(k for k, _, _ in self.substances if k)


@dataclass
class Group:
    id: str
    name: str
    tokens: set
    atc: tuple
    within: dict | None


def parse_group(gid: str, g: dict) -> Group:
    tokens = set()
    for entry in g.get("substancje", []):
        entry_tokens = substance_tokens(entry)
        if len(entry_tokens) != 1:
            raise ValueError(f"Grupa {gid}: '{entry}' musi wskazywać jedno słowo identyfikujące substancję")
        tokens.add(entry_tokens[0])
    within = g.get("w_obrebie_grupy")
    if within and within["poziom"] not in LEVEL_ORDER:
        raise ValueError(f"Grupa {gid}: nieznany poziom {within['poziom']}")
    return Group(gid, g["nazwa"], tokens, tuple(g.get("atc", [])), within)


def match_groups(item: CheckItem, groups) -> dict[str, list]:
    """Dla każdej pasującej grupy: lista substancji pozycji, które ją wywołały."""
    out: dict[str, list] = {}
    for g in groups:
        hits = [(k, name) for k, tokens, name in item.substances if g.tokens.intersection(tokens)]
        if not hits and g.atc and any(code.startswith(g.atc) for code in item.atc):
            hits = [(k, name) for k, _, name in item.substances] or [(None, item.label)]
        if hits:
            out[g.id] = hits
    return out


class InteractionDB:
    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.status = data.get("status", "")
        self.version = data.get("wersja", "")
        self.groups: dict[str, Group] = {gid: parse_group(gid, g) for gid, g in data["grupy"].items()}
        self.rules = data["reguly"]
        for r in self.rules:
            for side in ("a", "b"):
                if r[side] not in self.groups:
                    raise ValueError(f"Reguła {r['a']}+{r['b']}: brak grupy '{r[side]}'")
            if r["poziom"] not in LEVEL_ORDER:
                raise ValueError(f"Reguła {r['a']}+{r['b']}: nieznany poziom {r['poziom']}")

    @property
    def summary(self) -> dict:
        return {"status": self.status, "wersja": self.version,
                "liczba_grup": len(self.groups), "liczba_regul": len(self.rules)}

    def match_groups(self, item: CheckItem) -> dict[str, list]:
        return match_groups(item, self.groups.values())

    def check(self, items: list[CheckItem]) -> dict:
        notes, active = [], []
        for idx, item in enumerate(items):
            if item.topical:
                notes.append(f"{item.label}: lek o działaniu miejscowym – pominięty w analizie interakcji ogólnoustrojowych.")
            else:
                active.append(idx)
        matches = {idx: self.match_groups(items[idx]) for idx in active}
        results = []
        for n, i in enumerate(active):
            for j in active[n + 1:]:
                results.extend(self._check_pair(i, j, items, matches))
        results.sort(key=lambda r: (LEVEL_ORDER[r["poziom"]], r["pozycje"]))
        return {"wyniki": results, "uwagi": notes, "baza": self.summary}

    def _check_pair(self, i: int, j: int, items: list[CheckItem], matches: dict) -> list[dict]:
        a, b = items[i], items[j]
        ma, mb = matches[i], matches[j]
        found = []

        def result(kind, level, title, desc, advice, subs_a, subs_b, swapped=False):
            pair = [(i, a, subs_a), (j, b, subs_b)]
            if swapped:  # kolejność leków zgodna z kolejnością grup w tytule reguły
                pair.reverse()
            found.append({
                "typ": kind, "poziom": level, "tytul": title, "opis": desc, "zalecenie": advice,
                "pozycje": [i, j],
                "leki": [{"nazwa": item.label, "substancje": sorted(set(subs))} for _, item, subs in pair],
            })

        for key in sorted(a.keys & b.keys):
            name = next(n for k, _, n in a.substances if k == key)
            if key == PARACETAMOL_KEY:
                desc = ("Oba leki zawierają paracetamol – ryzyko przekroczenia dawki dobowej "
                        "(maks. zwykle 4 g/dobę u dorosłych, mniej u osób z chorobami wątroby lub pijących alkohol) "
                        "i ciężkiego uszkodzenia wątroby.")
            else:
                desc = f"Oba leki zawierają tę samą substancję czynną ({name}) – ryzyko przedawkowania."
            result("dublowanie_substancji", "istotna", f"Dublowanie substancji: {name}", desc,
                   "Sprawdzić łączną dawkę dobową; zwykle stosować tylko jeden z tych leków.", [name], [name])

        for rule in self.rules:
            for swapped, mx, my in ((False, ma, mb), (True, mb, ma)):
                if rule["a"] in mx and rule["b"] in my:
                    subs_x = [n for _, n in mx[rule["a"]]]
                    subs_y = [n for _, n in my[rule["b"]]]
                    subs_a, subs_b = (subs_y, subs_x) if swapped else (subs_x, subs_y)
                    title = f"{self.groups[rule['a']].name} + {self.groups[rule['b']].name}"
                    result("regula", rule["poziom"], title, rule["opis"], rule.get("zalecenie", ""),
                           subs_a, subs_b, swapped)
                    break

        group_hit = False
        for gid in ma.keys() & mb.keys():
            g = self.groups[gid]
            keys_a = {k for k, _ in ma[gid]}
            keys_b = {k for k, _ in mb[gid]}
            if keys_a == keys_b and None not in keys_a:
                continue  # ta sama substancja - zgłoszone jako dublowanie substancji
            group_hit = True
            if g.within:
                result("w_obrebie_grupy", g.within["poziom"], g.name, g.within["opis"],
                       g.within.get("zalecenie", ""), [n for _, n in ma[gid]], [n for _, n in mb[gid]])

        if not group_hit and not found:
            shared = {c[:5] for c in a.atc if len(c) >= 5} & {c[:5] for c in b.atc if len(c) >= 5}
            if shared and a.keys != b.keys:
                codes = ", ".join(sorted(shared))
                result("dublowanie_atc", "niewielka", f"Ta sama podgrupa terapeutyczna (ATC {codes})",
                       "Oba leki należą do tej samej podgrupy ATC – możliwe dublowanie terapii.",
                       "Sprawdzić, czy jednoczesne stosowanie jest zamierzone.",
                       [n for _, _, n in a.substances], [n for _, _, n in b.substances])
        return found


ALCOHOL_ITEM = CheckItem(label="Alkohol", substances=[("alkohol", [stem("Alkohol")], "Alkohol (etanol)")])
