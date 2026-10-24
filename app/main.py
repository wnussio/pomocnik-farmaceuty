"""Serwer aplikacji: API + statyczny frontend."""
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import importer
from .interactions import ALCOHOL_ITEM, CheckItem, InteractionDB
from .patient import PatientRules
from .store import Product, Store
from .supplements import SupplementDB

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
INTERACTIONS_PATH = ROOT / "data" / "interakcje.json"
SUPPLEMENTS_PATH = ROOT / "data" / "suplementy.json"
PATIENT_PATH = ROOT / "data" / "pacjent.json"

app = FastAPI(title="Pomocnik farmaceuty")
state = {"store": Store(importer.DB_PATH), "interactions": InteractionDB(INTERACTIONS_PATH),
         "supplements": SupplementDB(SUPPLEMENTS_PATH)}
state["patient"] = PatientRules(PATIENT_PATH, state["interactions"])
update_status = {"trwa": False, "etap": "", "blad": "", "zakonczono": ""}
_update_lock = threading.Lock()
# Sygnały życia od otwartych kart - używane przez app.launcher do automatycznego zamknięcia.
activity = {"last_seen": time.monotonic(), "closing_at": None}

SPECIAL_ITEMS = {"alkohol": ALCOHOL_ITEM}


def store() -> Store:
    return state["store"]


def _product(pid: int) -> Product:
    p = store().products.get(pid)
    if not p:
        raise HTTPException(404, "Nie znaleziono leku")
    return p


@app.get("/api/status")
def status():
    s = store()
    return {"zaladowano": s.loaded, "stan_na_dzien": s.meta.get("stan_na_dzien", ""),
            "zaimportowano": s.meta.get("zaimportowano", ""), "liczba_produktow": len(s.products),
            "interakcje": state["interactions"].summary, "aktualizacja": update_status}


@app.get("/api/leki")
def search_products(q: str = ""):
    return [p.summary() for p in store().search_products(q)]


@app.get("/api/leki/{pid}")
def product_details(pid: int):
    return _product(pid).details()


@app.get("/api/substancje")
def search_substances(q: str = ""):
    return store().search_substances(q)


@app.get("/api/zamienniki")
def equivalents(klucze: str, zlozone: bool = False):
    keys = [k for k in klucze.split("|") if k]
    s = store()
    return {"substancje": [{"klucz": k, "nazwa": s.substance_name(k)} for k in keys],
            "leki": [p.summary() for p in s.equivalents(keys, zlozone)]}


@app.get("/api/suplementy")
def search_supplements(q: str = ""):
    return state["supplements"].search(q)


class CheckRequestItem(BaseModel):
    id: int | None = None
    specjalny: str | None = None
    suplement: str | None = None


class PatientProfile(BaseModel):
    wiek: str = "dorosly"
    ciaza: bool = False
    karmienie: bool = False


class CheckRequest(BaseModel):
    pozycje: list[CheckRequestItem]
    pacjent: PatientProfile = PatientProfile()


@app.get("/api/pacjent")
def patient_options():
    rules = state["patient"]
    return {"przedzialy_wieku": rules.age_bands, "status": rules.status}


def _check_item(entry: CheckRequestItem) -> CheckItem:
    if entry.specjalny:
        if entry.specjalny not in SPECIAL_ITEMS:
            raise HTTPException(400, f"Nieznana pozycja specjalna: {entry.specjalny}")
        return SPECIAL_ITEMS[entry.specjalny]
    if entry.suplement:
        try:
            return state["supplements"].check_item(entry.suplement)
        except KeyError:
            raise HTTPException(400, f"Nieznany suplement: {entry.suplement}") from None
    p = _product(entry.id)
    label = f"{p.name} {p.strength}".strip()
    return CheckItem(label=label, substances=[(s.key, s.tokens, s.name) for s in p.substances],
                     atc=p.atc, topical=p.topical)


@app.post("/api/interakcje")
def check_interactions(req: CheckRequest):
    items = [_check_item(e) for e in req.pozycje]
    profile = req.pacjent.model_dump()
    if profile["wiek"] not in state["patient"].bands:
        raise HTTPException(400, f"Nieznany przedział wieku: {profile['wiek']}")
    result = state["interactions"].check(items)
    result["pacjent"] = state["patient"].check(items, profile)
    result["profil"] = state["patient"].profile_label(profile)
    return result


def _run_update() -> None:
    try:
        update_status.update(etap="Pobieranie rejestru z ezdrowie.gov.pl…", blad="")
        importer.download()
        update_status["etap"] = "Import do bazy…"
        importer.import_xml()
        update_status["etap"] = "Wczytywanie…"
        state["store"] = Store(importer.DB_PATH)
        update_status.update(etap="Gotowe", zakonczono=datetime.now().isoformat(timespec="seconds"))
    except Exception as exc:  # noqa: BLE001 - błąd pokazujemy użytkownikowi
        traceback.print_exc()
        update_status.update(etap="Błąd", blad=str(exc))
    finally:
        update_status["trwa"] = False


@app.post("/api/aktualizacja")
def start_update():
    with _update_lock:
        if update_status["trwa"]:
            return update_status
        update_status["trwa"] = True
    threading.Thread(target=_run_update, daemon=True).start()
    return update_status


@app.post("/api/interakcje/przeladuj")
def reload_interactions():
    """Ponowne wczytanie interakcje.json i suplementy.json po ręcznej edycji (bez restartu serwera)."""
    try:
        state["interactions"] = InteractionDB(INTERACTIONS_PATH)
        state["supplements"] = SupplementDB(SUPPLEMENTS_PATH)
        state["patient"] = PatientRules(PATIENT_PATH, state["interactions"])
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, f"Błąd w pliku interakcji: {exc}") from exc
    return state["interactions"].summary


@app.post("/api/zycie")
def heartbeat():
    activity.update(last_seen=time.monotonic(), closing_at=None)
    return {}


@app.post("/api/zamykanie")
def page_closing():
    activity["closing_at"] = time.monotonic()
    return {}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
