from pathlib import Path

from app.interactions import CheckItem, InteractionDB
from app.normalize import substance_key, substance_tokens
from app.supplements import SupplementDB

DATA = Path(__file__).resolve().parent.parent / "data"
DB = InteractionDB(DATA / "interakcje.json")
SUPP = SupplementDB(DATA / "suplementy.json")

# Składniki bez reguł interakcji - tylko wykrywanie dublowania.
WITHOUT_RULES = {"selen", "wit_b6", "wit_c"}


def drug(label, *substances, atc=()):
    return CheckItem(label=label, substances=[(substance_key(s), substance_tokens(s), s) for s in substances],
                     atc=list(atc))


def results(*items):
    return [(r["typ"], r["poziom"]) for r in DB.check(list(items))["wyniki"]]


def test_every_supplement_matches_a_group():
    for sid in SUPP.items:
        if sid not in WITHOUT_RULES:
            assert DB.match_groups(SUPP.check_item(sid)), sid


def test_warfarin_with_vitamin_k():
    assert results(drug("Warfin", "Warfarinum natricum"), SUPP.check_item("wit_k")) == [("regula", "istotna")]


def test_drug_and_supplement_same_substance_is_duplication():
    assert results(drug("Vigantol", "Cholecalciferolum", atc=["A11CC05"]), SUPP.check_item("wit_d")) == \
        [("dublowanie_substancji", "istotna")]


def test_red_yeast_rice_duplicates_statin():
    assert ("w_obrebie_grupy", "istotna") in results(drug("Atoris", "Atorvastatinum"), SUPP.check_item("czerwony_ryz"))


def test_mineral_supplement_hits_atc_based_cation_rules():
    assert results(drug("Cipronex", "Ciprofloxacinum", atc=["J01MA02"]), SUPP.check_item("magnez")) == \
        [("regula", "niewielka")]


def test_search_by_synonym_and_polish_name():
    assert [s["id"] for s in SUPP.search("d3")] == ["wit_d"]
    assert "milorzab" in [s["id"] for s in SUPP.search("miłorząb")]
    assert "babka_jajowata" in [s["id"] for s in SUPP.search("psyllium")]
