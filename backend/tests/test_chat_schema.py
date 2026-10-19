"""Structural checks that keep the chatbot's four lists of tables and modules
in step: the schema prompt, the phase-25 grants/policies, the scope builder's
module map, and the routers' own constants. Each drift here is silent in
production — a table the prompt names but the role cannot read, or a sheet
module the scope forgets — so it is pinned here instead."""
import re
from pathlib import Path

from services.chat_schema import CHAT_TABLES, DOCUMENTED_COLUMNS, SYSTEM_PROMPT
from services.chat_scope import DATA_MODULES, SOURCE_MODULES
from services.oe_scope import SCOPED_TABLES
from services.permissions import VALID_MODULES

BACKEND = Path(__file__).resolve().parent.parent
MIGRATION = (BACKEND / "migrate_phase25_chatbot_scope.sql").read_text(encoding="utf-8")


def _policy_tables() -> set:
    block = MIGRATION.split("policies := jsonb_build_object(")[1].split(");")[0]
    return set(re.findall(r"^\s*'(\w+)',", block, flags=re.M))


def _hidden_columns() -> dict:
    block = MIGRATION.split("hidden jsonb := '")[1].split("';")[0]
    return {t: re.findall(r'"(\w+)"', cols) for t, cols in re.findall(r'"(\w+)":\s*\[([^\]]*)\]', block)}


def test_prompt_policies_and_grants_name_the_same_tables():
    granted = set(re.findall(r"\w+", MIGRATION.split("GRANT SELECT ON")[1].split("TO mis_chatbot")[0]))
    granted |= set(_hidden_columns())          # the column-granted tables
    assert _policy_tables() == CHAT_TABLES == granted


def test_identity_tables_are_never_exposed():
    for t in ("users", "user_module_access", "user_sheet_source_access", "asm_portal_users",
              "asm_portal_otps", "chat_usage", "chat_scope_key"):
        assert t not in CHAT_TABLES and t not in _policy_tables()


def test_the_prompt_never_names_a_hidden_column():
    for table, cols in _hidden_columns().items():
        assert not set(cols) & set(DOCUMENTED_COLUMNS.get(table, [])), table


def test_every_scoped_oe_table_has_a_rep_policy():
    for t in SCOPED_TABLES:
        assert re.search(rf"format\(rep, '{t}'\)", MIGRATION), t


def test_chat_is_a_door_not_a_data_module():
    assert "chat" in VALID_MODULES and "chat" not in DATA_MODULES
    assert set(DATA_MODULES) | {"chat"} == VALID_MODULES
    assert set(SOURCE_MODULES) == set(DATA_MODULES)


def test_every_router_sheet_module_maps_to_exactly_one_permission():
    """A sheet module string missing from SOURCE_MODULES would vanish from the
    chatbot's view of the registry and sync logs ("sees too little")."""
    found = set()
    for f in (BACKEND / "routers").glob("*.py"):
        for name, value in re.findall(r'^(MODULE(?:_\w+)?)\s*=\s*"(\w+)"', f.read_text(encoding="utf-8"), re.M):
            if name != "MODULE_KEY":
                found.add(value)
    mapped = [s for strings in SOURCE_MODULES.values() for s in strings]
    assert len(mapped) == len(set(mapped)), "a sheet module is mapped twice"
    assert found == set(mapped)


def test_prompt_interpolates_backend_constants():
    assert "MOBIS = HYUNDAI + KIA" in SYSTEM_PROMPT
    assert "For TATA, ysasc equals oem_total" in SYSTEM_PROMPT
    assert "11 Dispatch" in SYSTEM_PROMPT


def test_benchmark_fixtures_are_well_formed():
    import json
    from services.chat_scope import DATA_MODULES
    from services.sql_guard import guard_sql
    fixtures = json.loads((BACKEND / "tests" / "chat_benchmark.json").read_text(encoding="utf-8"))
    assert len({f["id"] for f in fixtures}) == len(fixtures)
    for f in fixtures:
        assert f["module"] in DATA_MODULES, f["id"]
        assert f.get("audience", "any") in {"any", "management", "rep", "without_module"}, f["id"]
        assert any(k in f for k in ("reference_sql", "must_mention", "sql_must_match", "expect_escalated",
                                    "capability_sql")), f"{f['id']} checks nothing"
        for k in ("reference_sql", "capability_sql"):
            if k in f:
                guard_sql(f[k])
        for k in ("must_mention", "must_not_mention", "sql_must_match", "sql_must_not_match",
                  "when_incapable_must_mention"):
            if k in f:
                re.compile(f[k])


def test_prompt_is_cache_stable():
    """The cached prefix must not carry anything volatile. Dates belong in the
    per-request context, never here."""
    assert not re.search(r"20\d\d-\d\d-\d\d", SYSTEM_PROMPT)
    import importlib
    import services.chat_schema as m
    assert importlib.reload(m).SYSTEM_PROMPT == SYSTEM_PROMPT
