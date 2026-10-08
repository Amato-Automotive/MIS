"""
Sync the Export leads sheet — the same run as the Sync button, for cron.

Stage history is dated to the sync that SEES a change, so how often the sheet
is synced is how accurate every "moved on <date>" and time-in-stage figure is.
Left to the button, a lead that moved on Monday and was next synced on Friday
is recorded as moving on Friday. Run nightly on the VPS and the error is at
most a day:

    # crontab -e  (as deploy)  — 23:30 IST = 18:00 UTC
    0 18 * * * cd /home/deploy/MIS/backend && venv/bin/python -m scripts.sync_export >> /home/deploy/logs/export_sync.log 2>&1

Exit code 0 on success (including "nothing registered"), 1 on a failed sync,
so cron mail / log watchers can tell the two apart.
"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from fastapi import HTTPException  # noqa: E402

from database import SessionLocal  # noqa: E402
from routers.export import _source, run_sync  # noqa: E402


def main() -> int:
    stamp = datetime.now().isoformat(timespec="seconds")
    db = SessionLocal()
    try:
        source = _source(db)
        if source is None:
            print(f"{stamp} export: no sheet registered — nothing to do")
            return 0
        out = run_sync(db, source, None)
        print(f"{stamp} export: {out['rows_inserted']} leads, {out['activities']} activities, "
              f"{out['changes']} changes, {out['baseline']} baseline, "
              f"{len(out['warnings'])} warnings")
        return 0
    except HTTPException as e:
        print(f"{stamp} export: FAILED ({e.status_code}) {e.detail}")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
