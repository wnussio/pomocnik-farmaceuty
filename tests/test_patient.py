from pathlib import Path

import pytest

from app.interactions import CheckItem, InteractionDB
from app.normalize import substance_key, substance_tokens
from app.patient import PatientRules, age_label
from app.supplements import SupplementDB

DATA = Path(__file__).resolve().parent.parent / "data"
IDB = InteractionDB(DATA / "interakcje.json")
RULES = PatientRules(DATA / "pacjent.json", IDB)
SUPP = SupplementDB(DATA / "suplementy.json")


def drug(label, *substances, atc=(), topical=False):
    return CheckItem(label=label, substances=[(substance_key(s), substance_tokens(s), s) for s in substances],
                     atc=list(atc), topical=topical)


def warnings(items, **profile):
    return [(r["lek"], r["warunek"], r["poziom"]) for r in RULES.check(items, profile)]


ASPIRIN = drug("Polopiryna S", "Acidum acetylsalicylicum", atc=["N02BA01"])


def test_adult_without_flags_gets_no_warnings():
    assert warnings([ASPIRIN], wiek="dorosly") == []
    assert RULES.profile_label({"wiek": "dorosly"}) == ""


def test_aspirin_in_child():
    assert warnings([ASPIRIN], wiek="6-11") == [("Polopiryna S", "wiek", "przeciwwskazane")]


def test_age_threshold_uses_band_start():
    codeine = drug("Thiocodin", "Codeini phosphas hemihydricus", "Sulfogaiacolum")
    assert warnings([codeine], wiek="6-11") == [("Thiocodin", "wiek", "przeciwwskazane")]
    assert warnings([codeine], wiek="12-17") == []


def test_most_severe_rule_wins_for_same_group():
    loperamide = drug("Stoperan", "Loperamidi hydrochloridum")
    assert warnings([loperamide], wiek="niemowle") == [("Stoperan", "wiek", "przeciwwskazane")]
    assert warnings([loperamide], wiek="6-11") == [("Stoperan", "wiek", "istotna")]


def test_topical_drugs_are_checked_for_patient():
    adapalene = drug("Differin", "Adapalenum", topical=True)
    assert warnings([adapalene], ciaza=True) == [("Differin", "ciaza", "przeciwwskazane")]


@pytest.mark.parametrize("topical, expected", [(False, []), (True, [("Maść", "wiek", "istotna")])])
def test_route_restriction(topical, expected):
    salicylic = drug("Maść", "Acidum salicylicum", topical=topical)
    assert warnings([salicylic], wiek="niemowle") == expected


def test_breastfeeding_and_supplement():
    res = warnings([drug("Thiocodin", "Codeini phosphas hemihydricus"), SUPP.check_item("berberyna")], karmienie=True)
    assert res == [("Thiocodin", "karmienie", "przeciwwskazane"), ("Berberyna", "karmienie", "przeciwwskazane")]


def test_age_labels():
    assert age_label(3) == "poniżej 3 miesięcy"
    assert age_label(12) == "poniżej 1 roku"
    assert age_label(192) == "poniżej 16 lat"
