"""City spelling: what is stored (canon_city) and what the dealer cleanup
treats as one place (same_place). Both fail quietly — a wrong answer here is a
city split three ways on a dashboard, or two real outlets merged into one."""
from scripts.merge_duplicate_dealers import same_place
from services.dealer_resolve import canon_city


def test_canon_city_folds_accents_case_and_spaces():
    assert canon_city("Bhopāl") == "BHOPAL"
    assert canon_city("  hyderābād ") == "HYDERABAD"
    assert canon_city("Sri  Ganganagar") == "SRI GANGANAGAR"
    assert canon_city(None) == ""


def test_canon_city_does_not_apply_aliases():
    # Aliases are a matching concern; storage keeps what the rep picked.
    assert canon_city("Bengaluru") == "BENGALURU"


def test_same_place_accepts_accents_renames_and_typos():
    assert same_place("HOSUR", "Hosūr")
    assert same_place("GURUGRAM", "Gurgaon")          # renamed city
    assert same_place("JALANDHAR", "JALlANDHAR")      # typo
    assert same_place("AMRITSAR", "AMTITSAR")         # typo
    assert same_place("GURUGRAM", "GURURGAM")         # typo hidden by the alias fold


def test_same_place_rejects_different_cities():
    # Bengaluru folds to BANGALORE, one letter from MANGALORE — never the same.
    assert not same_place("MANGALORE", "Bengaluru")
    assert not same_place("MANGALORE", "BANGALORE")
    assert not same_place("Karur", "Tiruchirappalli")
    assert not same_place("", "HOSUR")                # city-less rows are left alone
