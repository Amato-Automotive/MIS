"""
AutoForm MIS — resolving a logged dealership to a dealer OUTLET.

Every visit-log row names a dealership and a city as free-ish text. The dealer
view needs those rows attached to a specific outlet in `oe_dealerships`, because
one group can run several (PREM MOTORS Narela vs PREM MOTORS Wazirpur) and
leadership asks its questions per outlet: coverage, top/bottom 20, growth.

Matching is not a straight equality check for two reasons:

  • History. Until Aug 2026 the form filled City from a public geo API, picked
    independently of the dealership, so its spellings are the API's and the
    dealer list's are the OE team's — Bengaluru/BANGALORE, Ambāla/AMBALA,
    Guwhati/GUWAHATI, Bhubaneswar/BHUBANESHWAR. About 39% of August's rows
    disagree on city while naming the right dealer.
  • Names carry trade noise (PVT / LTD / LLP) inconsistently on both sides, and
    the pre-dropdown era is full of truncations — "Anand Motors" for ANAND
    MOTOR, "Poddar Car" for PODDAR CAR WORLD, "Bimal Auto" for BIMAL AUTO
    AGENCY.
  • Some cities were renamed rather than misspelt. Bengaluru scores 0.667
    against BANGALORE and Prayagraj 0.333 against ALLAHABAD — no similarity
    threshold can catch those without also accepting genuinely wrong places, so
    they need naming, not scoring.

New rows do not have this problem — the form now takes the city from the chosen
dealer — so this is mostly about not throwing away the history.

The rule, in order:
  1. find the dealer by exact normalised name within the OEM; failing that, by
     name containment (one side's words are all present in the other) and only
     when exactly ONE dealer qualifies, so "BHANDARI" can't swallow a longer
     unrelated name;
  2. that dealer is in exactly ONE city → that city, whatever was typed. A
     group with a single city cannot be ambiguous, so a city typo is harmless;
  3. several cities → the best one, accepted only if it clears
     MIN_CITY_SIMILARITY *and* is clearly ahead of the runner-up. Two outlets
     of one group in similar-sounding cities is exactly where a wrong guess
     would be invisible, so we abstain instead;
  4. one city, several outlets — which happens only where the OEM's file is
     keyed per dealer code (TATA: ANANYA AUTO AGENCY / PATNA is two codes with
     two separate targets) → the ANCHOR, the lowest code of the group.

Step 4 needs saying out loud, because it is the one step that does not resolve
to the truth. A visit log names a dealership and a city and never a code, so a
contact at a two-code dealer genuinely cannot be attributed to one of them.
Spreading it, dropping it, or picking at random would each be worse: the anchor
is deterministic, so the same contact lands in the same place every sync, and
the Dealers tab reads contacts at the (oem, name, city) GROUP level so both
siblings show the visit that was really made to the dealership. Callers that
know the code — the dealer file's own sync — pass it and get an exact match
instead.

Anything unresolved stays unresolved. A NULL dealer_id is a reportable fact —
never guess to make a number look complete.
"""
from __future__ import annotations

import collections
import re
import unicodedata
from difflib import SequenceMatcher
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

# A city has to look this much like the candidate before we accept it.
# 0.82 keeps Bengaluru→BANGALORE (0.84) and Guwhati→GUWAHATI (0.93) while
# rejecting genuinely different places like Ongole→GUNTUR (0.33).
MIN_CITY_SIMILARITY = 0.82
# ...and it has to beat the next-best candidate by this much, so a group with
# two similar city names is left alone rather than assigned on a coin flip.
MIN_CITY_MARGIN = 0.08

_NOISE = re.compile(r"\b(PVT|PRIVATE|LTD|LIMITED|LLP|CO|COMPANY|AND|THE)\b")

