"""
Clean up the leads table after the upload-append bug.

Until the upload became an upsert, every re-upload of a monthly IVR/WhatsApp
sheet appended all of its rows again, so leads were counted two, three, four
times and a lead whose status later moved Follow Up -> Closed Won existed once
under each status. This script:

  1. re-normalises mobile numbers to the parser's current form
     (lead_parser._parse_mobile: "+91 98765 43210" -> "9876543210");
  2. groups leads by the upload's identity key (routers.leads.lead_key:
     date + channel + mobile, or name when there is no mobile);
  3. in each group keeps the row written by the most recent upload (that copy
     carries the latest statuses) and deletes the rest.

Dates swapped by the old day-first bug (an ISO "2026-11-06" stored as 6 Jun)
cannot be detected from the table alone; re-upload the affected sheets after
this cleanup and they land on the right day.

    python -m scripts.dedupe_leads            # dry run, report only
    python -m scripts.dedupe_leads --apply    # normalise + delete, one transaction
"""
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from database import SessionLocal  # noqa: E402
from models import Lead, UploadLog  # noqa: E402
from routers.leads import lead_key  # noqa: E402
from services.lead_parser import _parse_mobile  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()

    db = SessionLocal()
    try:
        upload_time = {u.id: u.uploaded_at for u in db.query(UploadLog.id, UploadLog.uploaded_at)}
        leads = db.query(Lead).all()

        renormalised = 0
        for lead in leads:
            norm = _parse_mobile(lead.mobile_number)
            if norm != lead.mobile_number:
                lead.mobile_number = norm  # type: ignore[assignment]
                renormalised += 1

        groups: dict[tuple, list[Lead]] = defaultdict(list)
        for lead in leads:
            groups[lead_key(str(lead.lead_date), lead.source, lead.mobile_number, lead.customer_name)].append(lead)

        def recency(lead: Lead):
            t = upload_time.get(lead.upload_log_id)  # type: ignore[arg-type]
            return (t is not None, t or lead.created_at, lead.created_at)

        to_delete: list[Lead] = []
        by_month: dict[str, int] = defaultdict(int)
        for rows in groups.values():
            if len(rows) < 2:
                continue
            rows.sort(key=recency, reverse=True)
            for dup in rows[1:]:
                to_delete.append(dup)
                by_month[str(dup.lead_date)[:7]] += 1

        print(f"Leads in table:            {len(leads)}")
        print(f"Mobiles to re-normalise:   {renormalised}")
        print(f"Duplicate rows to delete:  {len(to_delete)}")
        print(f"Leads after cleanup:       {len(leads) - len(to_delete)}")
        for month in sorted(by_month):
            print(f"  {month}: -{by_month[month]}")

        if not args.apply:
            db.rollback()
            print("\nDry run — nothing written. Re-run with --apply to commit.")
            return

        for dup in to_delete:
            db.delete(dup)
        db.commit()
        print("\nApplied.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
