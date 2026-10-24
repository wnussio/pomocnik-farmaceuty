"""Pobieranie i import Rejestru Produktów Leczniczych (URPL) do SQLite.

Uruchomienie z wiersza poleceń:
    python -m app.importer            # importuje data/raw/rpl.xml (pobiera, jeśli brak)
    python -m app.importer --pobierz  # zawsze pobiera najnowszy rejestr
"""
import argparse
import json
import os
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

REGISTRY_URL = (
    "https://rejestrymedyczne.ezdrowie.gov.pl/api/rpl/medicinal-products/"
    "public-pl-report/6.0.0/overall.xml"
)
NS = "{http://rejestry.ezdrowie.gov.pl/rpl/eksport-danych-v6.0.0}"

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
RAW_XML = DATA_DIR / "raw" / "rpl.xml"
DB_PATH = DATA_DIR / "leki.db"

SCHEMA = """
CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    common_name TEXT,
    strength TEXT,
    form TEXT,
    holder TEXT,
    permit_no TEXT,
    permit_validity TEXT,
    leaflet_url TEXT,
    spc_url TEXT,
    atc TEXT,
    routes TEXT,
    substances TEXT,
    packages TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""


def download(dest: Path = RAW_XML) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".xml.part")
    req = urllib.request.Request(REGISTRY_URL, headers={"User-Agent": "farmacja-pomocnik/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp, open(tmp, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    os.replace(tmp, dest)
    return dest


def _package_description(pkg: ET.Element) -> str:
    parts = []
    for unit in pkg.iter(NS + "jednostkaOpakowania"):
        count, kind = unit.get("liczbaOpakowan", ""), unit.get("rodzajOpakowania", "")
        size, size_unit = unit.get("pojemnosc", ""), unit.get("jednostkaPojemnosci", "")
        text = " ".join(x for x in (count, kind, size, size_unit) if x)
        if extra := unit.get("informacjeDodatkowe"):
            text += f" ({extra})"
        parts.append(text)
    return " + ".join(parts)


def _parse_product(el: ET.Element) -> dict:
    substances = [
        {
            "name": s.get("nazwaSubstancji", "").strip(),
            "amount": s.get("iloscSubstancji", ""),
            "unit": s.get("jednostkaMiaryIlosciSubstancji", ""),
            "prep_amount": s.get("iloscPreparatu", ""),
            "prep_unit": s.get("jednostkaMiaryIlosciPreparatu", ""),
            "other": s.get("innyOpisIlosci", ""),
        }
        for s in el.iter(NS + "substancjaCzynna")
    ]
    common = (el.get("nazwaPowszechnieStosowana") or "").strip()
    if not substances and common and "homeopat" not in common.lower():
        # Część wpisów (np. import równoległy) nie ma listy substancji - bierzemy nazwę powszechną.
        substances = [{"name": n.strip(), "amount": "", "unit": "", "prep_amount": "",
                       "prep_unit": "", "other": ""} for n in common.split("+") if n.strip()]
    packages = [
        {
            "gtin": p.get("kodGTIN", ""),
            "category": p.get("kategoriaDostepnosci", ""),
            "deleted": p.get("skasowane") == "TAK",
            "description": _package_description(p),
            "parallel": p.get("dystrybutorRownolegly", ""),
        }
        for p in el.iter(NS + "opakowanie")
    ]
    return {
        "id": int(el.get("id")),
        "name": el.get("nazwaProduktu", "").strip(),
        "common_name": common,
        "strength": el.get("moc", ""),
        "form": el.get("nazwaPostaciFarmaceutycznej", ""),
        "holder": el.get("podmiotOdpowiedzialny", ""),
        "permit_no": el.get("numerPozwolenia", ""),
        "permit_validity": el.get("waznoscPozwolenia", ""),
        "leaflet_url": el.get("ulotka", ""),
        "spc_url": el.get("charakterystyka", ""),
        "atc": ",".join(a.text.strip() for a in el.iter(NS + "kodATC") if a.text),
        "routes": "|".join(r.get("drogaPodaniaNazwa", "").strip() for r in el.iter(NS + "drogaPodania")),
        "substances": json.dumps(substances, ensure_ascii=False),
        "packages": json.dumps(packages, ensure_ascii=False),
    }


def import_xml(xml_path: Path = RAW_XML, db_path: Path = DB_PATH) -> int:
    """Buduje bazę w pliku tymczasowym i podmienia ją dopiero po udanym imporcie."""
    tmp_db = db_path.with_suffix(".db.part")
    tmp_db.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp_db)
    conn.executescript(SCHEMA)
    count, as_of = 0, ""
    for event, el in ET.iterparse(xml_path, events=("start", "end")):
        if event == "start":
            if el.tag == NS + "produktyLecznicze":
                as_of = el.get("stanNaDzien", "")
            continue
        if el.tag != NS + "produktLeczniczy":
            continue
        if el.get("rodzajPreparatu") == "ludzki":
            row = _parse_product(el)
            conn.execute(f"INSERT INTO products ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                         list(row.values()))
            count += 1
        el.clear()
    conn.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("stan_na_dzien", as_of),
        ("zaimportowano", datetime.now().isoformat(timespec="seconds")),
        ("liczba_produktow", str(count)),
    ])
    conn.commit()
    conn.close()
    os.replace(tmp_db, db_path)
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Rejestru Produktów Leczniczych")
    parser.add_argument("--pobierz", action="store_true", help="pobierz najnowszy rejestr z ezdrowie.gov.pl")
    args = parser.parse_args()
    if args.pobierz or not RAW_XML.exists():
        print("Pobieranie rejestru…")
        download()
    print(f"Zaimportowano {import_xml()} produktów do {DB_PATH}")


if __name__ == "__main__":
    main()
