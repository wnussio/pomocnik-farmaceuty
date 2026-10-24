"""Buduje wersję na telefon (PWA działająca offline) do katalogu pwa/dist.

    python -m pwa.build            # z istniejącej bazy data/leki.db (importuje, jeśli brak)
    python -m pwa.build --pobierz  # najpierw pobiera najnowszy rejestr URPL

Dane są wstępnie przetwarzane tutaj (te same moduły co wersja na komputer), więc
JavaScript w przeglądarce tylko wyszukuje i sprawdza interakcje.
"""
import argparse
import hashlib
import json
import re
import shutil
import struct
import zlib
from datetime import datetime
from pathlib import Path

from app import importer
from app.interactions import InteractionDB
from app.normalize import IGNORED_WORDS, POLISH_ALIASES
from app.patient import PatientRules
from app.store import Store
from app.supplements import SupplementDB

PWA_DIR = Path(__file__).resolve().parent
SRC_DIR = PWA_DIR / "src"
DIST_DIR = PWA_DIR / "dist"
DATA_DIR = importer.DATA_DIR
DETAIL_SHARDS = 16

_URL_ID = re.compile(r"/medicinal-products/(\d+)/")


def _url_id(url: str):
    m = _URL_ID.search(url or "")
    return int(m.group(1)) if m else None


class _Index:
    """Słownik wartości -> numer (zmniejsza rozmiar danych)."""

    def __init__(self):
        self.values, self._pos = [], {}

    def __call__(self, value):
        if value not in self._pos:
            self._pos[value] = len(self.values)
            self.values.append(value)
        return self._pos[value]


def build_products(store: Store) -> tuple[dict, list[dict]]:
    subs, forms, groups, holders, dims, routes = (_Index() for _ in range(6))
    subst_rows: dict[int, list] = {}
    products, shards = [], [{} for _ in range(DETAIL_SHARDS)]
    for p in sorted(store.products.values(), key=lambda p: p.id):
        sub_list = []
        for s in p.substances:
            si = subs(s.key + "\x00" + s.name)
            subst_rows.setdefault(si, [s.key, s.name, " ".join(s.tokens)])
            sub_list.append([si, s.text, s.value, dims(s.dim) if s.dim else -1])
        flags = (1 if p.active else 0) | (2 if p.topical else 0)
        products.append([p.id, p.name, p.strength, forms(p.form), groups(p.form_group), holders(p.holder),
                         ",".join(p.categories), flags, ",".join(p.atc), [routes(r) for r in p.routes], sub_list])
        shards[p.id % DETAIL_SHARDS][p.id] = [
            p.common_name, p.permit_no, p.permit_validity, _url_id(p.leaflet_url), _url_id(p.spc_url),
            [[pk["gtin"], pk["category"], pk["description"], pk["parallel"]]
             for pk in p.packages if not pk["deleted"]],
        ]
    data = {
        # Bez znacznika czasu importu - wersja aplikacji zmienia się tylko, gdy zmienią się dane.
        "meta": {"stan_na_dzien": store.meta.get("stan_na_dzien", "")},
        "substancje": [subst_rows[i] for i in range(len(subs.values))],
        "nazwy_substancji": store.key_names,
        "postacie": forms.values, "grupy_postaci": groups.values, "podmioty": holders.values,
        "wymiary": dims.values, "drogi": routes.values, "leki": products,
    }
    return data, shards


def build_interactions(db: InteractionDB) -> dict:
    return {
        "status": db.status, "wersja": db.version,
        "grupy": {g.id: {"nazwa": g.name, "tokeny": sorted(g.tokens), "atc": list(g.atc), "w_obrebie": g.within}
                  for g in db.groups.values()},
        "reguly": db.rules,
    }


def build_patient(rules: PatientRules, interactions: InteractionDB) -> dict:
    own = {gid: g for gid, g in rules.groups.items() if gid not in interactions.groups}
    return {
        "status": rules.status, "wiek_przedzialy": list(rules.bands.values()),
        "grupy": {g.id: {"nazwa": g.name, "tokeny": sorted(g.tokens), "atc": list(g.atc)} for g in own.values()},
        "reguly": rules.rules,
    }


