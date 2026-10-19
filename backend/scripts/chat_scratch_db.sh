#!/usr/bin/env bash
# A throwaway Postgres with prod's schema, for tests/test_chat_rls.py.
#
# The chatbot's security lives in row-level security policies, so the only real
# test is a real database. This builds one from scratch by replaying every
# migration in the order prod received them — never touch prod (or the 5433
# tunnel to it) for this; the test seeds and deletes rows.
#
#   PG_BIN="/c/Program Files/PostgreSQL/18/bin" bash backend/scripts/chat_scratch_db.sh   # Windows / Git Bash
#   PG_BIN=/usr/lib/postgresql/18/bin bash backend/scripts/chat_scratch_db.sh             # Linux
#
# Then:
#   export CHAT_TEST_DSN="postgresql+psycopg://mis_user:x@localhost:55432/autoform_mis"
#   export CHAT_TEST_CHATBOT_DSN="postgresql+psycopg://mis_chatbot:chatpw@localhost:55432/autoform_mis"
#   backend/venv/Scripts/python.exe -m pytest backend/tests -q      # RLS tests now run instead of skipping
#
# Stop it:  "$PG_BIN/pg_ctl" -D "$DATA" stop
#
# When you add a migration, add it to the lists below in prod's order.
set -euo pipefail
PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
PORT="${PORT:-55432}"
DATA="${DATA:-${TMPDIR:-/tmp}/mis_chat_scratch_pg}"
B="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$DATA" ]; then
  "$PG_BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 >/dev/null
fi
# Run this script directly, not piped into `tail`/`head`: on Windows the server
# inherits the pipe and the reader then waits for it forever.
"$PG_BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1 || \
  "$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=localhost" -l "$DATA/log.txt" -w start

as_pg()  { "$PG_BIN/psql" -h localhost -p "$PORT" -v ON_ERROR_STOP=1 -q -U postgres -d "$1" "${@:2}"; }
as_app() { "$PG_BIN/psql" -h localhost -p "$PORT" -v ON_ERROR_STOP=1 -q -U mis_user -d autoform_mis "$@"; }
run_app() { echo "  $1"; as_app -f "$B/$1" >/dev/null 2>&1 || { as_app -f "$B/$1"; exit 1; }; }

as_pg postgres -c "DROP DATABASE IF EXISTS autoform_mis" -c "DROP ROLE IF EXISTS mis_chatbot" \
  -c "DROP ROLE IF EXISTS mis_user" -c "CREATE ROLE mis_user LOGIN PASSWORD 'x'" \
  -c "CREATE DATABASE autoform_mis OWNER mis_user"
as_pg autoform_mis -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'

echo "Replaying migrations:"
run_app schema.sql
for m in phase3 phase4_sales phase4b_sales_deleted phase5_distributor_sales \
         phase5b_distributor_sales_totals phase6_ptd_multi_sheet phase7_permissions \
         phase8_finance phase9_dd_quarter phase9_finance_v2 phase10_finance_masters \
         phase10_ptd_fy phase11_oe_network phase12_oe_targets phase13_oe_dealerships \
         phase14_oe_visit_log_row_order phase15_asm_portal phase16_oe_visit_log_full_columns \
         phase17_sync_log_retention; do run_app "migrate_$m.sql"; done
# On prod and in models.py, but in no migration (added by hand for password reset).
as_app -c "ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_otp VARCHAR(6), ADD COLUMN IF NOT EXISTS reset_otp_expires_at TIMESTAMPTZ"
# Phase 18 creates a role, so it needs a superuser — as it did on prod.
echo "  migrate_phase18_chatbot.sql (as postgres)"
sed "s/__CHANGE_ME__/chatpw/" "$B/migrate_phase18_chatbot.sql" | as_pg autoform_mis >/dev/null 2>&1
for m in phase18_oe_dealer_outlets phase19_oe_target_accessories phase20_ysasc phase20b_ysasc_contract \
         phase21_oe_dealer_products phase22_oe_dealer_target_precision phase23_oe_salesperson_scope \
         phase24_oe_oem_targets phase26_export_leads phase27_export_history_activity \
         phase28_export_target_close phase25_chatbot_scope; do run_app "migrate_$m.sql"; done
echo "Scratch database ready on localhost:$PORT (data in $DATA)."
