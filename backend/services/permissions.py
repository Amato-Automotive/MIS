"""
AutoForm MIS — Permissions Service (Phase 7)
Per-user module access + per-sheet-source (e.g. Finance company) access.
Superadmin always bypasses both checks.
"""
from sqlalchemy.orm import Session
from fastapi import HTTPException
from models import User, UserModuleAccess, UserSheetSourceAccess, SheetSource

# "chat" is the AI assistant. Unlike the others it is a door, not data: what a
# user can ask about is still decided by the data modules they hold
# (services/chat_scope.py:DATA_MODULES deliberately leaves it out).
VALID_MODULES = {"sales", "leads", "finance", "oe_network", "export", "chat"}


def user_has_module(db: Session, user: User, module: str) -> bool:
    if user.role == "superadmin":
        return True
    return db.query(UserModuleAccess).filter(
        UserModuleAccess.user_id == user.id, UserModuleAccess.module == module
    ).first() is not None


def require_module(db: Session, user: User, module: str) -> None:
    if not user_has_module(db, user, module):
        raise HTTPException(status_code=403, detail=f"Not authorized to access the '{module}' module")


def user_has_sheet_source_access(db: Session, user: User, sheet_source_id) -> bool:
    if user.role == "superadmin":
        return True
    return db.query(UserSheetSourceAccess).filter(
        UserSheetSourceAccess.user_id == user.id,
        UserSheetSourceAccess.sheet_source_id == sheet_source_id,
    ).first() is not None


def require_sheet_source_access(db: Session, user: User, sheet_source_id) -> None:
    if not user_has_sheet_source_access(db, user, sheet_source_id):
        raise HTTPException(status_code=403, detail="Not authorized to access this company's data")


def get_user_modules(db: Session, user: User) -> list:
    if user.role == "superadmin":
        return sorted(VALID_MODULES)
    rows = db.query(UserModuleAccess.module).filter(UserModuleAccess.user_id == user.id).all()
    return [r[0] for r in rows]


def get_user_sheet_source_ids(db: Session, user: User, module: str = None) -> list:
    q = db.query(SheetSource.id)
    if module:
        q = q.filter(SheetSource.module == module)
    if user.role != "superadmin":
        q = q.join(UserSheetSourceAccess, UserSheetSourceAccess.sheet_source_id == SheetSource.id) \
             .filter(UserSheetSourceAccess.user_id == user.id)
    return [str(r[0]) for r in q.all()]
