from pathlib import Path

from app.dispensing import DispensingRules
from app.interactions import CheckItem, InteractionDB
from app.normalize import substance_key, substance_tokens
from app.patient import PatientRules
from app.refund import RefundDB
from app.symptoms import SymptomDB

DATA = Path(__file__).resolve().parent.parent / "data"
IDB = InteractionDB(DATA / "interakcje.json")
PATIENT = PatientRules(DATA / "pacjent.json", IDB)
RULES = DispensingRules(DATA / "ostrzezenia.json", PATIENT)
SYMPTOMS = SymptomDB(DATA / "objawy.json")


def drug(label, *substances, atc=(), topical=False):
    return CheckItem(label=label, substances=[(substance_key(s), substance_tokens(s), s) for s in substances],
                     atc=list(atc), topical=topical)


def warnings(*items):
    return [(r["lek"], r["rodzaj"], r["poziom"]) for r in RULES.check(list(items))]


def test_driving_and_food():
    assert warnings(drug("Relanium", "Diazepamum")) == [("Relanium", "pojazdy", "przeciwwskazane")]
    assert warnings(drug("Euthyrox", "Levothyroxinum natricum")) == [("Euthyrox", "zywnosc", "istotna")]


def test_doxycycline_sun_and_dairy():
    res = warnings(drug("Doxycyclinum", "Doxycyclini hyclas"))
    assert ("Doxycyclinum", "slonce", "istotna") in res and ("Doxycyclinum", "zywnosc", "istotna") in res


def test_ketoprofen_route():
    assert warnings(drug("Ketonal żel", "Ketoprofenum", topical=True)) == [("Ketonal żel", "slonce", "przeciwwskazane")]
    oral = warnings(drug("Ketonal", "Ketoprofenum"))
    assert ("Ketonal", "slonce", "niewielka") in oral and ("Ketonal", "zywnosc", "niewielka") in oral


def test_no_warning_for_unrelated_drug():
    assert warnings(drug("Paracetamol", "Paracetamolum")) == []


def test_senior_rules():
    doxylamine = drug("Dorminox", "Doxylamini hydrogenosuccinas")
    assert [r["poziom"] for r in PATIENT.check([doxylamine], {"wiek": "senior"})] == ["istotna"]
    assert PATIENT.check([doxylamine], {"wiek": "dorosly"}) == []
    assert PATIENT.profile_label({"wiek": "senior"}) == "Senior 65+"
    # Reguły dziecięce nie dotyczą seniorów.
    assert PATIENT.check([drug("Polopiryna", "Acidum acetylsalicylicum")], {"wiek": "senior"})[0]["warunek"] == "wiek_od"


def test_symptom_search_and_option_item():
    assert [s["id"] for s in SYMPTOMS.search("ból głowy")][:1] == ["bol_glowy"]
    assert any(s["id"] == "biegunka" for s in SYMPTOMS.search("rozwolnienie"))
    opt = next(o for o in SYMPTOMS.items["kaszel_suchy"]["opcje"] if o["nazwa"] == "Dekstrometorfan")
    sertraline = drug("Asentra", "Sertralinum")
    found = IDB.check([sertraline, SYMPTOMS.option_item(opt)])["wyniki"]
    assert found and found[0]["poziom"] in ("przeciwwskazane", "istotna")


def test_refund_badge_without_data(tmp_path):
    db = RefundDB(tmp_path / "brak.json")
    assert not db.loaded and db.for_gtin("5909990000000") is None
