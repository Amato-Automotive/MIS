"""
AutoForm MIS — Updated SQLAlchemy ORM Models (Phase 3)
"""
import uuid
from sqlalchemy import Column, String, Boolean, Integer, Date, Text, ForeignKey, Numeric, Float
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.sql import func
from sqlalchemy import TIMESTAMP
from database import Base


class User(Base):
    __tablename__ = "users"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name                 = Column(String(100), nullable=False)
    email                = Column(String(150), unique=True, nullable=False)
    password_hash        = Column(Text, nullable=False)
    role                 = Column(String(50), nullable=False)
    department           = Column(String(100))
    # OE Network row-level scope. NULL = sees all OE data; a name here hard-limits
    # every /oe-network endpoint to that salesperson (services/oe_scope.py).
    oe_salesperson       = Column(String(100), nullable=True)
    is_active            = Column(Boolean, default=True)
    must_change_password  = Column(Boolean, default=False)
    reset_otp             = Column(String(6), nullable=True)
    reset_otp_expires_at  = Column(TIMESTAMP(timezone=True), nullable=True)
    created_by            = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at            = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at            = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class Lead(Base):
    __tablename__ = "leads"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_date       = Column(Date, nullable=False)
    source          = Column(String(30), nullable=False)
    customer_name   = Column(String(200))
    mobile_number   = Column(String(20))
    car_type        = Column(String(100))
    product_type    = Column(String(200))
    location        = Column(String(200))
    state           = Column(String(100))
    call_status     = Column(String(50))
    reason          = Column(Text)
    reason_category = Column(String(50))
    assigned_asm    = Column(String(100))
    review_status   = Column(String(50))
    review_reason   = Column(Text)
    upload_log_id   = Column(UUID(as_uuid=True), ForeignKey("upload_logs.id", ondelete="SET NULL"), nullable=True)
    uploaded_by     = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class UploadLog(Base):
    __tablename__ = "upload_logs"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False)
    filename      = Column(String(255), nullable=False)
    rows_total    = Column(Integer, default=0)
    rows_success  = Column(Integer, default=0)
    rows_failed   = Column(Integer, default=0)
    status        = Column(String(30), default="Processing")
    error_details = Column(Text)
    uploaded_by   = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    uploaded_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())


class PlantToDepotSale(Base):
    __tablename__ = "plant_to_depot_sales"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="SET NULL"), nullable=True)
    sale_year       = Column(Integer, nullable=False)
    sale_month      = Column(Integer, nullable=False)
    depot           = Column(String(50), nullable=False)
    brand           = Column(String(20), nullable=False)
    category        = Column(String(30), nullable=False)
    qty             = Column(Numeric(12, 2))
    rate            = Column(Numeric(12, 2))
    amount          = Column(Numeric(14, 2), nullable=False)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class SheetSource(Base):
    __tablename__ = "sheet_sources"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False)
    sheet_id      = Column(String(100), nullable=False)
    label         = Column(String(100), nullable=False)
    calendar_year = Column(Integer, nullable=True)
    quarter       = Column(String(2), nullable=True)
    month         = Column(Integer, nullable=True)  # OE visit plans: one sheet per (calendar_year, month)
    kind          = Column(String(10), nullable=True)  # finance v3: 'master' | 'company'
    company_group = Column(String(10), nullable=True)  # finance companies: 'amato' | 'other' | NULL (untagged)
    created_by    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())


