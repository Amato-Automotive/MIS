"""
AutoForm MIS — what the chatbot may read, for one user.

The chatbot runs the model's SQL as `mis_chatbot`, and row-level security on
that role decides which rows come back (migrate_phase25_chatbot_scope.sql). The
policies read the user's scope from one session setting, `app.chat_scope`,
signed with a key the chatbot role cannot read — so a query that rewrites its
own scope with set_config() gets zero rows instead of everyone's.

The rule this module keeps: the scope gives the chatbot exactly what the app's
own routers give the user. Less is not "safe" — a chatbot answering "no data"
gets pointed at DATABASE_URL to fix it, and that role bypasses RLS entirely.
So every input below comes from the helpers the routers use:

  modules          get_user_modules(), minus "chat" (the door, not a data grant)
  finance_sources  get_user_sheet_source_ids(module="finance") — the only module
                   that grants per company
  source_modules   SOURCE_MODULES below, for the registry and sync_logs
  oe_*             routers.oe_network._scope — the same OEScope every OE route uses
"""
import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from models import SheetSource, User
from services.oe_scope import SCOPED_TABLES
from services.permissions import get_user_modules, get_user_sheet_source_ids

# Module keys whose data the chatbot can read. "chat" is deliberately absent:
# holding it opens the chat page and grants nothing behind it.
DATA_MODULES = ("sales", "leads", "finance", "oe_network", "export")

# sheet_sources.module / sync_logs.module strings, by the permission key that
# owns them. tests/test_chat_schema.py checks this against every MODULE
# constant in the routers: a source string missing here would silently vanish
# from the chatbot's view of the registry.
SOURCE_MODULES = {
    "sales": ("sales_plant_to_depot", "sales_depot_to_distributor"),
    "leads": (),
    "finance": ("finance",),
    "oe_network": ("oe_visit_plan", "oe_log_book", "oe_targets", "oe_dealer_data", "oe_oem_targets"),
    "export": ("export_leads",),
}

# Long enough for one question's queries (statement_timeout is 15s), short
# enough that a scope copied out of a session is useless after a permission
# change. The router signs a fresh one per query anyway.
SCOPE_TTL_SECONDS = 120


@dataclass(frozen=True)
class ChatScope:
    modules: tuple
    finance_sources: tuple = ()
    finance_labels: tuple = ()          # for the narration, never for the policies
    source_modules: tuple = ()
    oe_scoped: bool = True
    oe_salesperson: Optional[str] = None
    oe_names: dict = field(default_factory=dict)

    def payload(self, now: Optional[float] = None) -> str:
        """The exact JSON the policies read. sort_keys + fixed separators so a
        given scope always serialises to the same bytes."""
        exp = int(now if now is not None else time.time()) + SCOPE_TTL_SECONDS
        return json.dumps({
            "modules": list(self.modules),
            "finance_sources": list(self.finance_sources),
            "source_modules": list(self.source_modules),
            "oe_scoped": self.oe_scoped,
            "oe_names": self.oe_names,
            "exp": exp,
        }, sort_keys=True, separators=(",", ":"))


def sign(key: bytes, payload: str) -> str:
    """hex(sha256(key || sha256(key || payload))) — byte-for-byte what
    chat_scope() in migrate_phase25_chatbot_scope.sql recomputes. Change one,
    change both; tests/test_chat_rls.py fails if they diverge."""
    inner = hashlib.sha256(key + payload.encode("utf-8")).digest()
    return hashlib.sha256(key + inner).hexdigest()


def build_chat_scope(db: Session, user: User) -> ChatScope:
    modules = tuple(m for m in sorted(get_user_modules(db, user)) if m in DATA_MODULES)

    finance_sources: tuple = ()
    finance_labels: tuple = ()
    if "finance" in modules:
        finance_sources = tuple(sorted(get_user_sheet_source_ids(db, user, module="finance")))
        if finance_sources:
            rows = (db.query(SheetSource.label)
                    .filter(SheetSource.id.in_(finance_sources), SheetSource.kind == "company")
                    .order_by(SheetSource.label).all())
            finance_labels = tuple(r[0] for r in rows)

    source_modules = tuple(sorted(s for m in modules for s in SOURCE_MODULES[m]))

    # Without the module the OE tables are closed by the module gate anyway;
    # "scoped with no names" is the conservative way to say so.
    oe_scoped, oe_salesperson, oe_names = True, None, {t: [] for t in SCOPED_TABLES}
    if "oe_network" in modules:
        from routers.oe_network import _scope   # the one OE gate; see its docstring
        scope, _ = _scope(db, user)
        oe_scoped = scope.limited
        oe_salesperson = scope.canonical
        oe_names = ({t: sorted(scope.names_in(t)) for t in SCOPED_TABLES}
                    if scope.limited else {})

    return ChatScope(modules=modules, finance_sources=finance_sources,
                     finance_labels=finance_labels, source_modules=source_modules,
                     oe_scoped=oe_scoped, oe_salesperson=oe_salesperson, oe_names=oe_names)


_key_cache: Optional[bytes] = None


def scope_key(app_db: Session, refresh: bool = False) -> bytes:
    """The signing key, read over the APP connection (mis_chatbot cannot read
    it — that is the point). Cached; refresh=True after a rotation."""
    global _key_cache
    if _key_cache is None or refresh:
        row = app_db.execute(text("SELECT key FROM chat_scope_key WHERE id = 1")).first()
        if row is None:
            raise RuntimeError("chat_scope_key is empty — apply migrate_phase25_chatbot_scope.sql")
        _key_cache = bytes(row[0])
    return _key_cache
