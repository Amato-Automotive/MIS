"""
AutoForm MIS — OE Network visit-log form (public).

Replaces the Google Form OEM salespeople used. Appends one row per submission to
the log-book responses sheet, in the exact column order the sheet already has, so
the existing OE Network sync (services/oe_network_sync.py) keeps reading it.

This endpoint is intentionally UNAUTHENTICATED — reps open a shared link, no login
— mirroring how the Google Form worked. The target sheet is set by
VISIT_LOG_SHEET_ID so the test sheet and the live sheet are a config swap, never a
code change.

Photo upload (sheet column L) is deferred to a later phase; this writes text only.
"""
import os
import smtplib
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, File
from googleapiclient.errors import HttpError
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from services.dealer_resolve import canon_city
from services.google_sheets import get_sheets_service_rw, upload_photo_to_folder

router = APIRouter(prefix="/visit-log", tags=["OE Visit Log"])

IST = ZoneInfo("Asia/Kolkata")

# The response tab. Google Forms names it "Form responses 1"; kept configurable
# in case a copy renames it.
SHEET_TAB = os.getenv("VISIT_LOG_SHEET_TAB", "Form responses 1")

# Sheet columns A..V, in order. Each entry is how that column's value is produced
# from the submitted form. "" = leave blank (Timestamp is filled at write time;
# S/U/V are stray/derived columns the Form left to Sheets).
# NOTE: a "Channel" column was inserted at O, shifting Salesperson..onward right
# by one — the order below matches the sheet's current 22-column header exactly.
#   A Timestamp                 -> set here
#   B Visit Date / Calling Date -> visit_date (DD/MM/YYYY, matching existing rows)
#   C Dealership Name           -> dealership
#   D Dealership Address        -> address
#   E Contact Person            -> contact_person
#   F Contact No.               -> contact_number
#   G Designation               -> designation
#   H Monthly Car Sales         -> car_sales
#   I Monthly Seat Covers Sales -> seat_cover_sales
#   J Monthly Mats Sales        -> mats_sales
#   K Remarks                   -> remarks (already combined on the client)
#   L Upload Photo              -> "" (images: later phase)
#   M Email address             -> email
#   N OEM                       -> oem
#   O Channel                   -> channel (Arena/Nexa; MSIL only, else blank)
#   P Sales Person's Name       -> salesperson
#   Q Visit / Calling           -> contact_mode
#   R City                      -> city
#   S State                     -> state
#   T Dealers Name              -> "" (empty; confirmed unused)
#   U Column 18                 -> ""
#   V Column 1                  -> month abbrev (existing rows carry e.g. "Jul")


def _fmt_date_ddmmyyyy(iso: str) -> str:
    """The form sends YYYY-MM-DD; the sheet's existing rows are DD/MM/YYYY."""
    try:
        d = datetime.strptime(iso, "%Y-%m-%d")
    except (ValueError, TypeError):
        return iso  # pass through anything unexpected rather than dropping it
    return d.strftime("%d/%m/%Y")


