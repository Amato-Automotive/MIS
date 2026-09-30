"""
Merge dealer rows that are one outlet entered twice with a misspelt city.

The visit-log form's "+ Add new dealership" used to be the only way past a
search that missed ("Venkataramana motors - Hyderabad" typed with a hyphen never
matched the list's em dash), so reps re-added dealers they could not find, often
with a different spelling of the city: HOSUR / Hosūr, JALANDHAR / JALlANDHAR,
AMRITSAR / AMTITSAR. Beyond clutter these break attribution — two near-identical
cities tie under dealer_resolve's margin rule, so visits to that outlet land on
neither row.

A pair is merged only when it is unambiguous:
  • same OEM, same state, same dealer name (dealer_resolve.norm_name);
  • cities that are the same place after dealer_resolve.norm_city, or differ by
    a typo (similarity >= CITY_TYPO) — containment is NOT enough here, since
    "Delhi" and "South Delhi" can be two real outlets of one group;
  • at least one side came from the form (source='form'). Two rows from the OEM
    file or the seed are the source's own statement that they are two outlets;
  • no two different dealer codes.

The keeper is the row the rest of the system trusts most: OEM file, then seed,
then form; then the one with more visits; then the oldest. Its visits keep their
row; the duplicate's visits are moved onto it and the duplicate is deleted. A
duplicate carrying sales or targets is never deleted (it would cascade them).

After merging, every surviving row's city is rewritten to its canonical
spelling (dealer_resolve.canon_city: no accents, upper case), matching what the
form and the log-book sync now store. A rename that would collide with another
row is skipped and reported rather than forced.

    python -m scripts.merge_duplicate_dealers            # dry run, report only
    python -m scripts.merge_duplicate_dealers --apply    # merge, one transaction

Afterwards run `python -m scripts.resolve_visit_log_dealers --apply` so visits
that the tie left unattributed are re-resolved against the cleaned list.
"""
import argparse
import sys
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from database import SessionLocal
from services.dealer_resolve import _strip_accents, canon_city, norm_city, norm_name

# Above dealer_resolve's 0.82 on purpose: that threshold picks between cities a
# name already has, this one decides two rows are the same place and deletes
# one. JALLANDHAR/JALANDHAR is 0.95, AMTITSAR/AMRITSAR 0.88; Karur/Kurnool 0.55.
CITY_TYPO = 0.85

SOURCE_RANK = {"oe_file": 0, "seed": 1, "form": 2}


def _plain(city: str) -> str:
    """norm_city without its alias table. The alias fold moves GURUGRAM to
    GURGAON, which takes the typo GURURGAM out of reach of the similarity check;
    comparing the spelling as typed as well brings it back."""
    return " ".join("".join(c if c.isalnum() else " " for c in _strip_accents(city).upper()).split())


