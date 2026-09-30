from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from routers import auth, leads, users, sales, distributor_sales, finance, sheets, oe_network, oe_targets, oe_oem_targets, visit_log, asm_portal, export

load_dotenv()

app = FastAPI(
    title="Amato Automotive MIS API",
    description="Management Information System — Amato Automotive",
    version="2.0.0"
)

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:5173",
        "https://mis.amatoautomotive.co.in",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(leads.router)
app.include_router(users.router)
app.include_router(sales.router)
app.include_router(distributor_sales.router)
app.include_router(finance.router)
app.include_router(sheets.router)
app.include_router(oe_network.router)
app.include_router(oe_targets.router)
app.include_router(oe_oem_targets.router)
app.include_router(export.router)
app.include_router(visit_log.router)  # public — no auth (shared form link)
app.include_router(asm_portal.router)  # public — OTP-only, scoped to caller's own salesperson

# ── Health ────────────────────────────────────────────────────────────────────
@app.get("/", tags=["Health"])
def root():
    return {"status": "ok", "app": "Amato Automotive MIS API", "version": "2.0.0"}

@app.get("/health", tags=["Health"])
def health():
    return {"status": "healthy"}