# Cities that were renamed, or that the two sides simply call different things.
# Both spellings are folded to one side; which side wins does not matter as
# long as it is consistent. Only pairs seen in the real data are listed — this
# is not meant to become a gazetteer.
_CITY_ALIASES = {
    "BENGALURU": "BANGALORE",
    "PRAYAGRAJ": "ALLAHABAD",
    "GURUGRAM": "GURGAON",
    "MYSURU": "MYSORE",
    "VADODARA": "BARODA",
    "KOCHI": "COCHIN",
    "THIRUVANANTHAPURAM": "TRIVANDRUM",
    "PUDUCHERRY": "PONDICHERRY",
    "VISAKHAPATNAM": "VIZAG",
    "VISHAKHAPATNAM": "VIZAG",
    "KOZHIKODE": "CALICUT",

    # ── Misspelt rather than renamed ──────────────────────────────────────────
    # Same table, same rule, because the fix is the same: fold every spelling in
    # play to one. These are not near-misses a similarity score would catch —
    # SAFTARJUNG vs SAFDARJANG scores 0.80 against a 0.82 threshold, and
    # lowering the threshold far enough to catch it would start accepting
    # genuinely different places. They have to be named.
    #
    # The value side is INTERNAL — it is a matching key and is never displayed,
    # so it only has to be the one spelling everything else collapses onto.
    # SAFDARJANG is the canonical side (the OE dealer list's spelling, and the
    # one the business confirmed), so it needs no entry of its own.
    "SAFTARJUNG": "SAFDARJANG",     # the geo API's spelling
    "SAFDARJUNG": "SAFDARJANG",
    "SAFDARGUNJ": "SAFDARJANG",
    "COACH BIHAR": "COOCHBEHAR",    # Cooch Behar, typed as heard
    "COOCH BEHAR": "COOCHBEHAR",
    "CUDDAPAH": "KADAPA",           # renamed 2005; both spellings still in use
    "MAPUCA": "MAPUSA",             # Māpuçá, the Portuguese spelling, once folded
}