def build_supplements(sdb: SupplementDB) -> dict:
    items = []
    for sid, s in sdb.items.items():
        item = sdb.check_item(sid)
        words, stems = sdb._search[sid]
        items.append({"id": sid, "nazwa": s["nazwa"], "kategoria": s["kategoria"],
                      "popularny": s.get("popularny", False), "atc": item.atc,
                      "substancje": [[k, t, n] for k, t, n in item.substances],
                      "szukaj": words, "rdzenie": sorted(stems)})
    return {"status": sdb.status, "skladniki": items}


def _png(size: int) -> bytes:
    """Ikona: turkusowy zaokrąglony kwadrat z białym krzyżem (bez zewnętrznych bibliotek)."""
    teal, white = (15, 118, 110, 255), (255, 255, 255, 255)
    r, arm, length = size * 0.2, size * 0.11, size * 0.30
    c = size / 2
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            dx, dy = min(x, size - 1 - x), min(y, size - 1 - y)
            inside = not (dx < r and dy < r and (r - dx) ** 2 + (r - dy) ** 2 > r ** 2)
            cross = (abs(x - c) < arm and abs(y - c) < length) or (abs(y - c) < arm and abs(x - c) < length)
            row += bytes(white if inside and cross else teal if inside else (0, 0, 0, 0))
        rows.append(bytes(row))

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def _write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build(download: bool = False) -> Path:
    if download:
        importer.download()
        importer.import_xml()
    elif not importer.DB_PATH.exists():
        if not importer.RAW_XML.exists():
            importer.download()
        importer.import_xml()

    store = Store(importer.DB_PATH)
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    shutil.copytree(SRC_DIR, DIST_DIR)
    data_dir = DIST_DIR / "data"
    data_dir.mkdir()

    products, shards = build_products(store)
    _write_json(data_dir / "leki.json", products)
    for i, shard in enumerate(shards):
        _write_json(data_dir / f"szczegoly-{i}.json", shard)
    _write_json(data_dir / "ean.json", store.by_gtin)
    interactions = InteractionDB(DATA_DIR / "interakcje.json")
    _write_json(data_dir / "interakcje.json", build_interactions(interactions))
    _write_json(data_dir / "pacjent.json",
                build_patient(PatientRules(DATA_DIR / "pacjent.json", interactions), interactions))
    _write_json(data_dir / "suplementy.json", build_supplements(SupplementDB(DATA_DIR / "suplementy.json")))
    _write_json(data_dir / "normalizacja.json", {"ignorowane": sorted(IGNORED_WORDS), "aliasy": POLISH_ALIASES})
    for size in (192, 512):
        (DIST_DIR / f"icon-{size}.png").write_bytes(_png(size))

    # Lista plików do pamięci offline + wersja (zmiana treści => telefon pobierze nową wersję).
    files = sorted(p.relative_to(DIST_DIR).as_posix() for p in DIST_DIR.rglob("*")
                   if p.is_file() and p.name != "sw.js")
    digest = hashlib.sha256()
    for f in files:
        digest.update(f.encode() + (DIST_DIR / f).read_bytes())
    version = digest.hexdigest()[:12]
    sw = (SRC_DIR / "sw.js").read_text(encoding="utf-8")
    sw = sw.replace("__VERSION__", version).replace("__FILES__", json.dumps(["./"] + files))
    (DIST_DIR / "sw.js").write_text(sw, encoding="utf-8")
    _write_json(DIST_DIR / "version.json", {"wersja": version, "zbudowano": datetime.now().isoformat(timespec="seconds"),
                                            "stan_na_dzien": products["meta"]["stan_na_dzien"]})
    return DIST_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description="Budowanie wersji PWA")
    parser.add_argument("--pobierz", action="store_true", help="pobierz najnowszy rejestr przed budowaniem")
    args = parser.parse_args()
    out = build(download=args.pobierz)
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"Zbudowano {out} ({total / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