class DistributorSale(Base):
    __tablename__ = "distributor_sales"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    entity_type     = Column(String(20), nullable=False)
    distributor     = Column(String(150), nullable=False)
    area_head       = Column(String(100), nullable=True)
    target          = Column(Numeric(14, 2), nullable=True)
    sale_year       = Column(Integer, nullable=False)
    sale_month      = Column(Integer, nullable=False)
    category        = Column(String(10), nullable=False)
    amount          = Column(Numeric(14, 2), nullable=False)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class OEVisitPlan(Base):
    __tablename__ = "oe_visit_plans"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    salesperson     = Column(String(100), nullable=False)
    visit_date      = Column(Date, nullable=True)
    plan_year       = Column(Integer, nullable=False)
    plan_month      = Column(Integer, nullable=False)
    oem             = Column(String(50), nullable=True)
    dealer_name     = Column(String(200), nullable=False)
    city            = Column(String(100), nullable=True)
    state           = Column(String(100), nullable=True)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OEVisitLog(Base):
    __tablename__ = "oe_visit_logs"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id  = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    visit_date       = Column(Date, nullable=False)
    log_year         = Column(Integer, nullable=False)
    log_month        = Column(Integer, nullable=False)
    salesperson      = Column(String(100), nullable=True)
    contact_mode     = Column(String(30), nullable=True)
    oem              = Column(String(50), nullable=True)
    dealership       = Column(String(200), nullable=False)
    address          = Column(String(255), nullable=True)
    contact_person   = Column(String(150), nullable=True)
    contact_number   = Column(String(30), nullable=True)
    designation      = Column(String(100), nullable=True)
    # Dealer's own monthly figures (units) — aggregate as averages, never sums.
    car_sales        = Column(Numeric(12, 2), nullable=True)
    seat_cover_sales = Column(Numeric(12, 2), nullable=True)
    mats_sales       = Column(Numeric(12, 2), nullable=True)
    # Old single-blob remark (rows submitted before the visit-log form existed).
    # The 4 category columns below are separate, never merged into this one.
    remarks                 = Column(Text, nullable=True)
    remark_product_feedback = Column(Text, nullable=True)
    remark_replacement      = Column(Text, nullable=True)
    remark_sales             = Column(Text, nullable=True)
    remark_others            = Column(Text, nullable=True)
    channel          = Column(String(20), nullable=True)   # Arena/Nexa; MSIL only, else blank
    email            = Column(String(150), nullable=True)  # ASM's email, as submitted
    photo_link       = Column(Text, nullable=True)          # Drive link, when a photo was uploaded
    city             = Column(String(100), nullable=True)
    state            = Column(String(100), nullable=True)
    # 1-indexed sheet row (see services/oe_network_sync.py:parse_log_book) —
    # the sort tiebreaker for same-day rows, since `id` is a random UUID with
    # no relationship to the order rows appear in the sheet.
    sheet_row        = Column(Integer, nullable=True)
    sync_log_id      = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at       = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OETarget(Base):
    __tablename__ = "oe_targets"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    fy_year         = Column(Integer, nullable=False)   # FY start year: 2026 = FY26-27
    quarter         = Column(Integer, nullable=False)   # 1-4, Indian FY (Q1 = AMJ)
    period_year     = Column(Integer, nullable=False)
    period_month    = Column(Integer, nullable=False)
    oem             = Column(String(50), nullable=False)
    category        = Column(String(30), nullable=True)   # 'SC' | 'MAT' | 'ACC'
    # NULL = an OEM-level product line nobody owns. MSIL and TATA book
    # accessories as a single unattributed row inside their seat-cover block,
    # so it must never surface as a seventh salesperson.
    salesperson     = Column(String(100), nullable=True)
    region          = Column(String(100), nullable=True)
    tgt_nos         = Column(Numeric(14, 2), nullable=True)
    # Money is stored in RUPEES; the source mixes rupees and crores between tabs
    # under identical headers, so the scale is detected per block at sync and
    # recorded in value_scale.
    tgt_value       = Column(Numeric(18, 2), nullable=True)
    ach_nos         = Column(Numeric(14, 2), nullable=True)
    ach_value       = Column(Numeric(18, 2), nullable=True)
    value_scale     = Column(String(10), nullable=True)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class OEDealership(Base):
    """Master dealer list backing the visit-log form's dropdown
    (see migrate_phase13_oe_dealerships.sql). Unlike the other oe_* tables these
    rows are app-owned master data, not sheet-ingested, so there is no
    sheet_source_id. Uniqueness is (oem, state, UPPER(name)) — the same dealer
    name may legitimately exist in two states."""
    __tablename__ = "oe_dealerships"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    oem        = Column(String(50), nullable=False)
    state      = Column(String(100), nullable=False)
    city       = Column(String(100), nullable=True)
    name       = Column(String(200), nullable=False)
    source     = Column(String(20), nullable=False, default="form")   # 'seed' | 'form'
    added_by   = Column(String(150), nullable=True)
    is_active  = Column(Boolean, nullable=False, default=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class AsmPortalUser(Base):
    """Identity for the ASM self-service portal (see
    migrate_phase15_asm_portal.sql) — a separate, lightweight OTP-only login
    for field reps to view/export their own visit-log rows. Not a `User` row:
    no password, no role, no access outside their own salesperson's data."""
    __tablename__ = "asm_portal_users"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email       = Column(String(150), nullable=False, unique=True)
    salesperson = Column(String(100), nullable=False)
    is_active   = Column(Boolean, nullable=False, default=True)
    created_at  = Column(TIMESTAMP(timezone=True), server_default=func.now())


class AsmPortalOtp(Base):
    __tablename__ = "asm_portal_otps"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email      = Column(String(150), nullable=False)
    otp        = Column(String(6), nullable=False)
    expires_at = Column(TIMESTAMP(timezone=True), nullable=False)
    used_at    = Column(TIMESTAMP(timezone=True), nullable=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class UserModuleAccess(Base):
    __tablename__ = "user_module_access"

    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    module     = Column(String(50), nullable=False)
    granted_by = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    granted_at = Column(TIMESTAMP(timezone=True), server_default=func.now())


class UserSheetSourceAccess(Base):
    __tablename__ = "user_sheet_source_access"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id         = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    granted_by      = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    granted_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())


class BalanceSheetLine(Base):
    __tablename__ = "balance_sheet_lines"

    id              = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    tab_title       = Column(String(100), nullable=False)
    section         = Column(String(30), nullable=False)
    entity_type     = Column(String(20), nullable=False)
    item_no         = Column(Integer, nullable=True)
    line_key        = Column(String(80), nullable=False)
    line_label      = Column(String(150), nullable=False)
    parent_key      = Column(String(80), nullable=True)
    period_end_date = Column(Date, nullable=False)
    amount          = Column(Numeric(16, 2), nullable=False)
    percent         = Column(Float, nullable=True)
    sync_log_id     = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class ProfitLossLine(Base):
    __tablename__ = "profit_loss_lines"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id   = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    tab_title         = Column(String(100), nullable=False)
    section           = Column(String(30), nullable=False)
    entity_type       = Column(String(20), nullable=False)
    item_no           = Column(Integer, nullable=True)
    line_key          = Column(String(80), nullable=False)
    line_label        = Column(String(150), nullable=False)
    parent_key        = Column(String(80), nullable=True)
    period_start_date = Column(Date, nullable=False)
    period_end_date   = Column(Date, nullable=False)
    period_type       = Column(String(10), nullable=False)
    amount            = Column(Numeric(16, 2), nullable=False)
    percent           = Column(Float, nullable=True)
    sync_log_id       = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at        = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at        = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class FinanceLine(Base):
    """Finance v2 — one generic fact table for all 14 sheet sections
    (see migrate_phase9_finance_v2.sql). Supersedes BalanceSheetLine /
    ProfitLossLine, which are left mapped but unused."""
    __tablename__ = "finance_lines"

    id                = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sheet_source_id   = Column(UUID(as_uuid=True), ForeignKey("sheet_sources.id", ondelete="CASCADE"), nullable=False)
    tab_title         = Column(String(100), nullable=False)
    cadence           = Column(String(10), nullable=False)
    section_key       = Column(String(50), nullable=False)
    section_label     = Column(String(150), nullable=False)
    sub_section       = Column(String(50), nullable=True)
    entity_type       = Column(String(20), nullable=False)
    item_no           = Column(Integer, nullable=True)
    line_key          = Column(String(120), nullable=False)
    line_label        = Column(String(200), nullable=False)
    parent_key        = Column(String(120), nullable=True)
    period_start_date = Column(Date, nullable=False)
    period_end_date   = Column(Date, nullable=False)
    period_type       = Column(String(10), nullable=False)
    amount            = Column(Numeric(18, 2), nullable=True)
    percent           = Column(Float, nullable=True)
    metrics           = Column(JSONB, nullable=True)
    sync_log_id       = Column(UUID(as_uuid=True), ForeignKey("sync_logs.id", ondelete="SET NULL"), nullable=True)
    created_at        = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at        = Column(TIMESTAMP(timezone=True), server_default=func.now(), onupdate=func.now())


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    module        = Column(String(50), nullable=False, default="sales_plant_to_depot")
    source_label  = Column(String(255))
    rows_total    = Column(Integer, default=0)
    rows_inserted = Column(Integer, default=0)
    rows_updated  = Column(Integer, default=0)
    rows_failed   = Column(Integer, default=0)
    rows_deleted  = Column(Integer, default=0)
    status        = Column(String(30), default="Processing")
    error_details = Column(Text)
    synced_by     = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    synced_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())