def _strip_accents(s: str) -> str:
    """Ambāla → Ambala. The geo API returns diacritics, the dealer list doesn't."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def canon_city(s: Optional[str]) -> str:
    """The one spelling a city is STORED under: accents off, spaces collapsed,
    upper case. "Bhopāl", "Bhopal" and "BHOPAL" all become BHOPAL.

    The form's city list comes from a geo API that returns diacritics, while
    the older rows and the OEM dealer file are plain upper case, so one city
    reached the tables three ways and every city breakdown split it three ways.
    Unlike norm_city this keeps punctuation and applies no aliases — it decides
    what is displayed, not what matches.
    """
    return " ".join(_strip_accents(s or "").upper().split())


def norm_name(s: Optional[str]) -> str:
    """Fold a dealership name to what actually identifies it.

    Trailing plurals go too: the two sides disagree on MOTOR/MOTORS and
    CAR/CARS constantly ("Anand Motors" for ANAND MOTOR). Only on words long
    enough that the S is a plural rather than the whole point of the word.
    """
    s = _NOISE.sub(" ", _strip_accents(s or "").upper())
    s = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", s)).strip()
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("S") else w for w in s.split())


def norm_city(s: Optional[str]) -> str:
    """Fold a city to one spelling, accents first.

    Order matters and is the whole reason this is a function rather than a dict
    lookup: the geo API returns Hyderābād, Karīmnagar, Māpuçá and Guntūr, so the
    accents come off BEFORE the alias table is consulted. Written the other way
    round the table would have to carry every macron variant of every entry, and
    a missing one would fail silently — the city would simply not match and the
    row would go unattributed with nothing to show why.

    Applied to BOTH sides: the dealer master goes through it at load (see
    DealerIndex) and the logged city goes through it at resolve, so a spelling
    only has to be listed once to bring the two together.
    """
    s = _strip_accents(s or "").upper()
    s = re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9 ]", " ", s)).strip()
    return _CITY_ALIASES.get(s, s)


def _city_score(a: str, b: str) -> float:
    """How much two city strings look like the same place.

    Containment is treated as near-certain because the disagreements that take
    that shape are qualifiers, not different places: "West Delhi" vs DELHI,
    "Pune Division" vs PUNE. Plain similarity handles the misspellings.
    """
    if a == b:
        return 1.0
    ta, tb = set(a.split()), set(b.split())
    if ta and tb and (ta <= tb or tb <= ta):
        return 0.95
    return SequenceMatcher(None, a, b).ratio()


class DealerIndex:
    """Loads the outlet master once, then resolves rows in memory.

    A sync replaces thousands of rows in one transaction; querying per row over
    the SSH tunnel to the VPS would dominate its runtime.
    """

    def __init__(self, db: Session):
        rows = db.execute(text("""
            SELECT id, oem, name, COALESCE(city, '') AS city,
                   COALESCE(dealer_code, '') AS dealer_code
            FROM oe_dealerships
            WHERE is_active
        """)).fetchall()
        # (normalised city, id, code) per dealer name. The code is '' for every
        # OEM whose file merges codes onto one outlet row, which is all of them
        # except the per-code tabs.
        self._by_name: dict[tuple, list[tuple[str, str, str]]] = collections.defaultdict(list)
        self._names_by_oem: dict[str, list[tuple[str, frozenset]]] = collections.defaultdict(list)
        self._count = 0
        for r in rows:
            oem = (r.oem or "").upper()
            nn = norm_name(r.name)
            if not oem or not nn:
                continue
            key = (oem, nn)
            if key not in self._by_name:
                self._names_by_oem[oem].append((nn, frozenset(nn.split())))
            self._by_name[key].append((norm_city(r.city), r.id, (r.dealer_code or "").upper()))
            self._count += 1
        self._memo: dict[tuple, Optional[str]] = {}

    def __len__(self) -> int:
        return self._count

    def _find_name(self, oem: str, nn: str) -> Optional[tuple]:
        """The dealer key this name refers to, or None if it is ambiguous.

        Falls back to word containment for the truncations the old free-text
        form is full of, and only when a single dealer qualifies — "BHANDARI"
        is itself a dealer name and would otherwise absorb every longer name
        starting with it.
        """
        key = (oem, nn)
        if key in self._by_name:
            return key
        words = frozenset(nn.split())
        if not words:
            return None
        hits = [n for n, ws in self._names_by_oem.get(oem, []) if ws <= words or words <= ws]
        return (oem, hits[0]) if len(hits) == 1 else None

    def resolve(self, oem: Optional[str], name: Optional[str],
                city: Optional[str], code: Optional[str] = None) -> Optional[str]:
        """The outlet id for a named dealership, or None if it is ambiguous.

        `code` is the OEM's dealer code, and it is exact: pass it when the
        caller genuinely knows which code it means (the dealer file's own sync
        does), and the city guessing below is skipped entirely. Visit logs never
        know it, so they fall through to the anchor rule.
        """
        oem = (oem or "").upper()
        nn, nc = norm_name(name), norm_city(city)
        nk = (code or "").strip().upper()
        if not oem or not nn:
            return None

        memo_key = (oem, nn, nc, nk)
        if memo_key in self._memo:
            return self._memo[memo_key]

        result = None
        key = self._find_name(oem, nn)
        if key:
            candidates = self._by_name[key]
            if nk:
                exact = [did for _c, did, ck in candidates if ck == nk]
                result = exact[0] if len(exact) == 1 else None
            if result is None:
                # Score CITIES, not rows: a per-code group puts several outlets
                # in one city, and scoring rows would make them tie and cancel
                # each other out under the margin rule.
                cities = sorted({c for c, _did, _ck in candidates})
                if len(cities) == 1:
                    winner = cities[0]
                else:
                    scored = sorted(((_city_score(nc, c), c) for c in cities),
                                    key=lambda x: -x[0])
                    best, runner_up = scored[0], scored[1]
                    winner = (best[1] if best[0] >= MIN_CITY_SIMILARITY
                              and best[0] - runner_up[0] >= MIN_CITY_MARGIN else None)
                if winner is not None:
                    # The anchor: lowest code in the city. Deterministic, so the
                    # same contact lands on the same outlet every sync.
                    here = sorted((ck, did) for c, did, ck in candidates if c == winner)
                    result = here[0][1] if here else None

        self._memo[memo_key] = result
        return result
