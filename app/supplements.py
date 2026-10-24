"""Katalog składników suplementów diety (data/suplementy.json)."""
import json
from pathlib import Path

from .interactions import CheckItem
from .normalize import simple, stem, substance_key, substance_tokens


class SupplementDB:
    def __init__(self, path: Path):
        data = json.loads(path.read_text(encoding="utf-8"))
        self.status = data.get("status", "")
        self.items: dict[str, dict] = {}
        self._search: dict[str, tuple[str, set]] = {}
        for s in data["skladniki"]:
            if s["id"] in self.items:
                raise ValueError(f"Suplementy: zduplikowane id '{s['id']}'")
            self.items[s["id"]] = s
            words = simple(" ".join([s["nazwa"], *s.get("szukaj", []), *s["substancje"]]))
            self._search[s["id"]] = (words, {stem(w) for w in words.split()})

    def summary(self, s: dict) -> dict:
        return {"id": s["id"], "nazwa": s["nazwa"], "kategoria": s["kategoria"],
                "popularny": s.get("popularny", False)}

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

    def check_item(self, sid: str) -> CheckItem:
        s = self.items.get(sid)
        if s is None:
            raise KeyError(sid)
        # Klucze substancji jak w rejestrze leków -> wykrywanie dublowania lek + suplement.
        substances = [(substance_key(n), substance_tokens(n), s["nazwa"]) for n in s["substancje"]]
        return CheckItem(label=s["nazwa"], substances=substances, atc=list(s.get("atc", [])))
