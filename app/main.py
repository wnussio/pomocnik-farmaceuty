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

from . import importer, refund
from .dispensing import DispensingRules
from .interactions import ALCOHOL_ITEM, CheckItem, InteractionDB
from .patient import PatientRules
from .refund import RefundDB
from .store import Product, Store
from .supplements import SupplementDB
from .symptoms import SymptomDB

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
INTERACTIONS_PATH = ROOT / "data" / "interakcje.json"
SUPPLEMENTS_PATH = ROOT / "data" / "suplementy.json"
PATIENT_PATH = ROOT / "data" / "pacjent.json"
DISPENSING_PATH = ROOT / "data" / "ostrzezenia.json"
SYMPTOMS_PATH = ROOT / "data" / "objawy.json"

app = FastAPI(title="Pomocnik farmaceuty")
state = {"store": Store(importer.DB_PATH), "interactions": InteractionDB(INTERACTIONS_PATH),
         "supplements": SupplementDB(SUPPLEMENTS_PATH), "symptoms": SymptomDB(SYMPTOMS_PATH), "refund": RefundDB()}
state["patient"] = PatientRules(PATIENT_PATH, state["interactions"])
state["dispensing"] = DispensingRules(DISPENSING_PATH, state["patient"])
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


def _summary(p: Product) -> dict:
    return p.summary() | {"refundacja": state["refund"].product_badge(p)}


def _product_item(p: Product) -> CheckItem:
    label = f"{p.name} {p.strength}".strip()
    return CheckItem(label=label, substances=[(s.key, s.tokens, s.name) for s in p.substances],
                     atc=p.atc, topical=p.topical)


@app.get("/api/status")
def status():
    s = store()
    return {"zaladowano": s.loaded, "stan_na_dzien": s.meta.get("stan_na_dzien", ""),
            "zaimportowano": s.meta.get("zaimportowano", ""), "liczba_produktow": len(s.products),
            "interakcje": state["interactions"].summary, "refundacja": state["refund"].summary,
            "aktualizacja": update_status}


@app.get("/api/leki")
def search_products(q: str = ""):
    return [_summary(p) for p in store().search_products(q)]


@app.get("/api/leki/{pid}")
def product_details(pid: int):
    p = _product(pid)
    out = p.details() | {"refundacja": state["refund"].product_badge(p),
                         "ostrzezenia": state["dispensing"].check([_product_item(p)])}
    for pk in out["opakowania"]:
        pk["refundacja"] = state["refund"].for_gtin(pk["gtin"])
    return out


@app.get("/api/substancje")
def search_substances(q: str = ""):
    return store().search_substances(q)


@app.get("/api/zamienniki")
def equivalents(klucze: str, zlozone: bool = False):
    keys = [k for k in klucze.split("|") if k]
    s = store()
    return {"substancje": [{"klucz": k, "nazwa": s.substance_name(k)} for k in keys],
            "leki": [_summary(p) for p in s.equivalents(keys, zlozone)]}


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
    return {"przedzialy_wieku": rules.age_bands, "status": rules.status,
            "rodzaje_ostrzezen": state["dispensing"].kind_list}


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
    return _product_item(_product(entry.id))


def _profile(req: CheckRequest) -> dict:
    profile = req.pacjent.model_dump()
    if profile["wiek"] not in state["patient"].bands:
        raise HTTPException(400, f"Nieznany przedział wieku: {profile['wiek']}")
    return profile


@app.post("/api/interakcje")
def check_interactions(req: CheckRequest):
    items = [_check_item(e) for e in req.pozycje]
    profile = _profile(req)
    result = state["interactions"].check(items)
    result["pacjent"] = state["patient"].check(items, profile)
    result["profil"] = state["patient"].profile_label(profile)
    result["wydanie"] = state["dispensing"].check(items)
    return result


@app.get("/api/objawy")
def search_symptoms(q: str = ""):
    db = state["symptoms"]
    return {"objawy": db.search(q), "pytania": db.questions, "status": db.status}


@app.post("/api/objawy/{sid}")
def symptom_details(sid: str, req: CheckRequest):
    """Objaw z podpowiedziami; każda sprawdzona z listą leków pacjenta i jego profilem."""
    db = state["symptoms"]
    s = db.items.get(sid)
    if s is None:
        raise HTTPException(404, "Nie znaleziono objawu")
    items = [_check_item(e) for e in req.pozycje]
    profile = _profile(req)
    options = []
    for opt in s["opcje"]:
        item = db.option_item(opt)
        found = state["interactions"].check([*items, item])["wyniki"]
        options.append({k: v for k, v in opt.items() if not k.startswith("_")} | {
            "produkty": [_summary(p) for p in db.products(store(), opt)],
            "interakcje": [r for r in found if len(items) in r["pozycje"]],
            "pacjent": state["patient"].check([item], profile),
            "wydanie": state["dispensing"].check([item]),
        })
    return {k: v for k, v in s.items() if k != "opcje"} | {
        "opcje": options, "profil": state["patient"].profile_label(profile)}


def update_refund() -> None:
    """Lista refundacyjna osobno: rejestr leków działa także bez niej (np. gdy gov.pl nie odpowiada)."""
    try:
        refund.download()
        refund.import_xlsx()
        state["refund"] = RefundDB()
    except Exception as exc:  # noqa: BLE001 - błąd pokazujemy użytkownikowi
        traceback.print_exc()
        update_status["blad"] = f"lista refundacyjna: {exc}"


def _run_update() -> None:
    try:
        update_status.update(etap="Pobieranie rejestru z ezdrowie.gov.pl…", blad="")
        importer.download()
        update_status["etap"] = "Import do bazy…"
        importer.import_xml()
        update_status["etap"] = "Wczytywanie…"
        state["store"] = Store(importer.DB_PATH)
        update_status["etap"] = "Pobieranie listy leków refundowanych (gov.pl)…"
        update_refund()
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
    """Ponowne wczytanie tabel z data/*.json po ręcznej edycji (bez restartu serwera)."""
    try:
        state["interactions"] = InteractionDB(INTERACTIONS_PATH)
        state["supplements"] = SupplementDB(SUPPLEMENTS_PATH)
        state["patient"] = PatientRules(PATIENT_PATH, state["interactions"])
        state["dispensing"] = DispensingRules(DISPENSING_PATH, state["patient"])
        state["symptoms"] = SymptomDB(SYMPTOMS_PATH)
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