def same_place(a: str, b: str) -> bool:
    if not a or not b:
        return False  # a city-less row is a different problem; leave it
    if norm_city(a) == norm_city(b):
        return True  # same place by the resolver's own rules (accents, renames)
    # A typo is judged on the spelling as typed, never after the alias fold:
    # Bengaluru folds to BANGALORE, which is one letter from MANGALORE — a
    # different city 350 km away. And typos keep the first letter; real
    # neighbours that differ in one letter usually don't (Mangalore/Bangalore).
    x, y = _plain(a), _plain(b)
    return x[:1] == y[:1] and SequenceMatcher(None, x, y).ratio() >= CITY_TYPO


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="commit; otherwise dry run")
    args = ap.parse_args()

    db = SessionLocal()
    rows = db.execute(text("""
        SELECT d.id::text AS id, d.oem, d.state, d.name, COALESCE(d.city, '') AS city,
               d.source, COALESCE(d.dealer_code, '') AS code, d.created_at,
               (SELECT COUNT(*) FROM oe_visit_logs v WHERE v.dealer_id = d.id) AS visits,
               (SELECT COUNT(*) FROM oe_dealer_monthly m WHERE m.dealer_id = d.id)
             + (SELECT COUNT(*) FROM oe_dealer_targets t WHERE t.dealer_id = d.id) AS sales
        FROM oe_dealerships d
        WHERE d.is_active
    """)).mappings().all()

    groups: dict[tuple, list] = {}
    for r in rows:
        nn = norm_name(r["name"])
        if nn:
            groups.setdefault((r["oem"].upper(), r["state"].upper(), nn), []).append(r)

    # Between rows of equal standing, keep the city spelling the rest of the
    # master uses most — otherwise the older row wins, and for KOSMO that was
    # the misspelt JALlANDHAR.
    city_use: dict[str, int] = {}
    for r in rows:
        city_use[_plain(r["city"])] = city_use.get(_plain(r["city"]), 0) + 1
    rank = lambda r: (SOURCE_RANK.get(r["source"], 3), -city_use.get(_plain(r["city"]), 0),
                      -r["visits"], r["created_at"])
    merges = []  # (keeper, duplicate)
    for members in groups.values():
        if len(members) < 2:
            continue
        # Greedy clustering in trust order: each row joins the first keeper
        # whose city it is a spelling of, otherwise becomes a keeper itself.
        keepers: list = []
        for r in sorted(members, key=rank):
            home = next((k for k in keepers
                         if same_place(k["city"], r["city"])
                         and "form" in (k["source"], r["source"])
                         and not (k["code"] and r["code"] and k["code"] != r["code"])
                         and r["sales"] == 0), None)
            if home is None:
                keepers.append(r)
            else:
                merges.append((home, r))

    gone = {d["id"] for _k, d in merges}
    survivors = [r for r in rows if r["id"] not in gone]
    taken = {(r["oem"].upper(), r["state"].upper(), r["name"].upper(),
              r["city"].upper(), r["code"].upper()) for r in survivors}
    renames, clashes = [], []  # (row, new city)
    for r in survivors:
        new = canon_city(r["city"])
        if not new or new == r["city"]:
            continue
        key = (r["oem"].upper(), r["state"].upper(), r["name"].upper(), new, r["code"].upper())
        if new != r["city"].upper() and key in taken:
            clashes.append((r, new))
        else:
            renames.append((r, new))

    if not merges and not renames:
        print("Nothing to do: no duplicate outlets, every city already canonical.")
        return

    print(f"{len(merges)} duplicate row(s) to fold:\n")
    for k, d in merges:
        print(f"  {k['oem']:<8} {k['state']:<16} {k['name']}")
        print(f"      keep  {k['city']:<20} [{k['source']}, {k['visits']} visits]")
        print(f"      fold  {d['city']:<20} [{d['source']}, {d['visits']} visits]")

    accented = [(r, n) for r, n in renames if _strip_accents(r["city"]) != r["city"]]
    print(f"\n{len(renames)} city spelling(s) to canonicalise "
          f"({len(renames) - len(accented)} case only). Accented ones:")
    for r, n in accented:
        print(f"  {r['oem']:<8} {r['name']}: {r['city']} -> {n}")
    for r, n in clashes:
        print(f"  SKIPPED (another row already holds {n}): {r['oem']} {r['state']} "
              f"{r['name']} / {r['city']}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return

    try:
        for k, d in merges:
            db.execute(text("UPDATE oe_visit_logs SET dealer_id = CAST(:keep AS uuid) "
                            "WHERE dealer_id = CAST(:gone AS uuid)"),
                       {"keep": k["id"], "gone": d["id"]})
            db.execute(text("DELETE FROM oe_dealerships WHERE id = CAST(:gone AS uuid)"),
                       {"gone": d["id"]})
        for r, new in renames:
            db.execute(text("UPDATE oe_dealerships SET city = :city, updated_at = NOW() "
                            "WHERE id = CAST(:id AS uuid)"), {"city": new, "id": r["id"]})
        db.commit()
    except Exception:
        db.rollback()
        raise
    print(f"\nMerged {len(merges)} row(s), canonicalised {len(renames)} city "
          "spelling(s). Now run: "
          "python -m scripts.resolve_visit_log_dealers --apply")


if __name__ == "__main__":
    main()
