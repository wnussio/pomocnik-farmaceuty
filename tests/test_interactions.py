from pathlib import Path

import pytest

from app.interactions import ALCOHOL_ITEM, CheckItem, InteractionDB
from app.normalize import substance_key, substance_tokens
from app.store import strength_value

DB = InteractionDB(Path(__file__).resolve().parent.parent / "data" / "interakcje.json")


def drug(label, *substances, atc=(), topical=False):
    return CheckItem(label=label, substances=[(substance_key(s), substance_tokens(s), s) for s in substances],
                     atc=list(atc), topical=topical)


def levels(items):
    return [(r["typ"], r["poziom"]) for r in DB.check(items)["wyniki"]]


def test_warfarin_with_nsaid_is_contraindicated():
    res = levels([drug("Warfin", "Warfarinum natricum"), drug("Nurofen", "Ibuprofenum")])
    assert res == [("regula", "przeciwwskazane")]


def test_rule_matches_regardless_of_order():
    res = levels([drug("Nurofen", "Ibuprofenum"), drug("Warfin", "Warfarinum natricum")])
    assert res == [("regula", "przeciwwskazane")]


def test_paracetamol_duplication():
    res = DB.check([drug("Apap", "Paracetamolum"), drug("Apap Noc", "Paracetamolum", "Diphenhydramini hydrochloridum")])
    assert [r["typ"] for r in res["wyniki"]] == ["dublowanie_substancji"]
    assert "paracetamol" in res["wyniki"][0]["opis"]


def test_two_different_nsaids_flagged_within_group():
    assert levels([drug("Ketonal", "Ketoprofenum"), drug("Nurofen", "Ibuprofenum")]) == [("w_obrebie_grupy", "istotna")]


def test_atc_only_group_matches():
    res = levels([drug("Ciprofloxacin", "Ciprofloxacinum", atc=["J01MA02"]),
                  drug("Calcium", "Calcii carbonas", atc=["A12AA04"])])
    assert ("regula", "niewielka") in res


def test_alcohol_with_benzodiazepine():
    assert levels([drug("Xanax", "Alprazolamum"), ALCOHOL_ITEM]) == [("regula", "przeciwwskazane")]


def test_topical_drug_is_skipped():
    res = DB.check([drug("Ketonal żel", "Ketoprofenum", topical=True), drug("Warfin", "Warfarinum natricum")])
    assert res["wyniki"] == []
    assert len(res["uwagi"]) == 1


def test_no_known_interaction():
    assert levels([drug("Apap", "Paracetamolum"), drug("Amlodipina", "Amlodipinum")]) == []


def test_drug_order_in_result_follows_rule():
    res = DB.check([drug("Tramal", "Tramadoli hydrochloridum"), drug("Hydroxyzinum", "Hydroxyzinum")])
    rule = next(r for r in res["wyniki"] if r["typ"] == "regula" and r["tytul"].startswith("Opioidy"))
    assert [d["nazwa"] for d in rule["leki"]] == ["Tramal", "Hydroxyzinum"]


@pytest.mark.parametrize("args, expected", [
    (("500", "mg"), (500.0, "mg")),
    (("1", "g"), (1000.0, "mg")),
    (("4", "mg", "5", "ml"), (0.8, "mg/ml")),
    (("40", "mg/ml"), (40.0, "mg/ml")),
    (("250", "mg/5 ml"), (50.0, "mg/ml")),
    (("", "mg"), None),
])
def test_strength_value(args, expected):
    assert strength_value(*args) == expected