def _send_confirmation_email(
    to_email: str, salesperson: str, fields: list[tuple[str, str]], link_labels: set[str] = frozenset()
) -> None:
    """Mirrors the Google Form's "send respondents a copy" — the rep gets an
    email of what they just submitted. Best-effort only: called after the
    sheet write already succeeded, and a failure here must never fail the
    submission or be retried into a duplicate sheet row.

    Uses its own mailbox (VISIT_LOG_EMAIL_*) rather than the auth OTP one
    (EMAIL_*, see routers/auth.py) — different sender identity and quota, and
    a suspended/rate-limited field-rep mailbox shouldn't be able to affect
    password-reset delivery, or vice versa.
    """
    smtp_user = os.getenv("VISIT_LOG_EMAIL_USER", "")
    smtp_pass = os.getenv("VISIT_LOG_EMAIL_PASS", "")
    smtp_from = os.getenv("VISIT_LOG_EMAIL_FROM", smtp_user)
    if not smtp_user or not smtp_pass:
        return

    def _cell(label: str, value: str) -> str:
        if label in link_labels:
            return f'<a href="{value}" style="color:#f46617;text-decoration:underline;">View photo</a>'
        return value

    rows_html = "".join(
        f'<tr><td style="padding:6px 12px;color:#9ca3af;font-size:12px;font-weight:700;'
        f'text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap;vertical-align:top;">{label}</td>'
        f'<td style="padding:6px 12px;color:#374151;font-size:14px;">{_cell(label, value)}</td></tr>'
        for label, value in fields if value
    )

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Amato Automotive OEM Log Book Response"
    msg["From"] = f"Amato Automotive MIS <{smtp_from}>"
    msg["To"] = to_email

    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:#111827;padding:28px 32px;">
        <p style="color:#fff;font-size:11px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin:0;">Amato Automotive OEM Log Book Response</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#374151;font-size:15px;margin:0 0 8px;">Hi {salesperson},</p>
        <p style="color:#6b7280;font-size:14px;line-height:1.6;margin:0 0 20px;">
          Your visit log entry has been recorded. Here's a copy of what you submitted:
        </p>
        <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:10px;overflow:hidden;">
          {rows_html}
        </table>
      </div>
      <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
        <p style="color:#9ca3af;font-size:11px;margin:0;">© {datetime.now().year} Amato Automotive · This is an automated message, please do not reply.</p>
      </div>
    </div>
    """
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP("smtp.gmail.com", 587) as server:
        server.starttls()
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_from, to_email, msg.as_string())


@router.post("/submit")
def submit_visit_log(
    salesperson: str = Form(...),
    email: str = Form(""),
    oem: str = Form(...),
    contact_mode: str = Form(...),
    visit_date: str = Form(...),
    state: str = Form(...),
    city: str = Form(...),
    dealership: str = Form(...),
    address: str = Form(""),
    contact_person: str = Form(""),
    contact_number: str = Form(""),
    designation: str = Form(""),
    car_sales: str = Form(""),
    seat_cover_sales: str = Form(""),
    mats_sales: str = Form(""),
    channel: str = Form(""),
    # Each remark category has its own sheet column (L-O); the form sends one
    # field per category. Keys match the frontend's remarkKey().
    remark_product_feedback: str = Form(""),
    remark_replacement: str = Form(""),
    remark_sales: str = Form(""),
    remark_others: str = Form(""),
    photo: UploadFile | None = File(None),
    # Two free-standing photos (a complaint, a damaged product…). Optional and
    # not tied to Visit/Calling or any remark — they go to their own columns.
    extra_photo_1: UploadFile | None = File(None),
    extra_photo_2: UploadFile | None = File(None),
):
    # The form already strips accents; this also covers a stale cached copy.
    city = canon_city(city)
    sheet_id = os.getenv("VISIT_LOG_SHEET_ID")
    if not sheet_id:
        raise HTTPException(status_code=503, detail="VISIT_LOG_SHEET_ID is not configured.")

    now = datetime.now(IST)
    timestamp = now.strftime("%d/%m/%Y %H:%M:%S")
    month_abbr = now.strftime("%b")  # matches "Jul" seen in existing rows

    # Photo → Drive (column L). Gated by VISIT_LOG_PHOTOS_ENABLED, which stays off
    # until a Workspace admin authorizes domain-wide delegation (see
    # DRIVE_DELEGATION_SETUP.md) — a service account can't own files in My Drive on
    # its own. While off, the row is still saved with column L blank rather than
    # failing the whole submission; once on, an upload error surfaces to the rep.
    photos_enabled = (os.getenv("VISIT_LOG_PHOTOS_ENABLED", "").lower() in ("1", "true", "yes"))
    safe_person = (salesperson or "unknown").replace("/", "-").strip()

    def upload(f: UploadFile | None, tag: str) -> str:
        if not (photos_enabled and f is not None and f.filename):
            return ""
        folder_id = os.getenv("VISIT_LOG_DRIVE_FOLDER_ID")
        if not folder_id:
            raise HTTPException(status_code=503, detail="VISIT_LOG_DRIVE_FOLDER_ID is not configured.")
        try:
            fname = f"{now.strftime('%Y%m%d_%H%M%S')}_{safe_person}{tag}_{f.filename}"
            return upload_photo_to_folder(f.file.read(), fname, f.content_type or "", folder_id)
        except HttpError as e:
            raise HTTPException(status_code=502, detail=f"Could not upload the photo: {e}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Photo upload failed: {e}")

    photo_link = upload(photo, "")
    extra_link_1 = upload(extra_photo_1, "_extra1")
    extra_link_2 = upload(extra_photo_2, "_extra2")

    # A..Z, matching the LIVE log-book header order exactly (26 columns). Each
    # remark category has its own column (L-O); the generic "Remarks" column (K)
    # is left blank now that categories are split out. "Total Car Sales / Total
    # Seat Covers" wording differs from the form's labels but positions match.
    row = [
        timestamp,                       # A Timestamp
        _fmt_date_ddmmyyyy(visit_date),  # B Visit Date / Calling Date
        dealership,                      # C Dealership Name
        address,                         # D Dealership Address
        contact_person,                  # E Contact Person
        contact_number,                  # F Contact No.
        designation,                     # G Designation
        car_sales,                       # H Total Car Sales
        seat_cover_sales,                # I Total Seat Covers Sales
        mats_sales,                      # J Mats Sales
        "",                              # K Remarks (unused; split into L-O)
        remark_product_feedback,         # L Product Feedback
        remark_replacement,              # M Replacement
        remark_sales,                    # N Sales
        remark_others,                   # O Others
        photo_link,                      # P Upload Photo (Drive link, or "")
        email,                           # Q Email address
        oem,                             # R OEM
        channel,                         # S Channel (Arena/Nexa; blank if not MSIL)
        salesperson,                     # T Sales Person's Name
        contact_mode,                    # U Visit / Calling
        city,                            # V City
        state,                           # W State
        month_abbr,                      # X Column 1 (month abbrev, e.g. "Jul")
        extra_link_1,                    # Y Additional Photo 1 (Drive link, or "")
        extra_link_2,                    # Z Additional Photo 2 (Drive link, or "")
    ]

    try:
        svc = get_sheets_service_rw()
        svc.spreadsheets().values().append(
            spreadsheetId=sheet_id,
            range=f"'{SHEET_TAB}'!A1",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [row]},
        ).execute()
    except HttpError as e:
        # 403 here almost always means the service account lacks Editor access.
        raise HTTPException(status_code=502, detail=f"Could not write to the sheet: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Submit failed: {e}")

    # Confirmation email — mirrors the Google Form's "send respondents a copy".
    # Best-effort: the sheet row is already saved, so a mail failure here must
    # not surface as a submit failure or invite a retry that double-writes the sheet.
    if email:
        try:
            _send_confirmation_email(email, salesperson, [
                ("OEM", oem),
                ("Dealership", dealership),
                ("Address", address),
                ("City", city),
                ("State", state),
                ("Contact Person", contact_person),
                ("Contact Number", contact_number),
                ("Designation", designation),
                ("Visit / Calling", contact_mode),
                ("Visit Date", _fmt_date_ddmmyyyy(visit_date)),
                ("Channel", channel),
                ("Total Car Sales", car_sales),
                ("Total Seat Covers Sales", seat_cover_sales),
                ("Mats Sales", mats_sales),
                ("Product Feedback", remark_product_feedback),
                ("Replacement", remark_replacement),
                ("Sales", remark_sales),
                ("Others", remark_others),
                ("Photo", photo_link),
                ("Additional Photo 1", extra_link_1),
                ("Additional Photo 2", extra_link_2),
            ], link_labels={"Photo", "Additional Photo 1", "Additional Photo 2"})
        except Exception:
            pass  # confirmation email is a courtesy, not a requirement

    return {"status": "ok"}


# ─────────────────────────── Dealership master list ───────────────────────────
# Backs the form's dealership dropdown, which used to be a hardcoded constant in
# the frontend. Both routes are public for the same reason /submit is: reps open
# a shared link with no login. Adding a dealer only affects this dropdown — it
# never touches the log-book sheet, which is still written only by /submit.

def _clean(s: str) -> str:
    """Collapse internal whitespace and trim. Field entries arrive with stray
    spaces and inconsistent casing far more often than the seeded rows did."""
    return " ".join((s or "").split())


@router.get("/dealerships")
def list_dealerships(db: Session = Depends(get_db)):
    """Every active dealer, shaped as {OEM: {State: [{name, city}]}}.

    City rides along because a dealer group can hold several outlets and the
    city is what tells them apart — PREM MOTORS Narela and PREM MOTORS Wazirpur
    are two dealers. The form shows "NAME — CITY" for those and fills its own
    City field from whichever the rep picks, so the two can never disagree.

    `city` is "" for the OEMs whose dealer files have not arrived yet (TATA,
    HYUNDAI, KIA, MAHINDRA). The form falls back to letting the rep pick a city
    for those, exactly as it did before.
    """
    rows = db.execute(text("""
        SELECT oem, state, name, COALESCE(city, '') AS city
        FROM oe_dealerships
        WHERE is_active
        ORDER BY oem, state, name, city
    """)).fetchall()

    by_oem: dict[str, dict[str, list[dict]]] = {}
    for r in rows:
        by_oem.setdefault(r.oem, {}).setdefault(r.state, []).append(
            {"name": r.name, "city": r.city})
    return by_oem


@router.post("/dealerships")
def add_dealership(
    oem: str = Form(...),
    state: str = Form(...),
    name: str = Form(...),
    city: str = Form(""),
    added_by: str = Form(""),
    db: Session = Depends(get_db),
):
    """Add one dealer from the form's inline "+ Add new dealership" panel.

    Three outcomes, in this order, so that adding a dealer can never split one
    outlet into two rows:

      1. the exact outlet (oem, state, name, city) is already there → return it,
         so a rep who double-taps just proceeds with their visit log;
      2. the name is there with NO city yet → fill the city in. This is how the
         OEMs without a dealer file learn their cities: from the reps, one
         submission at a time, instead of gaining a duplicate row alongside the
         city-less one;
      3. otherwise it is a genuinely new outlet → insert it.
    """
    oem, state, name, city = _clean(oem), _clean(state), _clean(name), canon_city(city)
    if not oem or not state or not name:
        raise HTTPException(status_code=422, detail="OEM, state and dealership name are required.")

    try:
        exact = db.execute(text("""
            SELECT id FROM oe_dealerships
            WHERE oem = :oem AND state = :state AND UPPER(name) = UPPER(:name)
              AND UPPER(COALESCE(city, '')) = UPPER(:city)
        """), {"oem": oem, "state": state, "name": name, "city": city}).fetchone()
        if exact:
            return {"status": "ok", "name": name, "city": city, "oem": oem,
                    "state": state, "already_exists": True}

        if city:
            filled = db.execute(text("""
                UPDATE oe_dealerships
                   SET city = :city, updated_at = NOW()
                 WHERE oem = :oem AND state = :state AND UPPER(name) = UPPER(:name)
                   AND COALESCE(city, '') = ''
                RETURNING id
            """), {"oem": oem, "state": state, "name": name, "city": city}).fetchone()
            if filled:
                db.commit()
                return {"status": "ok", "name": name, "city": city, "oem": oem,
                        "state": state, "already_exists": True}

        # Matches idx_oe_dealerships_unique_v2 exactly (see
        # migrate_phase21_oe_dealer_products.sql) — that index's key is 5
        # expressions including dealer_code, so the ON CONFLICT target must name
        # all 5 or Postgres has no arbiter to match against. Reps never supply a
        # dealer_code (that's populated only by the OEM dealer-file sync), so it
        # is always NULL here, i.e. '' under the index's COALESCE.
        db.execute(text("""
            INSERT INTO oe_dealerships (oem, state, city, name, source, added_by)
            VALUES (:oem, :state, NULLIF(:city, ''), :name, 'form', NULLIF(:added_by, ''))
            ON CONFLICT (oem, state, UPPER(name), UPPER(COALESCE(city, '')), UPPER(COALESCE(dealer_code, '')))
            DO NOTHING
        """), {"oem": oem, "state": state, "city": city,
               "name": name, "added_by": _clean(added_by)})
        db.commit()
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"Could not save the dealership: {e}")

    return {"status": "ok", "name": name, "city": city, "oem": oem,
            "state": state, "already_exists": False}
