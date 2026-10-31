"""
Firm Expense Manager  —  projects, partners, split payments, audit, backups.
Flask + MongoDB (PyMongo). Single-file backend.

Run:
    pip install -r requirements.txt
    python app.py

Default login (you must change the password on first sign-in):
    username: admin      password: Admin@12345
"""

import csv
import io
import json
import logging
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import Flask, Response, abort, g, jsonify, redirect, render_template, request, send_file, session, url_for
from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError
from werkzeug.security import check_password_hash, generate_password_hash

import seed_data

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def build_mongo_uri():
    """MONGODB_URI, else MONGODB_USERNAME + MONGODB_PASSWORD (Atlas), else local MongoDB."""
    from urllib.parse import quote_plus
    full = os.environ.get("MONGODB_URI") or os.environ.get("EM_MONGO_URI")
    if full:
        return full
    user, pwd = os.environ.get("MONGODB_USERNAME"), os.environ.get("MONGODB_PASSWORD")
    host = os.environ.get("MONGODB_HOST", "expensemanager.exoz8sx.mongodb.net")
    if user and pwd:
        return f"mongodb+srv://{quote_plus(user)}:{quote_plus(pwd)}@{host}/?retryWrites=true&w=majority&appName=ExpenseManager"
    return "mongodb://localhost:27017"


CONFIG = {
    "MONGO_URI": build_mongo_uri(),
    "DB_NAME": os.environ.get("EM_DB_NAME", "restaurant_expense_manager"),
    "SECRET_KEY": os.environ.get("EM_SECRET_KEY", "change-this-secret-key-before-going-live"),
    "FIRM_NAME": os.environ.get("EM_FIRM_NAME", "Our Firm"),
    "SESSION_IDLE_MINUTES": 30,
    "SESSION_ABSOLUTE_HOURS": 12,
    "MAX_LOGIN_ATTEMPTS": 5,
    "LOCKOUT_MINUTES": 15,
    "BACKUP_DIR": os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups"),
    "BACKUP_ON_CHANGE": True,        # write a backup after every change
    "BACKUP_DEBOUNCE_SECONDS": 3,    # group rapid changes into one write
    "BACKUP_COPIES": 3,              # identical copies kept in backups/copy_1, copy_2, copy_3
    "BACKUP_HISTORY_DAYS": 30,       # one dated copy per day kept in backups/history/
    "BACKUP_INTERVAL_HOURS": 24,     # make sure a daily history copy exists even with no changes
    "SECURE_COOKIES": os.environ.get("EM_SECURE_COOKIES", "0") == "1",
    "DEFAULT_ADMIN": {"username": "admin", "password": "Admin@12345", "full_name": "Administrator"},
    "CURRENCY": "INR",
    "IMPORT_SEED_LEDGER": True,   # import seed_data.py on first run (empty database)
}

ROLES = ["admin", "editor", "viewer"]
ROLE_PERMISSIONS = {
    "admin": {"*"},
    "editor": {"expense:view", "expense:create", "expense:edit", "expense:view_deleted", "category:view", "category:manage",
               "export", "audit:view", "dashboard:customize", "backup:create"},
    "viewer": {"expense:view", "category:view", "export", "dashboard:customize"},
}

PAYMENT_METHODS = ["Cash", "UPI", "Bank Transfer", "Card", "Cheque", "Other"]
PAYMENT_STATUSES = ["Paid", "Pending", "Partially Paid", "Reimbursed"]
EXPENSE_TYPES = ["Setup", "Operational", "Capital", "Recurring", "One-time"]

# Fields on the expense form that each project can switch on/off or make required.
OPTIONAL_FIELDS = [
    ("vendor", "Vendor / payee"), ("payment_method", "Payment method"), ("payment_reference", "Payment reference"),
    ("payment_status", "Payment status"), ("notes", "Notes"), ("receipt_reference", "Receipt / invoice reference"),
    ("expense_type", "Expense type"), ("project_phase", "Phase"),
]
DEFAULT_FIELD_CONFIG = {k: {"enabled": k in ("vendor", "payment_method", "notes"), "required": False} for k, _ in OPTIONAL_FIELDS}
CUSTOM_FIELD_TYPES = ["text", "number", "date", "select"]

DASHBOARD_WIDGETS = [
    {"id": "total_expenses", "name": "Total expenses", "size": "small"},
    {"id": "transaction_count", "name": "Number of expenses", "size": "small"},
    {"id": "average_expense", "name": "Average per expense", "size": "small"},
    {"id": "largest_expense", "name": "Largest single expense", "size": "small"},
    {"id": "partner_summary", "name": "Partner contributions", "size": "large"},
    {"id": "monthly_trend", "name": "Expense trend", "size": "large"},
    {"id": "by_category", "name": "Spend by category", "size": "large"},
    {"id": "by_subcategory", "name": "Spend by subcategory", "size": "medium"},
    {"id": "by_partner_chart", "name": "Who paid (chart)", "size": "medium"},
    {"id": "by_payment_method", "name": "Payment methods", "size": "medium"},
    {"id": "top_vendors", "name": "Top vendors", "size": "medium"},
    {"id": "recent_transactions", "name": "Recent expenses", "size": "large"},
]
DEFAULT_LAYOUT = ["total_expenses", "transaction_count", "average_expense", "largest_expense", "partner_summary",
                  "monthly_trend", "by_category", "by_partner_chart", "by_subcategory", "recent_transactions"]

# ---------------------------------------------------------------------------
# App and database
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("expense-manager")

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.update(
    SECRET_KEY=CONFIG["SECRET_KEY"], SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=CONFIG["SECURE_COOKIES"], PERMANENT_SESSION_LIFETIME=timedelta(hours=CONFIG["SESSION_ABSOLUTE_HOURS"]),
    MAX_CONTENT_LENGTH=25 * 1024 * 1024, JSON_SORT_KEYS=False,
)

client = MongoClient(CONFIG["MONGO_URI"], serverSelectionTimeoutMS=10000)
db = client[CONFIG["DB_NAME"]]
users_col = db["users"]
projects_col = db["projects"]
expenses_col = db["expenses"]
categories_col = db["categories"]
revisions_col = db["expense_revisions"]
audit_col = db["audit_logs"]
prefs_col = db["dashboard_preferences"]
filters_col = db["saved_filters"]
backup_logs_col = db["backup_logs"]
counters_col = db["counters"]
idempotency_col = db["idempotency_keys"]

_login_attempts = {}
_login_lock = threading.Lock()


def utcnow():
    return datetime.now(timezone.utc)


def check_database_connection():
    try:
        client.admin.command("ping")
        log.info("Connected to MongoDB (database '%s')", CONFIG["DB_NAME"])
    except Exception as exc:
        raise SystemExit("Could not connect to MongoDB: %s\nCheck MONGODB_USERNAME / MONGODB_PASSWORD (or MONGODB_URI) "
                         "and that your IP is allowed in Atlas → Network Access." % exc)


def ensure_indexes():
    users_col.create_index([("username", ASCENDING)], unique=True)
    expenses_col.create_index([("expense_id", ASCENDING)], unique=True)
    expenses_col.create_index([("project_id", ASCENDING), ("status", ASCENDING), ("transaction_date", DESCENDING)])
    expenses_col.create_index([("project_id", ASCENDING), ("category_id", ASCENDING), ("subcategory_id", ASCENDING)])
    expenses_col.create_index([("payments.partner_id", ASCENDING)])
    expenses_col.create_index([("vendor", ASCENDING)])
    expenses_col.create_index([("amount", ASCENDING)])
    categories_col.create_index([("project_id", ASCENDING), ("parent_id", ASCENDING), ("name", ASCENDING)])
    revisions_col.create_index([("expense_id", ASCENDING), ("revision", ASCENDING)])
    audit_col.create_index([("at", DESCENDING)])
    audit_col.create_index([("entity_id", ASCENDING)])
    audit_col.create_index([("project_id", ASCENDING), ("at", DESCENDING)])
    for stale in ("user_id_1",):
        try:
            if stale in prefs_col.index_information():
                prefs_col.drop_index(stale)
        except Exception as exc:  # index may not exist on a fresh database
            log.debug("Index cleanup skipped: %s", exc)
    prefs_col.create_index([("user_id", ASCENDING), ("project_id", ASCENDING)], unique=True)
    filters_col.create_index([("user_id", ASCENDING)])
    idempotency_col.create_index([("created_at", ASCENDING)], expireAfterSeconds=86400)
    idempotency_col.create_index([("key", ASCENDING), ("user_id", ASCENDING)], unique=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def serialize(doc):
    if isinstance(doc, list):
        return [serialize(d) for d in doc]
    if isinstance(doc, dict):
        out = {}
        for k, v in doc.items():
            if k == "_id":
                out["id"] = str(v)
            elif k == "password_hash":
                continue
            else:
                out[k] = serialize(v)
        return out
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, datetime):
        if doc.tzinfo is None:
            doc = doc.replace(tzinfo=timezone.utc)
        return doc.isoformat()
    return doc


def to_oid(value):
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def parse_date(value, end_of_day=False):
    if not value:
        return None
    value = str(value).strip()
    try:
        if re.fullmatch(r"\d{1,2}-\d{1,2}-\d{4}", value):
            d = datetime.strptime(value, "%d-%m-%Y")
        elif len(value) == 10:
            d = datetime.strptime(value, "%Y-%m-%d")
        else:
            d = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if d.tzinfo:
                d = d.astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        return None
    if end_of_day:
        d = d.replace(hour=23, minute=59, second=59, microsecond=999000)
    return d.replace(tzinfo=timezone.utc)


def parse_amount(value, allow_zero=False):
    try:
        amount = round(float(str(value).replace(",", "").strip() or 0), 2)
    except (TypeError, ValueError):
        return None
    if amount < 0 or (amount == 0 and not allow_zero) or amount > 1_000_000_000:
        return None
    return amount


def clean_str(value, max_len=500):
    return "" if value is None else str(value).strip()[:max_len]


def next_expense_id():
    year = utcnow().year
    counter = counters_col.find_one_and_update({"_id": f"expense_{year}"}, {"$inc": {"seq": 1}}, upsert=True,
                                               return_document=ReturnDocument.AFTER)
    return f"EXP-{year}-{counter['seq']:05d}"


def json_error(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status


def client_ip():
    fwd = request.headers.get("X-Forwarded-For", "")
    return fwd.split(",")[0].strip() if fwd else (request.remote_addr or "unknown")


def has_permission(user, perm):
    perms = ROLE_PERMISSIONS.get(user.get("role"), set())
    return "*" in perms or perm in perms


def validate_password(password):
    if not password or len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[A-Z]", password) or not re.search(r"[a-z]", password) or not re.search(r"[0-9]", password):
        return "Password needs an uppercase letter, a lowercase letter and a number."
    return None


def user_display(user):
    return user.get("full_name") or user.get("username")


DATA_CHANGING_ACTIONS = {
    "expense_created", "expense_edited", "expense_deleted", "expense_restored", "expense_purged",
    "category_created", "category_updated", "category_archived", "category_restored",
    "project_created", "project_updated", "partners_updated", "fields_updated",
    "user_created", "user_updated", "password_changed", "backup_restored", "custom_report_saved", "custom_report_deleted",
}
LOGIN_ACTIONS = ["login", "login_failed", "logout", "password_changed", "permission_denied"]


def record_audit(action, entity_type, entity_id, details=None, user=None, project_id=None):
    user = user or getattr(g, "user", None)
    audit_col.insert_one({
        "action": action, "entity_type": entity_type, "entity_id": str(entity_id) if entity_id is not None else None,
        "project_id": project_id or getattr(g, "project_id", None),
        "user_id": str(user["_id"]) if user else None, "user_name": user_display(user) if user else "system",
        "at": utcnow(), "ip": client_ip() if request else None, "details": details or {},
    })
    if action in DATA_CHANGING_ACTIONS:
        request_backup(action)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def current_user():
    oid = to_oid(session.get("user_id"))
    if not oid:
        return None
    user = users_col.find_one({"_id": oid})
    if not user or not user.get("active", False) or user.get("session_version", 1) != session.get("session_version"):
        return None
    return user


@app.before_request
def load_user():
    g.user = None
    g.project_id = None
    if request.path.startswith("/static/"):
        return None
    if session.get("user_id"):
        last = session.get("last_active")
        if not last or utcnow() - datetime.fromisoformat(last) > timedelta(minutes=CONFIG["SESSION_IDLE_MINUTES"]):
            session.clear()
        else:
            g.user = current_user()
            if g.user:
                session["last_active"] = utcnow().isoformat()
            else:
                session.clear()
    g.project_id = request.headers.get("X-Project-Id") or request.args.get("project_id") or None
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path != "/api/auth/login":
        token = request.headers.get("X-CSRF-Token", "")
        if not token or not session.get("csrf_token") or not secrets.compare_digest(token, session["csrf_token"]):
            return json_error("Invalid or missing CSRF token. Reload the page and try again.", 403)
    return None


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                                                   "script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'")
    if CONFIG["SECURE_COOKIES"]:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not g.user:
            if request.path.startswith("/api/"):
                return json_error("Not signed in.", 401)
            return redirect(url_for("login_page", next=request.path))
        return fn(*args, **kwargs)
    return wrapper


def require(perm):
    def decorator(fn):
        @wraps(fn)
        @login_required
        def wrapper(*args, **kwargs):
            if not has_permission(g.user, perm):
                record_audit("permission_denied", "permission", perm, {"path": request.path})
                return json_error("You do not have permission to do this.", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def _attempt_key(username):
    return f"{username.lower()}|{client_ip()}"


def login_locked(username):
    with _login_lock:
        e = _login_attempts.get(_attempt_key(username))
        if e and e.get("locked_until") and e["locked_until"] > utcnow():
            return int((e["locked_until"] - utcnow()).total_seconds() // 60) + 1
    return 0


def register_failed_login(username):
    with _login_lock:
        e = _login_attempts.setdefault(_attempt_key(username), {"count": 0, "locked_until": None})
        e["count"] += 1
        if e["count"] >= CONFIG["MAX_LOGIN_ATTEMPTS"]:
            e["locked_until"] = utcnow() + timedelta(minutes=CONFIG["LOCKOUT_MINUTES"])
            e["count"] = 0


def public_user(user):
    return {"id": str(user["_id"]), "username": user["username"], "full_name": user.get("full_name", ""), "role": user.get("role"),
            "active": user.get("active", True), "must_change_password": user.get("must_change_password", False),
            "permissions": sorted(ROLE_PERMISSIONS.get(user.get("role"), set())),
            "last_login_at": serialize(user.get("last_login_at")), "created_at": serialize(user.get("created_at"))}


# ---------------------------------------------------------------------------
# Projects and partners
# ---------------------------------------------------------------------------

def project_public(p):
    d = serialize(p)
    d["partner_count"] = len([x for x in p.get("partners", []) if x.get("active", True)])
    return d


def get_project_or_none(project_id=None):
    pid = project_id or g.project_id
    oid = to_oid(pid)
    return projects_col.find_one({"_id": oid}) if oid else None


def require_project(fn):
    """Loads the project named by the X-Project-Id header / project_id param into g.project."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        proj = get_project_or_none()
        if not proj:
            return json_error("Choose a project first.", 400, code="no_project")
        g.project = proj
        g.project_id = str(proj["_id"])
        return fn(*args, **kwargs)
    return wrapper


def validate_partners(raw, existing=None):
    """Return (partners, error). Shares must add up to 100. Existing partner ids are kept."""
    if not isinstance(raw, list) or not raw:
        return None, "Add at least one partner."
    existing_by_id = {p["id"]: p for p in (existing or [])}
    out, total, names = [], 0.0, set()
    for item in raw:
        name = clean_str(item.get("name"), 80)
        if len(name) < 1:
            return None, "Every partner needs a name."
        if name.lower() in names:
            return None, f"Partner name '{name}' is used twice."
        names.add(name.lower())
        share = parse_amount(item.get("share"), allow_zero=True)
        if share is None or share > 100:
            return None, f"Enter a valid percentage for {name}."
        pid = item.get("id") if item.get("id") in existing_by_id else uuid.uuid4().hex[:10]
        out.append({"id": pid, "name": name, "phone": clean_str(item.get("phone"), 30), "share": share,
                    "active": bool(item.get("active", True)),
                    "added_at": existing_by_id.get(pid, {}).get("added_at", utcnow())})
        if out[-1]["active"]:
            total += share
    if abs(total - 100) > 0.01:
        return None, f"Shares of active partners must add up to 100% (currently {total:g}%)."
    return out, None


def seed_categories_for_project(project_id, categories=None):
    order = 0
    for parent_name, children in (categories or seed_data.DEFAULT_CATEGORIES).items():
        order += 1
        parent = {"project_id": project_id, "name": parent_name, "parent_id": None, "path": [parent_name], "path_ids": [], "level": 0,
                  "description": "", "status": "active", "sort_order": order, "created_at": utcnow(), "is_default": True}
        pid = categories_col.insert_one(parent).inserted_id
        categories_col.update_one({"_id": pid}, {"$set": {"path_ids": [str(pid)]}})
        for i, child_name in enumerate(children):
            child = {"project_id": project_id, "name": child_name, "parent_id": str(pid), "path": [parent_name, child_name],
                     "path_ids": [str(pid)], "level": 1, "description": "", "status": "active", "sort_order": i + 1,
                     "created_at": utcnow(), "is_default": True}
            cid = categories_col.insert_one(child).inserted_id
            categories_col.update_one({"_id": cid}, {"$set": {"path_ids": [str(pid), str(cid)]}})


def create_project(name, description, partners, created_by=None):
    doc = {"name": name, "description": description, "status": "active", "partners": partners, "categories_version": seed_data.CATEGORIES_VERSION,
           "field_config": json.loads(json.dumps(DEFAULT_FIELD_CONFIG)), "custom_fields": [],
           "created_at": utcnow(), "created_by": created_by}
    pid = projects_col.insert_one(doc).inserted_id
    seed_categories_for_project(str(pid))
    doc["_id"] = pid
    return doc


@app.route("/api/projects")
@login_required
def api_projects_list():
    projs = list(projects_col.find({}).sort("created_at", ASCENDING))
    counts = {r["_id"]: r for r in expenses_col.aggregate([{"$match": {"status": "active"}},
                                                           {"$group": {"_id": "$project_id", "count": {"$sum": 1}, "total": {"$sum": "$amount"}}}])}
    out = []
    for p in projs:
        d = project_public(p)
        c = counts.get(str(p["_id"]), {"count": 0, "total": 0})
        d["expense_count"], d["expense_total"] = c["count"], round(c["total"], 2)
        out.append(d)
    return jsonify({"projects": out, "firm_name": CONFIG["FIRM_NAME"]})


@app.route("/api/projects", methods=["POST"])
@require("project:manage")
def api_projects_create():
    data = request.get_json(silent=True) or {}
    name = clean_str(data.get("name"), 80)
    if len(name) < 2:
        return json_error("Project name must be at least 2 characters.")
    if projects_col.find_one({"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}):
        return json_error("A project with this name already exists.", 409)
    partners, err = validate_partners(data.get("partners") or [])
    if err:
        return json_error(err)
    proj = create_project(name, clean_str(data.get("description"), 300), partners, str(g.user["_id"]))
    record_audit("project_created", "project", proj["_id"], {"name": name, "partners": [(p["name"], p["share"]) for p in partners]},
                 project_id=str(proj["_id"]))
    return jsonify({"project": project_public(proj)}), 201


@app.route("/api/projects/<project_id>", methods=["PUT"])
@require("project:manage")
def api_projects_update(project_id):
    proj = get_project_or_none(project_id)
    if not proj:
        return json_error("Project not found.", 404)
    data = request.get_json(silent=True) or {}
    updates, details = {}, {}
    if "name" in data:
        name = clean_str(data["name"], 80)
        if len(name) < 2:
            return json_error("Project name must be at least 2 characters.")
        updates["name"], details["name"] = name, name
    if "description" in data:
        updates["description"] = clean_str(data["description"], 300)
    if "status" in data and data["status"] in ("active", "archived"):
        updates["status"], details["status"] = data["status"], data["status"]
    action = "project_updated"
    if "partners" in data:
        partners, err = validate_partners(data["partners"], proj.get("partners", []))
        if err:
            return json_error(err)
        # A partner who has already paid for something cannot be removed, only made inactive.
        kept = {p["id"] for p in partners}
        for old in proj.get("partners", []):
            if old["id"] not in kept and expenses_col.count_documents({"payments.partner_id": old["id"]}):
                return json_error(f"{old['name']} has payments recorded. Untick 'active' instead of removing them.", 409)
        updates["partners"] = partners
        details["partners"] = [{"name": p["name"], "share": p["share"], "active": p["active"]} for p in partners]
        action = "partners_updated"
    if "field_config" in data:
        cfg = {}
        for key, _label in OPTIONAL_FIELDS:
            item = (data["field_config"] or {}).get(key) or {}
            cfg[key] = {"enabled": bool(item.get("enabled")), "required": bool(item.get("enabled")) and bool(item.get("required"))}
        updates["field_config"] = cfg
        details["field_config"] = {k: v for k, v in cfg.items() if v["enabled"]}
        action = "fields_updated"
    if "custom_fields" in data:
        fields, seen = [], set()
        for item in data["custom_fields"] or []:
            label = clean_str(item.get("label"), 60)
            if len(label) < 1:
                return json_error("Every custom field needs a label.")
            key = item.get("key") if re.fullmatch(r"cf_[a-z0-9]{6,12}", str(item.get("key") or "")) else "cf_" + uuid.uuid4().hex[:8]
            if key in seen:
                continue
            seen.add(key)
            ftype = item.get("type") if item.get("type") in CUSTOM_FIELD_TYPES else "text"
            options = [clean_str(o, 60) for o in (item.get("options") or []) if clean_str(o, 60)] if ftype == "select" else []
            if ftype == "select" and not options:
                return json_error(f"Dropdown field '{label}' needs at least one option.")
            fields.append({"key": key, "label": label, "type": ftype, "required": bool(item.get("required")), "options": options})
        updates["custom_fields"] = fields
        details["custom_fields"] = [f["label"] for f in fields]
        action = "fields_updated"
    if not updates:
        return json_error("Nothing to update.")
    projects_col.update_one({"_id": proj["_id"]}, {"$set": dict(updates, updated_at=utcnow())})
    record_audit(action, "project", proj["_id"], details, project_id=str(proj["_id"]))
    return jsonify({"project": project_public(projects_col.find_one({"_id": proj["_id"]}))})


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------

def seed_defaults():
    if users_col.count_documents({}) == 0:
        a = CONFIG["DEFAULT_ADMIN"]
        users_col.insert_one({"username": a["username"], "full_name": a["full_name"], "password_hash": generate_password_hash(a["password"]),
                              "role": "admin", "active": True, "must_change_password": True, "session_version": 1,
                              "created_at": utcnow(), "last_login_at": None})
        log.info("Created default admin user '%s'", a["username"])
    if projects_col.count_documents({}) == 0 and CONFIG["IMPORT_SEED_LEDGER"]:
        import_seed_ledger()


def upgrade_project_categories(proj):
    """
    One-time upgrade to the new category list:
      1. add any new default categories/subcategories that are missing,
      2. re-file ledger rows that nobody has edited yet,
      3. archive old default categories that are no longer used.
    User-created categories and manually edited expenses are left alone.
    """
    pid = str(proj["_id"])
    now = utcnow()
    existing = {tuple(c["path"]): c for c in categories_col.find({"project_id": pid})}
    added = 0
    order = max([c.get("sort_order", 0) for c in existing.values() if c["level"] == 0] or [0])
    for parent_name, children in seed_data.DEFAULT_CATEGORIES.items():
        parent = existing.get((parent_name,))
        if not parent:
            order += 1
            parent = {"project_id": pid, "name": parent_name, "parent_id": None, "path": [parent_name], "path_ids": [], "level": 0, "description": "",
                      "status": "active", "sort_order": order, "created_at": now, "is_default": True}
            parent["_id"] = categories_col.insert_one(parent).inserted_id
            parent["path_ids"] = [str(parent["_id"])]
            categories_col.update_one({"_id": parent["_id"]}, {"$set": {"path_ids": parent["path_ids"]}})
            existing[(parent_name,)] = parent
            added += 1
        elif parent.get("status") != "active":
            categories_col.update_one({"_id": parent["_id"]}, {"$set": {"status": "active"}, "$unset": {"archived_at": ""}})
        for i, child_name in enumerate(children):
            child = existing.get((parent_name, child_name))
            if not child:
                child = {"project_id": pid, "name": child_name, "parent_id": str(parent["_id"]), "path": [parent_name, child_name], "path_ids": [str(parent["_id"])],
                         "level": 1, "description": "", "status": "active", "sort_order": i + 1, "created_at": now, "is_default": True}
                child["_id"] = categories_col.insert_one(child).inserted_id
                categories_col.update_one({"_id": child["_id"]}, {"$set": {"path_ids": [str(parent["_id"]), str(child["_id"])]}})
                existing[(parent_name, child_name)] = child
                added += 1
    # re-file untouched ledger rows
    moved = 0
    for e in expenses_col.find({"project_id": pid, "created_by": "import", "revision": 1, "status": "active"}):
        cat_name, sub_name = seed_data.guess_category(e["description"])
        top = existing.get((cat_name,))
        sub = existing.get((cat_name, sub_name)) if sub_name else None
        if not top:
            continue
        new_path = sub["path"] if sub else top["path"]
        if e.get("category_path") == new_path:
            continue
        values = {"category_id": str(top["_id"]), "subcategory_id": str(sub["_id"]) if sub else None, "category_path": new_path}
        changes = {k: {"from": serialize(e.get(k)), "to": serialize(v)} for k, v in values.items()}
        expenses_col.update_one({"_id": e["_id"]}, {"$set": dict(values, revision=2, updated_at=now, modified_by="system", modified_by_name="Category upgrade")})
        revisions_col.insert_one({"expense_oid": e["_id"], "expense_id": e["expense_id"], "revision": 2, "action": "edit", "changes": changes,
                                  "snapshot_before": snapshot(e), "snapshot_after": snapshot(dict(e, **values)), "user_id": "system",
                                  "user_name": "Category upgrade", "at": now, "reason": "Moved to the new category list"})
        moved += 1
    # archive old defaults that nothing uses any more
    archived = 0
    for c in categories_col.find({"project_id": pid, "status": "active", "is_default": True, "name": {"$in": list(seed_data.OLD_DEFAULT_CATEGORY_NAMES)}, "level": 0}):
        if c["name"] in seed_data.DEFAULT_CATEGORIES:
            continue
        ids = [str(x["_id"]) for x in categories_col.find({"path_ids": str(c["_id"])})]
        if expenses_col.count_documents({"status": "active", "$or": [{"category_id": {"$in": ids}}, {"subcategory_id": {"$in": ids}}]}):
            continue
        categories_col.update_many({"_id": {"$in": [ObjectId(i) for i in ids]}}, {"$set": {"status": "archived", "archived_at": now}})
        archived += 1
    projects_col.update_one({"_id": proj["_id"]}, {"$set": {"categories_version": seed_data.CATEGORIES_VERSION}})
    audit_col.insert_one({"action": "categories_upgraded", "entity_type": "project", "entity_id": pid, "project_id": pid, "user_id": None, "user_name": "system",
                          "at": now, "ip": None, "details": {"added": added, "expenses_moved": moved, "old_categories_archived": archived}})
    log.info("Project '%s': categories upgraded (added %d, moved %d expenses, archived %d old categories)", proj["name"], added, moved, archived)


def upgrade_all_projects():
    for proj in projects_col.find({"$or": [{"categories_version": {"$exists": False}}, {"categories_version": {"$lt": seed_data.CATEGORIES_VERSION}}]}):
        try:
            upgrade_project_categories(proj)
        except Exception as exc:
            log.exception("Category upgrade failed for %s: %s", proj.get("name"), exc)


def import_seed_ledger():
    """Create the Restaurant project and import the partners' ledger from seed_data.py."""
    sp = seed_data.PROJECT
    partners = [{"id": uuid.uuid4().hex[:10], "name": p["name"], "phone": p.get("phone", ""), "share": float(p["share"]),
                 "active": True, "added_at": utcnow()} for p in sp["partners"]]
    proj = create_project(sp["name"], sp.get("description", ""), partners)
    pid = str(proj["_id"])
    by_name = {p["name"]: p for p in partners}
    cats = {tuple(c["path"]): c for c in categories_col.find({"project_id": pid})}
    now = utcnow()
    total = 0
    for i, (desc, date, amount, paid_a, paid_v) in enumerate(seed_data.ROWS, start=1):
        cat_name, sub_name = seed_data.guess_category(desc)
        top = cats.get((cat_name,))
        sub = cats.get((cat_name, sub_name)) if sub_name else None
        payments = []
        for pname, paid in (("Advith", paid_a), ("Vibhav", paid_v)):
            if paid:
                payments.append({"partner_id": by_name[pname]["id"], "partner_name": pname, "amount": float(paid)})
        d = parse_date(date)
        doc = {"expense_id": f"EXP-2026-{i:05d}", "project_id": pid, "description": desc, "amount": float(amount), "transaction_date": d,
               "category_id": str(top["_id"]), "subcategory_id": str(sub["_id"]) if sub else None,
               "category_path": sub["path"] if sub else top["path"], "payments": payments, "vendor": "", "payment_method": "",
               "payment_reference": "", "payment_status": "Paid", "notes": "Imported from the partners' Google Sheet ledger",
               "receipt_reference": "", "expense_type": "Setup", "project_phase": "", "custom": {}, "status": "active", "revision": 1,
               "created_by": "import", "created_by_name": "Ledger import", "created_at": now, "updated_at": now,
               "deleted_by": None, "deleted_at": None, "deletion_reason": None, "restoration_history": []}
        expenses_col.insert_one(doc)
        revisions_col.insert_one({"expense_oid": doc["_id"], "expense_id": doc["expense_id"], "revision": 1, "action": "create", "changes": {},
                                  "snapshot_before": None, "snapshot_after": snapshot(doc), "user_id": "import", "user_name": "Ledger import",
                                  "at": now, "reason": "Imported from Google Sheet"})
        total += amount
    counters_col.update_one({"_id": "expense_2026"}, {"$set": {"seq": len(seed_data.ROWS)}}, upsert=True)
    audit_col.insert_one({"action": "ledger_imported", "entity_type": "project", "entity_id": pid, "project_id": pid, "user_id": None,
                          "user_name": "system", "at": now, "ip": None, "details": {"rows": len(seed_data.ROWS), "total": total}})
    log.info("Imported %d ledger rows (total %s) into project '%s'", len(seed_data.ROWS), total, sp["name"])


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/login")
def login_page():
    if g.user:
        return redirect(url_for("index"))
    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)
    return render_template("login.html", csrf_token=session["csrf_token"], firm_name=CONFIG["FIRM_NAME"])


@app.route("/")
@login_required
def index():
    meta = {"payment_methods": PAYMENT_METHODS, "payment_statuses": PAYMENT_STATUSES, "expense_types": EXPENSE_TYPES, "roles": ROLES,
            "widgets": DASHBOARD_WIDGETS, "currency": CONFIG["CURRENCY"], "idle_minutes": CONFIG["SESSION_IDLE_MINUTES"],
            "optional_fields": OPTIONAL_FIELDS, "custom_field_types": CUSTOM_FIELD_TYPES, "firm_name": CONFIG["FIRM_NAME"]}
    return render_template("index.html", csrf_token=session["csrf_token"], firm_name=CONFIG["FIRM_NAME"],
                           user_json=json.dumps(public_user(g.user)).replace("</", "<\\/"),
                           meta_json=json.dumps(meta).replace("</", "<\\/"))


@app.route("/logout")
def logout_page():
    if g.user:
        record_audit("logout", "user", g.user["_id"])
    session.clear()
    return redirect(url_for("login_page"))


# ---------------------------------------------------------------------------
# Auth API
# ---------------------------------------------------------------------------

@app.route("/api/auth/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    username, password = clean_str(data.get("username"), 64), data.get("password") or ""
    token = request.headers.get("X-CSRF-Token", "")
    if not username or not password:
        return json_error("Enter your username and password.")
    if not session.get("csrf_token") or not secrets.compare_digest(token, session.get("csrf_token", "")):
        return json_error("Session expired. Reload the page and sign in again.", 403)
    minutes = login_locked(username)
    if minutes:
        return json_error(f"Too many failed attempts. Try again in {minutes} minute(s).", 429)
    user = users_col.find_one({"username": username.lower()})
    if not user or not check_password_hash(user["password_hash"], password):
        register_failed_login(username)
        record_audit("login_failed", "user", username, {"reason": "bad_credentials"}, user=None)
        time.sleep(0.4)
        return json_error("Incorrect username or password.", 401)
    if not user.get("active", False):
        record_audit("login_failed", "user", str(user["_id"]), {"reason": "inactive"}, user=None)
        return json_error("This account is disabled. Contact the administrator.", 403)
    with _login_lock:
        _login_attempts.pop(_attempt_key(username), None)
    session.clear()
    session.permanent = True
    session.update({"user_id": str(user["_id"]), "session_version": user.get("session_version", 1),
                    "csrf_token": secrets.token_urlsafe(32), "last_active": utcnow().isoformat()})
    users_col.update_one({"_id": user["_id"]}, {"$set": {"last_login_at": utcnow()}})
    g.user = user
    record_audit("login", "user", user["_id"], {"user_agent": request.headers.get("User-Agent", "")[:120]})
    return jsonify({"user": public_user(user), "csrf_token": session["csrf_token"]})


@app.route("/api/auth/logout", methods=["POST"])
@login_required
def api_logout():
    record_audit("logout", "user", g.user["_id"])
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/me")
@login_required
def api_me():
    return jsonify({"user": public_user(g.user), "csrf_token": session["csrf_token"]})


@app.route("/api/auth/change-password", methods=["POST"])
@login_required
def api_change_password():
    data = request.get_json(silent=True) or {}
    current, new, confirm = data.get("current_password") or "", data.get("new_password") or "", data.get("confirm_password") or ""
    if not check_password_hash(g.user["password_hash"], current):
        return json_error("Current password is incorrect.")
    if new != confirm:
        return json_error("New password and confirmation do not match.")
    if new == current:
        return json_error("New password must be different from the current one.")
    problem = validate_password(new)
    if problem:
        return json_error(problem)
    users_col.update_one({"_id": g.user["_id"]}, {"$set": {"password_hash": generate_password_hash(new), "must_change_password": False}})
    record_audit("password_changed", "user", g.user["_id"])
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Users (admin)
# ---------------------------------------------------------------------------

@app.route("/api/users")
@require("user:manage")
def api_users_list():
    return jsonify({"users": [public_user(u) for u in users_col.find({}).sort("username", ASCENDING)]})


@app.route("/api/users", methods=["POST"])
@require("user:manage")
def api_users_create():
    data = request.get_json(silent=True) or {}
    username = clean_str(data.get("username"), 64).lower()
    role, password = data.get("role"), data.get("password") or ""
    if not re.fullmatch(r"[a-z0-9._-]{3,64}", username):
        return json_error("Username must be 3-64 characters: letters, numbers, dot, dash or underscore.")
    if role not in ("editor", "viewer"):
        return json_error("Role must be editor or viewer. There is only one admin account.")
    problem = validate_password(password)
    if problem:
        return json_error(problem)
    doc = {"username": username, "full_name": clean_str(data.get("full_name"), 120) or username, "role": role,
           "password_hash": generate_password_hash(password), "active": True, "must_change_password": True, "session_version": 1,
           "created_at": utcnow(), "last_login_at": None}
    try:
        doc["_id"] = users_col.insert_one(doc).inserted_id
    except DuplicateKeyError:
        return json_error("That username is already taken.", 409)
    record_audit("user_created", "user", doc["_id"], {"username": username, "role": role})
    return jsonify({"user": public_user(doc)}), 201


@app.route("/api/users/<user_id>", methods=["PUT"])
@require("user:manage")
def api_users_update(user_id):
    oid = to_oid(user_id)
    user = users_col.find_one({"_id": oid}) if oid else None
    if not user:
        return json_error("User not found.", 404)
    data = request.get_json(silent=True) or {}
    updates, changes = {}, {}
    if "full_name" in data:
        updates["full_name"] = clean_str(data["full_name"], 120) or user["username"]
    if "role" in data and user["role"] != "admin":
        if data["role"] not in ("editor", "viewer"):
            return json_error("Role must be editor or viewer.")
        updates["role"] = data["role"]
    if "active" in data:
        if user["_id"] == g.user["_id"]:
            return json_error("You cannot disable your own account.")
        updates["active"] = bool(data["active"])
    if data.get("new_password"):
        problem = validate_password(data["new_password"])
        if problem:
            return json_error(problem)
        updates["password_hash"] = generate_password_hash(data["new_password"])
        updates["must_change_password"] = True
        changes["password_reset"] = True
    if not updates:
        return json_error("Nothing to update.")
    if any(k in updates for k in ("role", "active", "password_hash")) and user["_id"] != g.user["_id"]:
        updates["session_version"] = user.get("session_version", 1) + 1
    users_col.update_one({"_id": oid}, {"$set": updates})
    changes.update({k: v for k, v in updates.items() if k not in ("password_hash", "session_version")})
    record_audit("user_updated", "user", oid, changes)
    return jsonify({"user": public_user(users_col.find_one({"_id": oid}))})


# ---------------------------------------------------------------------------
# Categories (per project)
# ---------------------------------------------------------------------------

def category_tree(project_id, include_archived=False):
    query = {"project_id": project_id}
    if not include_archived:
        query["status"] = "active"
    cats = list(categories_col.find(query).sort([("level", ASCENDING), ("sort_order", ASCENDING), ("name", ASCENDING)]))
    usage = {}
    for field in ("category_id", "subcategory_id"):
        for row in expenses_col.aggregate([{"$match": {"project_id": project_id, "status": "active", field: {"$ne": None}}},
                                           {"$group": {"_id": f"${field}", "count": {"$sum": 1}, "total": {"$sum": "$amount"}}}]):
            usage[row["_id"]] = {"count": row["count"], "total": round(row["total"], 2)}
    flat = []
    for c in cats:
        item = serialize(c)
        item["usage"] = usage.get(str(c["_id"]), {"count": 0, "total": 0})
        flat.append(item)
    by_id = {c["id"]: dict(c, children=[]) for c in flat}
    roots = []
    for c in flat:
        node = by_id[c["id"]]
        parent = by_id.get(c["parent_id"]) if c["parent_id"] else None
        (parent["children"] if parent else roots).append(node)
    return roots, flat


@app.route("/api/categories")
@require("category:view")
@require_project
def api_categories():
    tree, flat = category_tree(g.project_id, request.args.get("include_archived") == "1")
    return jsonify({"tree": tree, "flat": flat})


@app.route("/api/categories", methods=["POST"])
@require("category:manage")
@require_project
def api_categories_create():
    data = request.get_json(silent=True) or {}
    name = clean_str(data.get("name"), 80)
    parent_id = data.get("parent_id") or None
    if len(name) < 2:
        return json_error("Category name must be at least 2 characters.")
    parent = None
    if parent_id:
        parent = categories_col.find_one({"_id": to_oid(parent_id), "project_id": g.project_id}) if to_oid(parent_id) else None
        if not parent or parent.get("status") != "active":
            return json_error("Parent category not found or archived.", 404)
    if categories_col.find_one({"project_id": g.project_id, "parent_id": parent_id, "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}):
        return json_error("A category with this name already exists at this level.", 409)
    path = (parent["path"] if parent else []) + [name]
    doc = {"project_id": g.project_id, "name": name, "parent_id": parent_id, "path": path, "path_ids": [], "level": len(path) - 1,
           "description": clean_str(data.get("description"), 300), "status": "active",
           "sort_order": categories_col.count_documents({"project_id": g.project_id, "parent_id": parent_id}) + 1,
           "created_at": utcnow(), "created_by": str(g.user["_id"]), "is_default": False}
    cid = categories_col.insert_one(doc).inserted_id
    categories_col.update_one({"_id": cid}, {"$set": {"path_ids": (parent["path_ids"] if parent else []) + [str(cid)]}})
    record_audit("category_created", "category", cid, {"name": name, "path": path})
    return jsonify({"category": serialize(categories_col.find_one({"_id": cid}))}), 201


def rename_descendant_paths(cat):
    cid = str(cat["_id"])
    for d in categories_col.find({"path_ids": cid, "_id": {"$ne": cat["_id"]}}):
        idx = d["path_ids"].index(cid)
        new_path = cat["path"] + d["path"][idx + 1:]
        categories_col.update_one({"_id": d["_id"]}, {"$set": {"path": new_path}})
        expenses_col.update_many({"$or": [{"category_id": str(d["_id"])}, {"subcategory_id": str(d["_id"])}]}, {"$set": {"category_path": new_path}})


@app.route("/api/categories/<cat_id>", methods=["PUT"])
@require("category:manage")
@require_project
def api_categories_update(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid, "project_id": g.project_id}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    data = request.get_json(silent=True) or {}
    updates = {}
    if "name" in data:
        name = clean_str(data["name"], 80)
        if len(name) < 2:
            return json_error("Category name must be at least 2 characters.")
        if categories_col.find_one({"project_id": g.project_id, "parent_id": cat["parent_id"], "_id": {"$ne": oid},
                                    "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}):
            return json_error("A category with this name already exists at this level.", 409)
        updates["name"], updates["path"] = name, cat["path"][:-1] + [name]
    if "description" in data:
        updates["description"] = clean_str(data["description"], 300)
    if not updates:
        return json_error("Nothing to update.")
    categories_col.update_one({"_id": oid}, {"$set": updates})
    cat = categories_col.find_one({"_id": oid})
    if "name" in updates:
        expenses_col.update_many({"$or": [{"category_id": cat_id}, {"subcategory_id": cat_id}]}, {"$set": {"category_path": cat["path"]}})
        rename_descendant_paths(cat)
    record_audit("category_updated", "category", oid, updates)
    return jsonify({"category": serialize(cat)})


def resolve_category_pair(selected_id):
    cat = categories_col.find_one({"_id": to_oid(selected_id)}) if to_oid(selected_id) else None
    if not cat:
        return None, None
    return cat["path_ids"][0], (selected_id if cat["level"] > 0 else None)


@app.route("/api/categories/<cat_id>/archive", methods=["POST"])
@require("category:manage")
@require_project
def api_categories_archive(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid, "project_id": g.project_id}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    data = request.get_json(silent=True) or {}
    ids = [str(c["_id"]) for c in categories_col.find({"path_ids": cat_id})]
    using = {"status": "active", "$or": [{"category_id": {"$in": ids}}, {"subcategory_id": {"$in": ids}}]}
    in_use = expenses_col.count_documents(using)
    reassign_to = data.get("reassign_to")
    if in_use and not reassign_to:
        return json_error(f"{in_use} active expense(s) use this category. Choose a category to move them to first.", 409, in_use=in_use)
    moved = 0
    if in_use:
        target = categories_col.find_one({"_id": to_oid(reassign_to), "status": "active", "project_id": g.project_id}) if to_oid(reassign_to) else None
        if not target or str(target["_id"]) in ids:
            return json_error("Choose a valid, active category to move expenses to.")
        new_cat, new_sub = resolve_category_pair(str(target["_id"]))
        for exp in expenses_col.find(using):
            apply_edit(exp, {"category_id": new_cat, "subcategory_id": new_sub, "category_path": target["path"]},
                       reason=f"Category '{cat['name']}' archived; moved to '{' > '.join(target['path'])}'")
            moved += 1
    categories_col.update_many({"_id": {"$in": [ObjectId(i) for i in ids]}}, {"$set": {"status": "archived", "archived_at": utcnow()}})
    record_audit("category_archived", "category", oid, {"name": cat["name"], "reassigned": moved})
    return jsonify({"ok": True, "reassigned": moved})


@app.route("/api/categories/<cat_id>/unarchive", methods=["POST"])
@require("category:manage")
@require_project
def api_categories_unarchive(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid, "project_id": g.project_id}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    if cat["parent_id"]:
        parent = categories_col.find_one({"_id": to_oid(cat["parent_id"])})
        if parent and parent.get("status") != "active":
            return json_error("Restore the parent category first.")
    categories_col.update_one({"_id": oid}, {"$set": {"status": "active"}, "$unset": {"archived_at": ""}})
    record_audit("category_restored", "category", oid, {"name": cat["name"]})
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Expenses
# ---------------------------------------------------------------------------

EDITABLE_FIELDS = ["description", "amount", "transaction_date", "category_id", "subcategory_id", "category_path", "payments", "vendor",
                   "payment_method", "payment_reference", "payment_status", "notes", "receipt_reference", "expense_type", "project_phase", "custom"]


def snapshot(exp):
    return {k: serialize(exp.get(k)) for k in EDITABLE_FIELDS}


def validate_payments(raw, amount, project):
    """payments = [{partner_id, amount}] must add up to the expense amount."""
    partners = {p["id"]: p for p in project.get("partners", [])}
    if not isinstance(raw, list) or not raw:
        return None, "Record who paid for this expense."
    out, total, seen = [], 0.0, set()
    for item in raw:
        pid = item.get("partner_id")
        if pid not in partners:
            return None, "Unknown partner in the payment split."
        if pid in seen:
            return None, "A partner appears twice in the split."
        paid = parse_amount(item.get("amount"), allow_zero=True)
        if paid is None:
            return None, f"Enter a valid amount for {partners[pid]['name']}."
        if paid > 0:
            seen.add(pid)
            out.append({"partner_id": pid, "partner_name": partners[pid]["name"], "amount": paid})
            total += paid
    if not out:
        return None, "Record who paid for this expense."
    if abs(total - amount) > 0.01:
        return None, f"The split (₹{total:,.2f}) must equal the expense amount (₹{amount:,.2f})."
    return out, None


def validate_custom(raw, project):
    out = {}
    for f in project.get("custom_fields", []):
        v = (raw or {}).get(f["key"])
        if v in (None, ""):
            if f.get("required"):
                return None, f"{f['label']} is required."
            continue
        if f["type"] == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                return None, f"{f['label']} must be a number."
        elif f["type"] == "date":
            if not parse_date(v):
                return None, f"{f['label']} must be a valid date."
            v = str(v)[:10]
        elif f["type"] == "select":
            if v not in f.get("options", []):
                return None, f"Choose a valid option for {f['label']}."
        else:
            v = clean_str(v, 300)
        out[f["key"]] = v
    return out, None


def validate_expense_payload(data, project, partial=False):
    values = {}
    cfg = project.get("field_config") or DEFAULT_FIELD_CONFIG
    if "description" in data or not partial:
        desc = clean_str(data.get("description"), 300)
        if len(desc) < 2:
            return None, "Description is required."
        values["description"] = desc
    if "amount" in data or not partial:
        amount = parse_amount(data.get("amount"))
        if amount is None:
            return None, "Enter an amount greater than 0."
        values["amount"] = amount
    if "transaction_date" in data or not partial:
        date = parse_date(data.get("transaction_date"))
        if not date:
            return None, "Enter a valid date."
        if date > utcnow() + timedelta(days=1):
            return None, "Date cannot be in the future."
        values["transaction_date"] = date
    if "category_id" in data or "subcategory_id" in data or not partial:
        selected = data.get("subcategory_id") or data.get("category_id")
        if not selected:
            return None, "Choose a category."
        cat = categories_col.find_one({"_id": to_oid(selected), "status": "active", "project_id": str(project["_id"])}) if to_oid(selected) else None
        if not cat:
            return None, "Choose a valid category."
        values["category_id"], values["subcategory_id"] = resolve_category_pair(selected)
        values["category_path"] = cat["path"]
    for key, label in OPTIONAL_FIELDS:
        c = cfg.get(key, {"enabled": False, "required": False})
        if key in data:
            v = clean_str(data.get(key), 2000 if key == "notes" else 120)
            if key == "payment_method" and v and v not in PAYMENT_METHODS:
                return None, "Choose a valid payment method."
            if key == "payment_status" and v and v not in PAYMENT_STATUSES:
                return None, "Choose a valid payment status."
            if key == "expense_type" and v and v not in EXPENSE_TYPES:
                return None, "Choose a valid expense type."
            values[key] = v
        if c.get("enabled") and c.get("required") and (not partial or key in data) and not values.get(key):
            return None, f"{label} is required."
    if "custom" in data or not partial:
        custom, err = validate_custom(data.get("custom") or {}, project)
        if err:
            return None, err
        values["custom"] = custom
    return values, None


def apply_edit(exp, values, reason):
    changes = {k: {"from": serialize(exp.get(k)), "to": serialize(v)} for k, v in values.items() if serialize(exp.get(k)) != serialize(v)}
    if not changes:
        return exp, {}
    new_rev = exp.get("revision", 1) + 1
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "revision": exp.get("revision", 1)},
        {"$set": dict(values, revision=new_rev, updated_at=utcnow(), modified_by=str(g.user["_id"]), modified_by_name=user_display(g.user))},
        return_document=ReturnDocument.AFTER)
    if not updated:
        return None, None
    revisions_col.insert_one({"expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_rev, "action": "edit", "changes": changes,
                              "snapshot_before": snapshot(exp), "snapshot_after": snapshot(updated), "user_id": str(g.user["_id"]),
                              "user_name": user_display(g.user), "at": utcnow(), "reason": reason})
    record_audit("expense_edited", "expense", exp["expense_id"], {"revision": new_rev, "changes": changes, "reason": reason},
                 project_id=exp.get("project_id"))
    return updated, changes


def build_expense_query(args, user, project_id):
    query = {"project_id": project_id}
    status = args.get("status", "active")
    if status in ("deleted", "all") and not has_permission(user, "expense:view_deleted"):
        status = "active"
    if status == "deleted":
        query["status"] = "deleted"
    elif status == "edited":
        query["status"], query["revision"] = "active", {"$gt": 1}
    elif status != "all":
        query["status"] = "active"
    q = clean_str(args.get("q"), 120)
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"expense_id": rx}, {"description": rx}, {"vendor": rx}, {"notes": rx}, {"payment_reference": rx}]

    def multi(name):
        raw = args.getlist(name) if hasattr(args, "getlist") else [args.get(name)]
        return [v.strip() for r in raw if r for v in str(r).split(",") if v.strip()]

    clauses = []
    if multi("category_id"):
        clauses.append({"category_id": {"$in": multi("category_id")}})
    if multi("subcategory_id"):
        clauses.append({"subcategory_id": {"$in": multi("subcategory_id")}})
    if clauses:
        if args.get("logic") == "any" and len(clauses) > 1:
            query.setdefault("$and", []).append({"$or": clauses})
        else:
            for c in clauses:
                query.update(c)
    for name in ("vendor", "payment_method", "payment_status", "expense_type", "project_phase"):
        if multi(name):
            query[name] = {"$in": multi(name)}
    if multi("partner_id"):
        query["payments.partner_id"] = {"$in": multi("partner_id")}
    df, dt = parse_date(args.get("date_from")), parse_date(args.get("date_to"), end_of_day=True)
    if args.get("date_from") and not df:
        return None, "Invalid 'from' date."
    if args.get("date_to") and not dt:
        return None, "Invalid 'to' date."
    if df or dt:
        query["transaction_date"] = {k: v for k, v in (("$gte", df), ("$lte", dt)) if v}
    amt = {}
    for key, op in (("min_amount", "$gte"), ("max_amount", "$lte")):
        if args.get(key):
            v = parse_amount(args[key], allow_zero=True)
            if v is None:
                return None, f"Invalid {key.replace('_', ' ')}."
            amt[op] = v
    if amt:
        query["amount"] = amt
    return query, None


SORTABLE = {"transaction_date", "amount", "category_path", "vendor", "created_at", "updated_at", "expense_id", "description"}


@app.route("/api/expenses")
@require("expense:view")
@require_project
def api_expenses_list():
    query, err = build_expense_query(request.args, g.user, g.project_id)
    if err:
        return json_error(err)
    sort_field = request.args.get("sort", "transaction_date")
    sort_field = sort_field if sort_field in SORTABLE else "transaction_date"
    order = DESCENDING if request.args.get("order", "desc") == "desc" else ASCENDING
    try:
        page, per_page = max(1, int(request.args.get("page", 1))), min(200, max(5, int(request.args.get("per_page", 25))))
    except ValueError:
        page, per_page = 1, 25
    summary = list(expenses_col.aggregate([{"$match": query}, {"$group": {"_id": None, "count": {"$sum": 1}, "total": {"$sum": "$amount"}}}]))
    total_count = summary[0]["count"] if summary else 0
    total_amount = round(summary[0]["total"], 2) if summary else 0
    items = list(expenses_col.find(query).sort([(sort_field, order), ("_id", DESCENDING)]).skip((page - 1) * per_page).limit(per_page))
    return jsonify({"items": serialize(items), "page": page, "per_page": per_page, "total_count": total_count,
                    "total_amount": total_amount, "pages": max(1, -(-total_count // per_page))})


@app.route("/api/expenses", methods=["POST"])
@require("expense:create")
@require_project
def api_expenses_create():
    data = request.get_json(silent=True) or {}
    idem_key = clean_str(request.headers.get("Idempotency-Key"), 128)
    if idem_key:
        prior = idempotency_col.find_one({"key": idem_key, "user_id": str(g.user["_id"])})
        if prior:
            return jsonify(prior["response"]), 200
    values, err = validate_expense_payload(data, g.project)
    if err:
        return json_error(err)
    payments, err = validate_payments(data.get("payments"), values["amount"], g.project)
    if err:
        return json_error(err)
    now = utcnow()
    doc = {k: "" for k, _ in OPTIONAL_FIELDS}
    doc.update(values)
    doc.update({"project_id": g.project_id, "payments": payments, "status": "active", "revision": 1, "created_by": str(g.user["_id"]),
                "created_by_name": user_display(g.user), "created_at": now, "updated_at": now, "deleted_by": None, "deleted_at": None,
                "deletion_reason": None, "restoration_history": []})
    for _ in range(3):
        doc["expense_id"] = next_expense_id()
        try:
            expenses_col.insert_one(doc)
            break
        except DuplicateKeyError:
            doc.pop("_id", None)
    else:
        return json_error("Could not generate a unique expense ID. Try again.", 500)
    revisions_col.insert_one({"expense_oid": doc["_id"], "expense_id": doc["expense_id"], "revision": 1, "action": "create", "changes": {},
                              "snapshot_before": None, "snapshot_after": snapshot(doc), "user_id": str(g.user["_id"]),
                              "user_name": doc["created_by_name"], "at": now, "reason": "Created"})
    record_audit("expense_created", "expense", doc["expense_id"],
                 {"amount": doc["amount"], "description": doc["description"], "paid_by": [(p["partner_name"], p["amount"]) for p in payments]})
    response = {"expense": serialize(doc)}
    if idem_key:
        try:
            idempotency_col.insert_one({"key": idem_key, "user_id": str(g.user["_id"]), "response": response, "created_at": now})
        except DuplicateKeyError:
            pass
    return jsonify(response), 201


def load_expense(expense_ref):
    oid = to_oid(expense_ref)
    exp = expenses_col.find_one({"_id": oid}) if oid else None
    return exp or expenses_col.find_one({"expense_id": expense_ref})


@app.route("/api/expenses/meta")
@require("expense:view")
@require_project
def api_expenses_meta():
    base = {"project_id": g.project_id}
    return jsonify({"vendors": sorted(v for v in expenses_col.distinct("vendor", base) if v),
                    "phases": sorted(p for p in expenses_col.distinct("project_phase", base) if p)})


@app.route("/api/expenses/<expense_ref>")
@require("expense:view")
def api_expenses_get(expense_ref):
    exp = load_expense(expense_ref)
    if not exp or (exp["status"] == "deleted" and not has_permission(g.user, "expense:view_deleted")):
        return json_error("Expense not found.", 404)
    revisions = list(revisions_col.find({"expense_oid": exp["_id"]}).sort("revision", ASCENDING))
    return jsonify({"expense": serialize(exp), "revisions": serialize(revisions)})


@app.route("/api/expenses/<expense_ref>", methods=["PUT"])
@require("expense:edit")
def api_expenses_update(expense_ref):
    exp = load_expense(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    if exp["status"] == "deleted":
        return json_error("Restore this expense before editing it.", 409)
    project = get_project_or_none(exp["project_id"])
    data = request.get_json(silent=True) or {}
    reason = clean_str(data.get("reason"), 300)
    if len(reason) < 3:
        return json_error("A reason for the change is required.")
    if "expected_revision" in data and int(data["expected_revision"]) != exp.get("revision", 1):
        return json_error("This expense was changed by someone else. Reload and try again.", 409)
    values, err = validate_expense_payload(data, project, partial=True)
    if err:
        return json_error(err)
    if "payments" in data or "amount" in values:
        payments, err = validate_payments(data.get("payments", exp.get("payments")), values.get("amount", exp["amount"]), project)
        if err:
            return json_error(err)
        values["payments"] = payments
    updated, changes = apply_edit(exp, values, reason)
    if updated is None:
        return json_error("This expense was changed by someone else. Reload and try again.", 409)
    return jsonify({"expense": serialize(updated), "changes": changes, "message": "" if changes else "No changes detected."})


@app.route("/api/expenses/<expense_ref>", methods=["DELETE"])
@require("expense:delete")
def api_expenses_delete(expense_ref):
    exp = load_expense(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    data = request.get_json(silent=True) or {}
    reason = clean_str(data.get("reason"), 300)
    if len(reason) < 3:
        return json_error("A reason is required.")
    if data.get("permanent"):
        if exp["status"] != "deleted":
            return json_error("Delete the expense first, then remove it permanently.", 409)
        expenses_col.delete_one({"_id": exp["_id"]})
        record_audit("expense_purged", "expense", exp["expense_id"], {"reason": reason, "snapshot": snapshot(exp)}, project_id=exp["project_id"])
        return jsonify({"ok": True, "permanent": True})
    if exp["status"] == "deleted":
        return json_error("This expense is already deleted.", 409)
    now, new_rev = utcnow(), exp.get("revision", 1) + 1
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "status": "active"},
        {"$set": {"status": "deleted", "deleted_by": str(g.user["_id"]), "deleted_by_name": user_display(g.user), "deleted_at": now,
                  "deletion_reason": reason, "revision": new_rev, "updated_at": now}}, return_document=ReturnDocument.AFTER)
    if not updated:
        return json_error("This expense is already deleted.", 409)
    revisions_col.insert_one({"expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_rev, "action": "delete",
                              "changes": {"status": {"from": "active", "to": "deleted"}}, "snapshot_before": snapshot(exp), "snapshot_after": snapshot(updated),
                              "user_id": str(g.user["_id"]), "user_name": user_display(g.user), "at": now, "reason": reason})
    record_audit("expense_deleted", "expense", exp["expense_id"], {"reason": reason, "amount": exp["amount"], "description": exp["description"]},
                 project_id=exp["project_id"])
    return jsonify({"expense": serialize(updated)})


@app.route("/api/expenses/<expense_ref>/restore", methods=["POST"])
@require("expense:restore")
def api_expenses_restore(expense_ref):
    exp = load_expense(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    if exp["status"] != "deleted":
        return json_error("This expense is not deleted.", 409)
    reason = clean_str((request.get_json(silent=True) or {}).get("reason"), 300)
    if len(reason) < 3:
        return json_error("A reason is required.")
    now, new_rev = utcnow(), exp.get("revision", 1) + 1
    entry = {"restored_by_name": user_display(g.user), "restored_at": now, "reason": reason,
             "previous_deletion": {"deleted_by_name": exp.get("deleted_by_name"), "deleted_at": exp.get("deleted_at"), "reason": exp.get("deletion_reason")}}
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "status": "deleted"},
        {"$set": {"status": "active", "deleted_by": None, "deleted_at": None, "deletion_reason": None, "revision": new_rev, "updated_at": now},
         "$push": {"restoration_history": entry}}, return_document=ReturnDocument.AFTER)
    revisions_col.insert_one({"expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_rev, "action": "restore",
                              "changes": {"status": {"from": "deleted", "to": "active"}}, "snapshot_before": snapshot(exp), "snapshot_after": snapshot(updated),
                              "user_id": str(g.user["_id"]), "user_name": user_display(g.user), "at": now, "reason": reason})
    record_audit("expense_restored", "expense", exp["expense_id"], {"reason": reason}, project_id=exp["project_id"])
    return jsonify({"expense": serialize(updated)})


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

def period_range(args):
    period, now = args.get("period", "all_time"), utcnow()
    df, dt = parse_date(args.get("date_from")), parse_date(args.get("date_to"), end_of_day=True)
    if df or dt:
        return df, dt, "Custom range"
    if period == "this_month":
        return datetime(now.year, now.month, 1, tzinfo=timezone.utc), None, now.strftime("%B %Y")
    if period == "last_month":
        end = datetime(now.year, now.month, 1, tzinfo=timezone.utc) - timedelta(milliseconds=1)
        return datetime(end.year, end.month, 1, tzinfo=timezone.utc), end, end.strftime("%B %Y")
    if period == "this_quarter":
        qm = ((now.month - 1) // 3) * 3 + 1
        return datetime(now.year, qm, 1, tzinfo=timezone.utc), None, f"Q{(now.month - 1) // 3 + 1} {now.year}"
    if period == "this_year":
        return datetime(now.year, 1, 1, tzinfo=timezone.utc), None, str(now.year)
    if period == "last_30_days":
        return now - timedelta(days=30), None, "Last 30 days"
    if period == "last_90_days":
        return now - timedelta(days=90), None, "Last 90 days"
    return None, None, "All time"


def partner_summary(project, match):
    """Share vs actually paid for each partner, plus who should pay whom to settle."""
    partners = [p for p in project.get("partners", []) if p.get("active", True)]
    paid = {r["_id"]: round(r["total"], 2) for r in expenses_col.aggregate([
        {"$match": match}, {"$unwind": "$payments"},
        {"$group": {"_id": "$payments.partner_id", "total": {"$sum": "$payments.amount"}, "count": {"$sum": 1}}}])}
    counts = {r["_id"]: r["count"] for r in expenses_col.aggregate([
        {"$match": match}, {"$unwind": "$payments"}, {"$group": {"_id": "$payments.partner_id", "count": {"$sum": 1}}}])}
    total = round(sum(paid.values()), 2)
    rows = []
    for p in project.get("partners", []):
        if not p.get("active", True) and not paid.get(p["id"]):
            continue
        share = p["share"] if p.get("active", True) else 0
        should = round(total * share / 100, 2)
        actual = paid.get(p["id"], 0)
        net = round(actual - should, 2)
        paid_pct = round(actual / total * 100, 2) if total else 0
        rows.append({"partner_id": p["id"], "name": p["name"], "phone": p.get("phone", ""), "active": p.get("active", True), "share": share,
                     "should_bear": should, "paid": actual, "paid_pct": paid_pct, "pct_diff": round(paid_pct - share, 2),
                     "net": net, "count": counts.get(p["id"], 0),
                     "status": "paid_more" if net > 0.5 else ("deficit" if net < -0.5 else "balanced")})
    # Settlement suggestion: who owes whom (greedy match of deficits to surpluses).
    owes = sorted([[r["name"], -r["net"]] for r in rows if r["net"] < -0.5], key=lambda x: -x[1])
    gets = sorted([[r["name"], r["net"]] for r in rows if r["net"] > 0.5], key=lambda x: -x[1])
    settlements = []
    i = j = 0
    while i < len(owes) and j < len(gets):
        amt = round(min(owes[i][1], gets[j][1]), 2)
        settlements.append({"from": owes[i][0], "to": gets[j][0], "amount": amt})
        owes[i][1] -= amt
        gets[j][1] -= amt
        if owes[i][1] < 0.5:
            i += 1
        if gets[j][1] < 0.5:
            j += 1
    return {"total": total, "partners": rows, "settlements": settlements}


def trend_series(match, granularity, partner_id=None):
    fmt = {"day": "%Y-%m-%d", "month": "%Y-%m", "year": "%Y"}.get(granularity, "%Y-%m")
    pre = [{"$match": match}]
    amount = "$amount"
    if partner_id:
        pre += [{"$unwind": "$payments"}, {"$match": {"payments.partner_id": partner_id}}]
        amount = "$payments.amount"
    if granularity == "quarter":
        pipeline = pre + [{"$group": {"_id": {"y": {"$year": "$transaction_date"}, "q": {"$ceil": {"$divide": [{"$month": "$transaction_date"}, 3]}}},
                                      "total": {"$sum": amount}, "count": {"$sum": 1}}}, {"$sort": {"_id.y": 1, "_id.q": 1}}]
        return [{"label": f"{r['_id']['y']}-Q{int(r['_id']['q'])}", "total": round(r["total"], 2), "count": r["count"]} for r in expenses_col.aggregate(pipeline)]
    pipeline = pre + [{"$group": {"_id": {"$dateToString": {"format": fmt, "date": "$transaction_date"}}, "total": {"$sum": amount}, "count": {"$sum": 1}}},
                      {"$sort": {"_id": 1}}]
    return [{"label": r["_id"], "total": round(r["total"], 2), "count": r["count"]} for r in expenses_col.aggregate(pipeline)]


def dashboard_data(project, args):
    date_from, date_to, label = period_range(args)
    match = {"project_id": str(project["_id"]), "status": "active"}
    if date_from or date_to:
        match["transaction_date"] = {k: v for k, v in (("$gte", date_from), ("$lte", date_to)) if v}
    partner_id = args.get("partner_id") or None
    partner = next((p for p in project.get("partners", []) if p["id"] == partner_id), None) if partner_id else None
    # When one partner is selected, every number below is "what this partner paid".
    pre = [{"$match": match}]
    amount = "$amount"
    if partner:
        pre += [{"$unwind": "$payments"}, {"$match": {"payments.partner_id": partner_id}}]
        amount = "$payments.amount"

    def group(key, extra=None, limit=None, sort=True):
        g_ = {"_id": key, "total": {"$sum": amount}, "count": {"$sum": 1}}
        g_.update(extra or {})
        pipe = pre + [{"$group": g_}]
        if sort:
            pipe.append({"$sort": {"total": -1}})
        if limit:
            pipe.append({"$limit": limit})
        return list(expenses_col.aggregate(pipe))

    totals = list(expenses_col.aggregate(pre + [{"$group": {"_id": None, "total": {"$sum": amount}, "count": {"$sum": 1},
                                                             "average": {"$avg": amount}, "max": {"$max": amount}}}]))
    t = totals[0] if totals else {"total": 0, "count": 0, "average": 0, "max": 0}
    item_match = dict(match, **({"payments.partner_id": partner_id} if partner else {}))
    largest = list(expenses_col.find(item_match).sort("amount", -1).limit(1))
    by_category = group("$category_id", {"name": {"$first": {"$arrayElemAt": ["$category_path", 0]}}})
    by_sub = list(expenses_col.aggregate(pre + [{"$match": {"subcategory_id": {"$ne": None}}},
                                                {"$group": {"_id": "$subcategory_id", "path": {"$first": "$category_path"}, "category_id": {"$first": "$category_id"},
                                                            "total": {"$sum": amount}, "count": {"$sum": 1}}}, {"$sort": {"total": -1}}, {"$limit": 15}]))
    by_payment = group({"$ifNull": ["$payment_method", ""]})
    top_vendors = list(expenses_col.aggregate(pre + [{"$match": {"vendor": {"$nin": ["", None]}}},
                                                     {"$group": {"_id": "$vendor", "total": {"$sum": amount}, "count": {"$sum": 1}}}, {"$sort": {"total": -1}}, {"$limit": 8}]))
    recent = list(expenses_col.find(item_match).sort([("transaction_date", -1), ("created_at", -1)]).limit(8))
    span_days = ((date_to or utcnow()) - date_from).days if date_from else 9999
    granularity = args.get("granularity") or ("day" if span_days <= 62 else "month")
    return {
        "period": {"label": label, "date_from": serialize(date_from), "date_to": serialize(date_to)},
        "partner_filter": {"partner_id": partner_id, "name": partner["name"]} if partner else None,
        "totals": {"total": round(t["total"] or 0, 2), "count": t["count"], "average": round(t["average"] or 0, 2), "max": round(t["max"] or 0, 2)},
        "largest": serialize(largest[0]) if largest else None,
        "by_category": [{"category_id": r["_id"], "name": r["name"] or "Uncategorised", "total": round(r["total"], 2), "count": r["count"]} for r in by_category],
        "by_subcategory": [{"subcategory_id": r["_id"], "category_id": r["category_id"], "name": " > ".join(r["path"]), "total": round(r["total"], 2), "count": r["count"]} for r in by_sub],
        "by_payment_method": [{"name": r["_id"] or "Not specified", "total": round(r["total"], 2), "count": r["count"]} for r in by_payment],
        "top_vendors": [{"vendor": r["_id"], "total": round(r["total"], 2), "count": r["count"]} for r in top_vendors],
        "recent": serialize(recent),
        "trend": {"granularity": granularity, "points": trend_series(match, granularity, partner_id)},
        "partner_summary": partner_summary(project, match),
    }


@app.route("/api/dashboard/summary")
@require("expense:view")
@require_project
def api_dashboard_summary():
    return jsonify(dashboard_data(g.project, request.args))


def default_preferences():
    sizes = {w["id"]: w["size"] for w in DASHBOARD_WIDGETS}
    return {"layout": [{"id": w, "visible": True, "size": sizes[w]} for w in DEFAULT_LAYOUT], "default_period": "all_time",
            "custom_range": {"date_from": None, "date_to": None}, "chart_type_category": "bar", "trend_granularity": "auto"}


@app.route("/api/dashboard/preferences")
@login_required
@require_project
def api_prefs_get():
    doc = prefs_col.find_one({"user_id": str(g.user["_id"]), "project_id": g.project_id})
    return jsonify({"preferences": doc["preferences"] if doc else default_preferences(), "is_default": doc is None})


@app.route("/api/dashboard/preferences", methods=["PUT"])
@require("dashboard:customize")
@require_project
def api_prefs_put():
    data = request.get_json(silent=True) or {}
    valid = {w["id"] for w in DASHBOARD_WIDGETS}
    layout, seen = [], set()
    for item in data.get("layout", []):
        if item.get("id") in valid and item["id"] not in seen:
            seen.add(item["id"])
            layout.append({"id": item["id"], "visible": bool(item.get("visible", True)),
                           "size": item.get("size") if item.get("size") in ("small", "medium", "large") else "medium"})
    if not layout:
        return json_error("Choose at least one widget.")
    periods = ("this_month", "last_month", "this_quarter", "this_year", "last_30_days", "last_90_days", "all_time", "custom")
    cr = data.get("custom_range") or {}
    prefs = {"layout": layout, "default_period": data.get("default_period") if data.get("default_period") in periods else "all_time",
             "custom_range": {"date_from": clean_str(cr.get("date_from"), 10) or None, "date_to": clean_str(cr.get("date_to"), 10) or None},
             "chart_type_category": data.get("chart_type_category") if data.get("chart_type_category") in ("bar", "donut") else "bar",
             "trend_granularity": data.get("trend_granularity") if data.get("trend_granularity") in ("auto", "day", "month", "quarter", "year") else "auto"}
    key = {"user_id": str(g.user["_id"]), "project_id": g.project_id}
    try:
        prefs_col.update_one(key, {"$set": {"preferences": prefs, "updated_at": utcnow()}}, upsert=True)
    except DuplicateKeyError:
        prefs_col.delete_many({"user_id": key["user_id"], "project_id": {"$exists": False}})
        prefs_col.update_one(key, {"$set": {"preferences": prefs, "updated_at": utcnow()}}, upsert=True)
    return jsonify({"preferences": prefs})


@app.route("/api/dashboard/preferences", methods=["DELETE"])
@require("dashboard:customize")
@require_project
def api_prefs_reset():
    prefs_col.delete_one({"user_id": str(g.user["_id"]), "project_id": g.project_id})
    return jsonify({"preferences": default_preferences()})


# ---------------------------------------------------------------------------
# Saved filters
# ---------------------------------------------------------------------------

@app.route("/api/filters")
@login_required
@require_project
def api_filters_list():
    return jsonify({"filters": serialize(list(filters_col.find({"user_id": str(g.user["_id"]), "project_id": g.project_id}).sort("name", ASCENDING)))})


@app.route("/api/filters", methods=["POST"])
@login_required
@require_project
def api_filters_create():
    data = request.get_json(silent=True) or {}
    name, params = clean_str(data.get("name"), 60), data.get("params") or {}
    if len(name) < 2 or not isinstance(params, dict):
        return json_error("Give the filter a name.")
    clean = {}
    for k, v in params.items():
        if isinstance(v, list):
            v = ",".join(clean_str(x, 100) for x in v if x not in (None, ""))
        if v not in (None, "", False):
            clean[clean_str(k, 40)] = clean_str(v, 200)
    key = {"user_id": str(g.user["_id"]), "project_id": g.project_id, "name": name}
    filters_col.update_one(key, {"$set": dict(key, params=clean, created_at=utcnow())}, upsert=True)
    return jsonify({"filter": serialize(filters_col.find_one(key))}), 201


@app.route("/api/filters/<filter_id>", methods=["DELETE"])
@login_required
def api_filters_delete(filter_id):
    if not filters_col.delete_one({"_id": to_oid(filter_id), "user_id": str(g.user["_id"])}).deleted_count:
        return json_error("Filter not found.", 404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------

@app.route("/api/audit")
@require("audit:view")
def api_audit():
    query = {}
    kind = request.args.get("kind", "changes")
    if kind == "logins":
        query["action"] = {"$in": LOGIN_ACTIONS}
    elif kind == "deleted":
        query["action"] = {"$in": ["expense_deleted", "expense_restored", "expense_purged"]}
    elif kind == "edits":
        query["action"] = "expense_edited"
    else:
        query["action"] = {"$nin": LOGIN_ACTIONS}
    if request.args.get("action"):
        query["action"] = request.args["action"]
    if request.args.get("entity_id"):
        query["entity_id"] = request.args["entity_id"]
    if request.args.get("user_id"):
        query["user_id"] = request.args["user_id"]
    if g.project_id and kind != "logins":
        query["$or"] = [{"project_id": g.project_id}, {"project_id": None}]
    df, dt = parse_date(request.args.get("date_from")), parse_date(request.args.get("date_to"), end_of_day=True)
    if df or dt:
        query["at"] = {k: v for k, v in (("$gte", df), ("$lte", dt)) if v}
    try:
        page, per_page = max(1, int(request.args.get("page", 1))), min(200, max(10, int(request.args.get("per_page", 50))))
    except ValueError:
        page, per_page = 1, 50
    total = audit_col.count_documents(query)
    docs = list(audit_col.find(query).sort("at", DESCENDING).skip((page - 1) * per_page).limit(per_page))
    return jsonify({"items": serialize(docs), "total": total, "page": page, "pages": max(1, -(-total // per_page)),
                    "actions": sorted(a for a in audit_col.distinct("action") if a)})


@app.route("/api/export/audit.csv")
@require("audit:view")
def api_export_audit_csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Time (UTC)", "User", "Action", "Entity Type", "Entity ID", "IP", "Details"])
    for row in audit_col.find({}).sort("at", DESCENDING).limit(20000):
        w.writerow([row["at"].strftime("%Y-%m-%d %H:%M:%S"), row.get("user_name"), row.get("action"), row.get("entity_type"),
                    row.get("entity_id"), row.get("ip"), json.dumps(serialize(row.get("details", {})))])
    record_audit("export_audit", "export", None)
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv; charset=utf-8", headers={"Content-Disposition": "attachment; filename=audit_log.csv"})


# ---------------------------------------------------------------------------
# Reports and exports (CSV + PDF)
# ---------------------------------------------------------------------------

def fmt_inr(n):
    """Indian grouping: 12,34,567.00"""
    n = float(n or 0)
    neg = n < 0
    whole, frac = f"{abs(n):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts) + "," + tail
    return ("-" if neg else "") + whole + "." + frac


def expense_rows(project, query):
    partners = [p for p in project.get("partners", [])]
    custom_fields = project.get("custom_fields", [])
    cfg = project.get("field_config") or {}
    head = ["Expense ID", "Date", "Description", "Category", "Subcategory", "Amount (INR)"] + [f"Paid by {p['name']}" for p in partners]
    head += [label for key, label in OPTIONAL_FIELDS if cfg.get(key, {}).get("enabled")] + [f["label"] for f in custom_fields]
    head += ["Status", "Revision", "Created By", "Created At"]
    rows = []
    for e in expenses_col.find(query).sort("transaction_date", ASCENDING):
        path = e.get("category_path") or []
        paid = {p["partner_id"]: p["amount"] for p in e.get("payments", [])}
        row = [e["expense_id"], e["transaction_date"].strftime("%d-%m-%Y"), e["description"], path[0] if path else "",
               " > ".join(path[1:]), e["amount"]] + [paid.get(p["id"], 0) or "" for p in partners]
        row += [e.get(key, "") for key, _ in OPTIONAL_FIELDS if cfg.get(key, {}).get("enabled")]
        row += [(e.get("custom") or {}).get(f["key"], "") for f in custom_fields]
        row += [e["status"], e.get("revision", 1), e.get("created_by_name", ""), e["created_at"].strftime("%d-%m-%Y %H:%M")]
        rows.append(row)
    return head, rows


def csv_response(filename, sheets):
    """sheets = [(title, head, rows), ...] written one after another."""
    buf = io.StringIO()
    w = csv.writer(buf)
    for i, (title, head, rows) in enumerate(sheets):
        if i:
            w.writerow([])
        if title:
            w.writerow([title])
        w.writerow(head)
        for r in rows:
            w.writerow([int(v) if isinstance(v, float) and v.is_integer() else v for v in r])
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv; charset=utf-8", headers={"Content-Disposition": f"attachment; filename={filename}"})


def pdf_response(filename, title, subtitle, sheets, landscape_mode=False):
    try:
        import reportlab  # noqa: F401
    except ImportError:
        return json_error("PDF support is not installed on the server. Run: pip install reportlab", 500)
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    buf = io.BytesIO()
    page = landscape(A4) if landscape_mode else A4
    doc = SimpleDocTemplate(buf, pagesize=page, leftMargin=12 * mm, rightMargin=12 * mm, topMargin=14 * mm, bottomMargin=14 * mm, title=title)
    styles = getSampleStyleSheet()
    from reportlab.lib.enums import TA_RIGHT
    cell = ParagraphStyle("cell", parent=styles["BodyText"], fontSize=7.5, leading=9)
    cell_r = ParagraphStyle("cell_r", parent=cell, alignment=TA_RIGHT)
    story = [Paragraph(title, styles["Title"]), Paragraph(subtitle, styles["Normal"]), Spacer(1, 6)]
    for sheet_title, head, rows in sheets:
        if sheet_title:
            story += [Spacer(1, 8), Paragraph(sheet_title, styles["Heading3"])]
        numeric = [any(isinstance(r[i], float) for r in rows if i < len(r)) for i in range(len(head))]
        data = [[Paragraph(str(h), cell_r if numeric[i] else cell) for i, h in enumerate(head)]]
        for r in rows:
            data.append([Paragraph(fmt_inr(v) if isinstance(v, float) else str(v if v is not None else ""), cell_r if numeric[i] else cell) for i, v in enumerate(r)])
        if len(data) == 1:
            data.append([Paragraph("No records", cell)] + [""] * (len(head) - 1))
        tbl = Table(data, repeatRows=1)
        style = [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e3efe9")), ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#b9c2bc")),
                 ("VALIGN", (0, 0), (-1, -1), "TOP"), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f6f8f6")])]
        for ri, r in enumerate(rows, start=1):
            first = str(r[0]) if r else ""
            if first.startswith("TOTAL") or first.startswith("Subtotal"):
                style.append(("BACKGROUND", (0, ri), (-1, ri), colors.HexColor("#d7e6de")))
            elif first.startswith("—"):
                style.append(("BACKGROUND", (0, ri), (-1, ri), colors.HexColor("#eef2ef")))
        tbl.setStyle(TableStyle(style))
        story.append(tbl)
    doc.build(story)
    buf.seek(0)
    return send_file(buf, mimetype="application/pdf", as_attachment=True, download_name=filename)


@app.route("/api/reports/<kind>.<fmt>")
@require("export")
@require_project
def api_report(kind, fmt):
    if fmt not in ("csv", "pdf") or kind not in ("full", "category", "partner", "expenses"):
        abort(404)
    args = request.args
    query, err = build_expense_query(args, g.user, g.project_id)
    if err:
        return json_error(err)
    date_from, date_to, label = period_range(args)
    if date_from or date_to:
        query["transaction_date"] = {k: v for k, v in (("$gte", date_from), ("$lte", date_to)) if v}
    data = dashboard_data(g.project, args)
    stamp = utcnow().strftime("%Y%m%d_%H%M")
    subtitle = f"Project: {g.project['name']} · Period: {label}" + (f" · Partner: {data['partner_filter']['name']}" if data["partner_filter"] else "") + \
               f" · Generated {utcnow().strftime('%d-%m-%Y %H:%M')} UTC by {user_display(g.user)}"
    total = data["totals"]["total"] or 1

    cat_sheet = ("Category-wise summary", ["Category", "Expenses", "Amount (INR)", "Share %"],
                 [[c["name"], c["count"], float(c["total"]), f"{c['total'] / total * 100:.1f}%"] for c in data["by_category"]] +
                 [["TOTAL", data["totals"]["count"], float(data["totals"]["total"]), "100%"]])
    sub_sheet = ("Subcategory-wise summary", ["Subcategory", "Expenses", "Amount (INR)"],
                 [[c["name"], c["count"], float(c["total"])] for c in data["by_subcategory"]])
    ps = data["partner_summary"]
    partner_sheet = ("Partner-wise summary", ["Partner", "Share %", "Should bear (INR)", "Actually paid (INR)", "Paid %", "Net (paid − share)", "Status", "Payments"],
                     [[p["name"], f"{p['share']:g}%", float(p["should_bear"]), float(p["paid"]), f"{p['paid_pct']:.1f}%", float(p["net"]),
                       {"paid_more": "Paid more", "deficit": "Deficit", "balanced": "Balanced"}[p["status"]], p["count"]] for p in ps["partners"]] +
                     [["TOTAL", "100%", float(ps["total"]), float(ps["total"]), "100%", 0.0, "", ""]])
    settle_sheet = ("Settlement needed", ["From", "To", "Amount (INR)"], [[s["from"], s["to"], float(s["amount"])] for s in ps["settlements"]] or [["—", "Nothing to settle", 0.0]])
    partner_cat = ("Partner payments by category", ["Category"] + [p["name"] for p in ps["partners"]] + ["Total"], partner_by_category(g.project, query, ps["partners"]))
    head, rows = expense_rows(g.project, query)
    expenses_sheet = ("All expenses", head, rows)

    if kind == "category":
        sheets, title = [cat_sheet, sub_sheet], "Category-wise report"
    elif kind == "partner":
        pay_head, pay_rows = partner_payment_rows(g.project, query, ps["partners"])
        cat_head, cat_rows = partner_rows_by_category(g.project, query, ps["partners"])
        sheets, title = [("Payments by partner — all expenses", pay_head, pay_rows),
                         ("Category-wise totals", ["Category"] + [p["name"] for p in ps["partners"]] + ["Total"], partner_by_category(g.project, query, ps["partners"])),
                         ("Category-wise — every expense", cat_head, cat_rows),
                         partner_sheet, settle_sheet], "Partner-wise report"
    elif kind == "expenses":
        sheets, title = [expenses_sheet], "Expenses"
    else:
        sheets, title = [("Summary", ["Total expenses (INR)", "Number of expenses", "Average (INR)", "Largest (INR)"],
                          [[float(data["totals"]["total"]), data["totals"]["count"], float(data["totals"]["average"]), float(data["totals"]["max"])]]),
                         partner_sheet, settle_sheet, cat_sheet, sub_sheet, partner_cat, expenses_sheet], "Full expense report"
    record_audit(f"report_{fmt}", "export", kind, {"period": label})
    filename = f"{kind}_report_{stamp}.{fmt}"
    if fmt == "csv":
        return csv_response(filename, sheets)
    return pdf_response(filename, f"{title} — {g.project['name']}", subtitle, sheets, landscape_mode=(kind in ("full", "expenses", "partner")))


def partner_payment_rows(project, query, partner_rows):
    """Expense | Date | Category | Total | <partner 1> | <partner 2> ... one row per expense, plus a total row."""
    head = ["Expense", "Date", "Category", "Total (INR)"] + [p["name"] for p in partner_rows]
    rows, sums = [], [0.0] * len(partner_rows)
    grand = 0.0
    for e in expenses_col.find(query).sort([("transaction_date", ASCENDING), ("expense_id", ASCENDING)]):
        paid = {x["partner_id"]: x["amount"] for x in e.get("payments", [])}
        amounts = [float(paid.get(p["partner_id"], 0)) for p in partner_rows]
        for i, a in enumerate(amounts):
            sums[i] += a
        grand += e["amount"]
        rows.append([e["description"], e["transaction_date"].strftime("%d-%m-%Y"), " > ".join(e.get("category_path") or []), float(e["amount"])] + [a or "" for a in amounts])
    rows.append(["TOTAL", "", "", round(grand, 2)] + [round(x, 2) for x in sums])
    return head, rows


def partner_rows_by_category(project, query, partner_rows):
    """Same table but grouped under each category with a subtotal line per category."""
    head = ["Expense", "Date", "Subcategory", "Total (INR)"] + [p["name"] for p in partner_rows]
    groups = {}
    for e in expenses_col.find(query).sort([("transaction_date", ASCENDING)]):
        path = e.get("category_path") or ["Uncategorised"]
        groups.setdefault(path[0], []).append(e)
    rows = []
    for cat, items in sorted(groups.items(), key=lambda kv: -sum(x["amount"] for x in kv[1])):
        rows.append([f"— {cat} —", "", "", "", *([""] * len(partner_rows))])
        sub = [0.0] * len(partner_rows)
        total = 0.0
        for e in items:
            paid = {x["partner_id"]: x["amount"] for x in e.get("payments", [])}
            amounts = [float(paid.get(p["partner_id"], 0)) for p in partner_rows]
            for i, a in enumerate(amounts):
                sub[i] += a
            total += e["amount"]
            rows.append([e["description"], e["transaction_date"].strftime("%d-%m-%Y"), " > ".join((e.get("category_path") or [])[1:]), float(e["amount"])] + [a or "" for a in amounts])
        rows.append([f"Subtotal {cat}", "", "", round(total, 2)] + [round(x, 2) or "" for x in sub])
    return head, rows


def partner_by_category(project, query, partner_rows):
    rows = list(expenses_col.aggregate([{"$match": query}, {"$unwind": "$payments"},
                                        {"$group": {"_id": {"cat": {"$arrayElemAt": ["$category_path", 0]}, "p": "$payments.partner_id"}, "total": {"$sum": "$payments.amount"}}}]))
    by_cat = {}
    for r in rows:
        by_cat.setdefault(r["_id"]["cat"] or "Uncategorised", {})[r["_id"]["p"]] = round(r["total"], 2)
    out = []
    for cat, paid in sorted(by_cat.items(), key=lambda kv: -sum(kv[1].values())):
        out.append([cat] + [float(paid.get(p["partner_id"], 0)) for p in partner_rows] + [float(sum(paid.values()))])
    return out


@app.route("/api/reports/partner-table")
@require("expense:view")
@require_project
def api_partner_table():
    query, err = build_expense_query(request.args, g.user, g.project_id)
    if err:
        return json_error(err)
    date_from, date_to, _ = period_range(request.args)
    if date_from or date_to:
        query["transaction_date"] = {k: v for k, v in (("$gte", date_from), ("$lte", date_to)) if v}
    partners = [{"partner_id": p["id"], "name": p["name"]} for p in g.project.get("partners", []) if p.get("active", True)]
    head, rows = partner_payment_rows(g.project, query, partners)
    return jsonify({"head": head, "rows": rows[-401:], "truncated": len(rows) > 401, "total_rows": len(rows) - 1,
                    "by_category": partner_by_category(g.project, query, partners)})


# ---------------------------------------------------------------------------
# Custom report builder
# ---------------------------------------------------------------------------

custom_reports_col = db["custom_reports"]
ROW_MODES = ["expense", "category", "subcategory", "partner", "month", "vendor"]
GROUP_MODES = ["", "category", "subcategory", "month", "partner", "vendor"]
TEXT_COLUMNS = [("date", "Date"), ("expense", "Expense"), ("category", "Category"), ("subcategory", "Subcategory"), ("vendor", "Vendor"),
                ("payment_method", "Payment method"), ("payment_status", "Payment status"), ("notes", "Notes"), ("expense_id", "Expense ID")]
NUM_COLUMNS = [("total", "Total"), ("count", "Count"), ("pct_total", "% of grand total")]
PARTNER_COLUMNS = [("paid", "{name} paid"), ("share", "{name} should bear"), ("diff", "{name} paid − share"), ("running", "{name} running balance")]


def _ident(name):
    return re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "x"


def safe_eval(expr, variables):
    """Evaluate + - * / % and parentheses over numbers and the given variable names. Nothing else."""
    import ast as _ast
    tree = _ast.parse(expr, mode="eval")

    def ev(node):
        if isinstance(node, _ast.Expression):
            return ev(node.body)
        if isinstance(node, _ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, _ast.Name):
            if node.id not in variables:
                raise ValueError(f"Unknown name '{node.id}'")
            return float(variables[node.id] or 0)
        if isinstance(node, _ast.UnaryOp) and isinstance(node.op, (_ast.USub, _ast.UAdd)):
            v = ev(node.operand)
            return -v if isinstance(node.op, _ast.USub) else v
        if isinstance(node, _ast.BinOp):
            a, b = ev(node.left), ev(node.right)
            if isinstance(node.op, _ast.Add):
                return a + b
            if isinstance(node.op, _ast.Sub):
                return a - b
            if isinstance(node.op, _ast.Mult):
                return a * b
            if isinstance(node.op, _ast.Div):
                return a / b if b else 0.0
            if isinstance(node.op, _ast.Mod):
                return a % b if b else 0.0
        raise ValueError("Only numbers, column names, + - * / % and brackets are allowed.")
    return round(ev(tree), 2)


def custom_report_columns(project):
    """The column list the builder can offer for this project."""
    cols = [{"key": k, "label": l, "kind": "text"} for k, l in TEXT_COLUMNS]
    cols += [{"key": f"custom:{f['key']}", "label": f["label"], "kind": "text"} for f in project.get("custom_fields", [])]
    cols += [{"key": k, "label": l, "kind": "number"} for k, l in NUM_COLUMNS]
    for p in project.get("partners", []):
        if p.get("active", True):
            for k, l in PARTNER_COLUMNS:
                cols.append({"key": f"{k}:{p['id']}", "label": l.format(name=p["name"]), "kind": "number", "partner": p["name"]})
    return cols


def run_custom_report(project, spec, user):
    rows_mode = spec.get("rows") if spec.get("rows") in ROW_MODES else "expense"
    group_by = spec.get("group_by") if spec.get("group_by") in GROUP_MODES else ""
    if rows_mode != "expense":
        group_by = ""
    wanted = [c for c in (spec.get("columns") or []) if isinstance(c, str)]
    formulas = [{"label": clean_str(f.get("label"), 40), "expr": clean_str(f.get("expr"), 200)} for f in (spec.get("formulas") or []) if f.get("expr")]
    filters = spec.get("filters") or {}

    class Args(dict):
        def getlist(self, k):
            v = self.get(k)
            return [] if v in (None, "") else [v] if not isinstance(v, list) else v
    args = Args({k: v for k, v in filters.items() if v not in (None, "", [])})
    query, err = build_expense_query(args, user, str(project["_id"]))
    if err:
        return None, err
    date_from, date_to, period_label = period_range(args)
    if date_from or date_to:
        query["transaction_date"] = {k: v for k, v in (("$gte", date_from), ("$lte", date_to)) if v}

    partners = [p for p in project.get("partners", []) if p.get("active", True)]
    pids = [p["id"] for p in partners]
    pname = {p["id"]: p["name"] for p in partners}
    share_pct = {p["id"]: p["share"] for p in partners}
    available = {c["key"] for c in custom_report_columns(project)}
    wanted = [c for c in wanted if c in available]
    if not wanted and rows_mode == "expense":
        wanted = ["date", "expense", "category", "total"] + [f"paid:{pid}" for pid in pids]

    # one base record per expense
    records = []
    for e in expenses_col.find(query).sort([("transaction_date", ASCENDING), ("expense_id", ASCENDING)]):
        path = e.get("category_path") or ["Uncategorised"]
        paid = {x["partner_id"]: float(x["amount"]) for x in e.get("payments", [])}
        rec = {"date": e["transaction_date"].strftime("%d-%m-%Y"), "month": e["transaction_date"].strftime("%Y-%m"), "expense": e["description"],
               "expense_id": e["expense_id"], "category": path[0], "subcategory": " > ".join(path[1:]), "vendor": e.get("vendor") or "",
               "payment_method": e.get("payment_method") or "", "payment_status": e.get("payment_status") or "", "notes": e.get("notes") or "",
               "total": float(e["amount"]), "count": 1}
        for f in project.get("custom_fields", []):
            rec[f"custom:{f['key']}"] = (e.get("custom") or {}).get(f["key"], "")
        for pid in pids:
            rec[f"paid:{pid}"] = paid.get(pid, 0.0)
            rec[f"share:{pid}"] = round(rec["total"] * share_pct[pid] / 100, 2)
            rec[f"diff:{pid}"] = round(rec[f"paid:{pid}"] - rec[f"share:{pid}"], 2)
        records.append(rec)
    grand = sum(r["total"] for r in records) or 0.0
    numeric_keys = ["total", "count"] + [f"{k}:{pid}" for pid in pids for k in ("paid", "share", "diff")]

    def finish(rec, running):
        rec["pct_total"] = round(rec["total"] / grand * 100, 2) if grand else 0.0
        for pid in pids:
            running[pid] = round(running.get(pid, 0.0) + rec[f"diff:{pid}"], 2)
            rec[f"running:{pid}"] = running[pid]
        variables = {"Total": rec["total"], "Count": rec["count"], "Pct": rec["pct_total"]}
        for pid in pids:
            n = _ident(pname[pid])
            variables[f"{n}_paid"], variables[f"{n}_share"], variables[f"{n}_diff"] = rec[f"paid:{pid}"], rec[f"share:{pid}"], rec[f"diff:{pid}"]
        for f in formulas:
            try:
                rec[f"formula:{f['label']}"] = safe_eval(f["expr"], variables)
            except Exception as exc:
                rec[f"formula:{f['label']}"] = f"error: {exc}"[:60]
        return rec

    def aggregate(key_fn, label):
        groups = {}
        for r in records:
            g_ = groups.setdefault(key_fn(r), {"label": key_fn(r), "total": 0.0, "count": 0, **{k: 0.0 for k in numeric_keys if k not in ("total", "count")}})
            for k in numeric_keys:
                g_[k] += r[k]
        out = []
        running = {}
        for g_ in sorted(groups.values(), key=lambda x: (-x["total"]) if label != "Month" else x["label"]):
            out.append(finish(dict(g_, **{k: round(v, 2) for k, v in g_.items() if isinstance(v, float)}), running))
        return out

    # build the table
    head, table = [], []
    cols_meta = {c["key"]: c for c in custom_report_columns(project)}
    def col_label(k):
        return k.split(":", 1)[1] if k.startswith("formula:") else cols_meta.get(k, {}).get("label", k)

    if rows_mode == "partner":
        head = ["Partner", "Share %", "Should bear", "Paid", "Paid − share", "% of total", "Count"] + [f["label"] for f in formulas]
        for pid in pids:
            paid_sum = round(sum(r[f"paid:{pid}"] for r in records), 2)
            should = round(grand * share_pct[pid] / 100, 2)
            variables = {"Total": grand, "Count": len(records), "Paid": paid_sum, "Share": should, "Diff": round(paid_sum - should, 2)}
            row = [pname[pid], f"{share_pct[pid]:g}%", should, paid_sum, round(paid_sum - should, 2), round(paid_sum / grand * 100, 2) if grand else 0.0,
                   sum(1 for r in records if r[f"paid:{pid}"])]
            for f in formulas:
                try:
                    row.append(safe_eval(f["expr"], variables))
                except Exception as exc:
                    row.append(f"error: {exc}"[:60])
            table.append(row)
        table.append(["TOTAL", "100%", round(grand, 2), round(grand, 2), 0.0, 100.0, len(records)] + [""] * len(formulas))
        return {"head": head, "rows": table, "period": period_label, "row_mode": rows_mode, "count": len(records)}, None

    numeric_wanted = [c for c in wanted if c in numeric_keys or c == "pct_total" or c.startswith("running:")]
    text_wanted = [c for c in wanted if c not in numeric_wanted]
    if rows_mode == "expense":
        keys = wanted + [f"formula:{f['label']}" for f in formulas]
        head = [col_label(k) for k in keys]
        running = {}
        if group_by:
            key_fn = (lambda r: r["category"]) if group_by == "category" else (lambda r: r["subcategory"] or "(none)") if group_by == "subcategory" else \
                     (lambda r: r["month"]) if group_by == "month" else (lambda r: r["vendor"] or "(none)") if group_by == "vendor" else \
                     (lambda r: ", ".join(pname[pid] for pid in pids if r[f"paid:{pid}"]) or "(none)")
            groups = {}
            for r in records:
                groups.setdefault(key_fn(r), []).append(r)
            order = sorted(groups.items(), key=lambda kv: kv[0] if group_by == "month" else -sum(x["total"] for x in kv[1]))
            for gkey, items in order:
                table.append([f"— {gkey} —"] + [""] * (len(keys) - 1))
                sub = {k: 0.0 for k in keys}
                for r in items:
                    r = finish(r, running)
                    table.append([r.get(k, "") if not (isinstance(r.get(k), float) and r.get(k) == 0 and k != "pct_total") else "" for k in keys])
                    for k in keys:
                        if isinstance(r.get(k), (int, float)) and not k.startswith("running:"):
                            sub[k] += r[k]
                table.append([("Subtotal " + gkey) if i == 0 else (round(sub[k], 2) if (k in numeric_keys or k == "pct_total" or k.startswith("formula:")) and i > 0 else "")
                              for i, k in enumerate(keys)])
        else:
            for r in records:
                r = finish(r, running)
                table.append([r.get(k, "") if not (isinstance(r.get(k), float) and r.get(k) == 0 and k != "pct_total") else "" for k in keys])
        totals = {k: round(sum(r[k] for r in records if isinstance(r.get(k), (int, float))), 2) for k in keys if k in numeric_keys or k == "pct_total"}
        table.append([("TOTAL" if i == 0 else totals.get(k, "")) for i, k in enumerate(keys)])
    else:
        key_name = {"category": ("category", "Category"), "subcategory": ("subcategory", "Subcategory"), "month": ("month", "Month"), "vendor": ("vendor", "Vendor")}[rows_mode]
        rows_agg = aggregate(lambda r: r[key_name[0]] or "(none)", key_name[1])
        keys = [k for k in wanted if k in numeric_keys or k == "pct_total"] or ["total", "count"]
        keys = keys + [f"formula:{f['label']}" for f in formulas]
        head = [key_name[1]] + [col_label(k) for k in keys]
        for r in rows_agg:
            table.append([r["label"]] + [r.get(k, "") if not (isinstance(r.get(k), float) and r.get(k) == 0 and k != "pct_total") else "" for k in keys])
        table.append(["TOTAL"] + [round(sum(r[k] for r in rows_agg if isinstance(r.get(k), (int, float))), 2) if (k in numeric_keys or k == "pct_total") else "" for k in keys])
    return {"head": head, "rows": table, "period": period_label, "row_mode": rows_mode, "count": len(records),
            "ignored_text_columns": [col_label(c) for c in text_wanted] if rows_mode != "expense" else []}, None


@app.route("/api/reports/custom/options")
@require("expense:view")
@require_project
def api_custom_options():
    partners = [p for p in g.project.get("partners", []) if p.get("active", True)]
    variables = ["Total", "Count", "Pct"] + [f"{_ident(p['name'])}_{k}" for p in partners for k in ("paid", "share", "diff")]
    return jsonify({"columns": custom_report_columns(g.project), "row_modes": ROW_MODES, "group_modes": GROUP_MODES, "formula_variables": variables,
                    "categories": [{"id": str(c["_id"]), "name": c["name"]} for c in categories_col.find({"project_id": g.project_id, "level": 0, "status": "active"}).sort("sort_order", 1)]})


@app.route("/api/reports/custom/run", methods=["POST"])
@require("expense:view")
@require_project
def api_custom_run():
    result, err = run_custom_report(g.project, request.get_json(silent=True) or {}, g.user)
    if err:
        return json_error(err)
    return jsonify(result)


@app.route("/api/reports/custom/download.<fmt>")
@require("export")
@require_project
def api_custom_download(fmt):
    if fmt not in ("csv", "pdf"):
        abort(404)
    spec = None
    if request.args.get("report_id"):
        doc = custom_reports_col.find_one({"_id": to_oid(request.args["report_id"]), "project_id": g.project_id})
        spec = doc["spec"] if doc else None
        name = doc["name"] if doc else "custom"
    else:
        try:
            spec = json.loads(request.args.get("spec") or "{}")
        except ValueError:
            return json_error("Bad report definition.")
        name = clean_str(request.args.get("name"), 60) or "custom"
    if spec is None:
        return json_error("Report not found.", 404)
    result, err = run_custom_report(g.project, spec, g.user)
    if err:
        return json_error(err)
    record_audit(f"custom_report_{fmt}", "export", name, {"period": result["period"]})
    filename = f"{_ident(name).lower()}_{utcnow().strftime('%Y%m%d_%H%M')}.{fmt}"
    sheets = [(None, result["head"], result["rows"])]
    if fmt == "csv":
        return csv_response(filename, sheets)
    subtitle = f"Project: {g.project['name']} · Period: {result['period']} · {result['count']} expenses · Generated {utcnow().strftime('%d-%m-%Y %H:%M')} UTC by {user_display(g.user)}"
    return pdf_response(filename, f"{name} — {g.project['name']}", subtitle, sheets, landscape_mode=len(result["head"]) > 6)


@app.route("/api/reports/custom")
@require("expense:view")
@require_project
def api_custom_list():
    docs = list(custom_reports_col.find({"project_id": g.project_id}).sort("name", ASCENDING))
    return jsonify({"reports": serialize(docs)})


@app.route("/api/reports/custom", methods=["POST"])
@require("expense:edit")
@require_project
def api_custom_save():
    data = request.get_json(silent=True) or {}
    name = clean_str(data.get("name"), 60)
    spec = data.get("spec") or {}
    if len(name) < 2 or not isinstance(spec, dict):
        return json_error("Give the report a name.")
    key = {"project_id": g.project_id, "name": name}
    custom_reports_col.update_one(key, {"$set": dict(key, spec=spec, updated_at=utcnow(), updated_by=user_display(g.user)),
                                        "$setOnInsert": {"created_at": utcnow(), "created_by": user_display(g.user)}}, upsert=True)
    record_audit("custom_report_saved", "report", name, {"rows": spec.get("rows"), "columns": spec.get("columns")})
    return jsonify({"report": serialize(custom_reports_col.find_one(key))}), 201


@app.route("/api/reports/custom/<report_id>", methods=["DELETE"])
@require("expense:edit")
@require_project
def api_custom_delete(report_id):
    doc = custom_reports_col.find_one({"_id": to_oid(report_id), "project_id": g.project_id}) if to_oid(report_id) else None
    if not doc:
        return json_error("Report not found.", 404)
    custom_reports_col.delete_one({"_id": doc["_id"]})
    record_audit("custom_report_deleted", "report", doc["name"])
    return jsonify({"ok": True})


@app.route("/api/export/json")
@require("export")
@require_project
def api_export_json():
    query, err = build_expense_query(request.args, g.user, g.project_id)
    if err:
        return json_error(err)
    items = serialize(list(expenses_col.find(query).sort("transaction_date", ASCENDING)))
    payload = {"exported_at": serialize(utcnow()), "project": g.project["name"], "count": len(items), "expenses": items}
    if request.args.get("include_history") == "1" and has_permission(g.user, "audit:view"):
        payload["revisions"] = serialize(list(revisions_col.find({"expense_oid": {"$in": [to_oid(i["id"]) for i in items]}}).sort([("expense_id", 1), ("revision", 1)])))
    record_audit("export_json", "export", None, {"count": len(items)})
    return Response(json.dumps(payload, indent=2), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename=expenses_{utcnow().strftime('%Y%m%d_%H%M')}.json"})


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------

BACKUP_VERSION = 2
BACKUP_COLLECTIONS = ["projects", "expenses", "categories", "expense_revisions", "audit_logs", "dashboard_preferences", "saved_filters", "custom_reports", "counters", "users"]
_backup_event = threading.Event()
_backup_reasons = []
_backup_lock = threading.Lock()


def _bson_default(o):
    if isinstance(o, ObjectId):
        return {"$oid": str(o)}
    if isinstance(o, datetime):
        return {"$date": (o if o.tzinfo else o.replace(tzinfo=timezone.utc)).isoformat()}
    raise TypeError(f"Cannot serialise {type(o)}")


def _bson_restore(obj):
    if isinstance(obj, list):
        return [_bson_restore(x) for x in obj]
    if isinstance(obj, dict):
        if set(obj) == {"$oid"}:
            return ObjectId(obj["$oid"])
        if set(obj) == {"$date"}:
            return datetime.fromisoformat(obj["$date"].replace("Z", "+00:00"))
        return {k: _bson_restore(v) for k, v in obj.items()}
    return obj


def build_backup(include_users=True):
    data = {"format": "restaurant-expense-manager-backup", "version": BACKUP_VERSION, "generated_at": serialize(utcnow()), "collections": {}}
    for name in BACKUP_COLLECTIONS:
        if name == "users" and not include_users:
            continue
        data["collections"][name] = [json.loads(json.dumps(d, default=_bson_default)) for d in db[name].find({})]
    return data


def request_backup(reason="change"):
    if CONFIG["BACKUP_ON_CHANGE"]:
        with _backup_lock:
            _backup_reasons.append(reason)
        _backup_event.set()


BACKUP_FILENAME = "expense-manager-backup.json"


def _write_atomic(path, text):
    """Write to a temp file then rename, so a crash can never leave a half-written backup."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(path + ".tmp", path)


def write_backup_file(reason):
    """
    Replace the 3 identical copies (backups/copy_1..3/expense-manager-backup.json) with the
    current data, and keep one dated copy per day in backups/history/. Returns a summary dict.
    """
    import hashlib
    now = utcnow()
    text = json.dumps(build_backup(include_users=True))
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    copies = []
    for i in range(1, CONFIG["BACKUP_COPIES"] + 1):
        rel = f"copy_{i}/{BACKUP_FILENAME}"
        _write_atomic(os.path.join(CONFIG["BACKUP_DIR"], rel), text)
        copies.append(rel)
    history_rel = f"history/{now.strftime('%Y-%m-%d')}.json"
    _write_atomic(os.path.join(CONFIG["BACKUP_DIR"], history_rel), text)
    prune_history()
    backup_logs_col.insert_one({"type": "auto_change" if reason != "scheduled" else "scheduled", "reason": reason, "at": now, "file": history_rel,
                                "copies": copies, "checksum": digest, "size": len(text.encode("utf-8"))})
    return {"copies": copies, "history": history_rel, "checksum": digest}


def write_safety_copy(label):
    """A separate dated file that is never overwritten (used before a restore)."""
    text = json.dumps(build_backup(include_users=True))
    rel = f"history/{label}_{utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    _write_atomic(os.path.join(CONFIG["BACKUP_DIR"], rel), text)
    return rel


def prune_history():
    hist = os.path.join(CONFIG["BACKUP_DIR"], "history")
    if not os.path.isdir(hist):
        return
    cutoff = time.time() - CONFIG["BACKUP_HISTORY_DAYS"] * 86400
    for fn in os.listdir(hist):
        p = os.path.join(hist, fn)
        if fn.endswith(".json") and re.fullmatch(r"\d{4}-\d{2}-\d{2}\.json", fn) and os.path.getmtime(p) < cutoff:
            os.remove(p)


def list_backup_files():
    files = []
    if os.path.isdir(CONFIG["BACKUP_DIR"]):
        for root, _d, names in os.walk(CONFIG["BACKUP_DIR"]):
            for fn in names:
                if fn.endswith(".json"):
                    p = os.path.join(root, fn)
                    files.append({"name": os.path.relpath(p, CONFIG["BACKUP_DIR"]).replace(os.sep, "/"), "size": os.path.getsize(p),
                                  "modified": serialize(datetime.fromtimestamp(os.path.getmtime(p), timezone.utc)), "_m": os.path.getmtime(p)})
    files.sort(key=lambda f: (1, -f["_m"], "") if not f["name"].startswith("copy_") else (0, 0, f["name"]))
    for f in files:
        f.pop("_m")
    return files


def copies_status():
    """Check that the 3 copies exist and are identical."""
    import hashlib
    out = []
    for i in range(1, CONFIG["BACKUP_COPIES"] + 1):
        p = os.path.join(CONFIG["BACKUP_DIR"], f"copy_{i}", BACKUP_FILENAME)
        if os.path.isfile(p):
            with open(p, "rb") as fh:
                out.append({"copy": i, "exists": True, "checksum": hashlib.sha256(fh.read()).hexdigest()[:16], "size": os.path.getsize(p),
                            "modified": serialize(datetime.fromtimestamp(os.path.getmtime(p), timezone.utc))})
        else:
            out.append({"copy": i, "exists": False})
    sums = {c["checksum"] for c in out if c.get("exists")}
    return {"copies": out, "all_identical": len(sums) == 1 and all(c["exists"] for c in out)}


def change_backup_worker():
    while True:
        _backup_event.wait()
        time.sleep(CONFIG["BACKUP_DEBOUNCE_SECONDS"])
        _backup_event.clear()
        with _backup_lock:
            reasons, _backup_reasons[:] = list(_backup_reasons), []
        if not reasons:
            continue
        try:
            info = write_backup_file(reasons[-1] if len(set(reasons)) == 1 else f"{len(reasons)}_changes")
            log.info("Backup copies refreshed (%s)", info["checksum"])
        except Exception as exc:
            log.exception("Change backup failed: %s", exc)


def scheduled_backup_loop():
    """Once a day: make sure today's history copy exists even if nothing changed."""
    while True:
        try:
            today = os.path.join(CONFIG["BACKUP_DIR"], "history", utcnow().strftime("%Y-%m-%d") + ".json")
            if not os.path.isfile(today):
                write_backup_file("scheduled")
        except Exception as exc:
            log.exception("Scheduled backup failed: %s", exc)
        time.sleep(CONFIG["BACKUP_INTERVAL_HOURS"] * 3600)


@app.route("/api/backup")
@require("backup:create")
def api_backup_download():
    include_users = has_permission(g.user, "user:manage")
    data = build_backup(include_users=include_users)
    backup_logs_col.insert_one({"type": "manual_download", "user_id": str(g.user["_id"]), "user_name": user_display(g.user), "at": utcnow(),
                                "counts": {k: len(v) for k, v in data["collections"].items()}})
    record_audit("backup_downloaded", "backup", None)
    return Response(json.dumps(data), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename=expense_manager_backup_{utcnow().strftime('%Y%m%d_%H%M%S')}.json"})


def validate_backup_payload(data):
    problems, summary = [], {}
    if not isinstance(data, dict) or data.get("format") != "restaurant-expense-manager-backup":
        return ["This file is not an Expense Manager backup."], {}
    if data.get("version") not in (1, 2):
        problems.append(f"Unsupported backup version {data.get('version')}.")
    cols = data.get("collections") or {}
    if "expenses" not in cols or "categories" not in cols:
        problems.append("Backup is missing the expenses or categories collection.")
    for name, docs in cols.items():
        if name not in BACKUP_COLLECTIONS:
            problems.append(f"Unknown collection '{name}'.")
            continue
        if not isinstance(docs, list):
            problems.append(f"Collection '{name}' must be a list.")
            continue
        ids = [json.dumps(d.get("_id"), sort_keys=True) for d in docs if isinstance(d, dict)]
        if len(ids) != len(set(ids)):
            problems.append(f"Duplicate _id values in '{name}'.")
        if name == "expenses":
            eids = [d.get("expense_id") for d in docs if isinstance(d, dict)]
            if len(eids) != len(set(eids)):
                problems.append("Duplicate expense IDs in the backup.")
        existing = 0
        if name in ("expenses", "categories", "users", "projects"):
            restored = [_bson_restore(d["_id"]) for d in docs if isinstance(d, dict) and "_id" in d]
            existing = db[name].count_documents({"_id": {"$in": restored}}) if restored else 0
        summary[name] = {"records": len(docs), "conflicts": existing}
    return problems, summary


def read_backup_from_request():
    if request.files.get("file"):
        try:
            return json.load(request.files["file"]), None
        except (ValueError, UnicodeDecodeError):
            return None, "The file is not valid JSON."
    data = request.get_json(silent=True)
    if data is None:
        return None, "Upload a backup JSON file."
    return data.get("backup", data), None


@app.route("/api/backup/validate", methods=["POST"])
@require("backup:restore")
def api_backup_validate():
    data, err = read_backup_from_request()
    if err:
        return json_error(err)
    problems, summary = validate_backup_payload(data)
    return jsonify({"valid": not problems, "problems": problems, "summary": summary, "generated_at": data.get("generated_at") if isinstance(data, dict) else None})


@app.route("/api/backup/restore", methods=["POST"])
@require("backup:restore")
def api_backup_restore():
    data, err = read_backup_from_request()
    if err:
        return json_error(err)
    body = request.get_json(silent=True) or {}
    mode = request.form.get("mode") or body.get("mode") or "merge"
    confirm = str(request.form.get("confirm") or body.get("confirm", "")).lower() == "true"
    if mode not in ("merge", "replace"):
        return json_error("Mode must be 'merge' or 'replace'.")
    if not confirm:
        return json_error("Confirmation is required before restoring.")
    problems, _ = validate_backup_payload(data)
    if problems:
        return json_error("Backup failed validation.", 400, problems=problems)
    pre = write_safety_copy("pre_restore")
    me = g.user["_id"]
    results = {}
    for name in BACKUP_COLLECTIONS:
        docs = data["collections"].get(name)
        if docs is None:
            continue
        if name == "users":
            docs = [d for d in docs if d.get("password_hash")]
        restored = [_bson_restore(d) for d in docs]
        inserted = updated = skipped = 0
        if mode == "replace":
            db[name].delete_many({"_id": {"$ne": me}} if name == "users" else {})
        for d in restored:
            if name == "users" and d["_id"] == me:
                skipped += 1
                continue
            if mode == "replace":
                db[name].insert_one(d)
                inserted += 1
            else:
                res = db[name].replace_one({"_id": d["_id"]}, d, upsert=True)
                inserted += res.upserted_id is not None
                updated += res.upserted_id is None
        results[name] = {"inserted": inserted, "updated": updated, "skipped": skipped}
    ensure_indexes()
    backup_logs_col.insert_one({"type": f"restore_{mode}", "user_id": str(me), "user_name": user_display(g.user), "at": utcnow(), "results": results, "pre_restore_file": pre})
    record_audit("backup_restored", "backup", None, {"mode": mode, "results": results})
    return jsonify({"ok": True, "mode": mode, "results": results, "pre_restore_backup": pre})


@app.route("/api/backup/logs")
@require("backup:create")
def api_backup_logs():
    files = list_backup_files()
    return jsonify({"logs": serialize(list(backup_logs_col.find({}).sort("at", DESCENDING).limit(30))), "files": files[:60], "total_files": len(files),
                    "status": copies_status(), "copies": CONFIG["BACKUP_COPIES"], "history_days": CONFIG["BACKUP_HISTORY_DAYS"]})


@app.route("/api/backup/files/<path:name>")
@require("backup:restore")
def api_backup_file(name):
    if not re.fullmatch(r"[A-Za-z0-9_\-/]+\.json", name) or ".." in name:
        abort(404)
    base = os.path.realpath(CONFIG["BACKUP_DIR"])
    path = os.path.realpath(os.path.join(base, name))
    if not path.startswith(base + os.sep) or not os.path.isfile(path):
        abort(404)
    record_audit("backup_file_downloaded", "backup", name)
    return send_file(path, as_attachment=True, download_name=name.replace("/", "_"))


# ---------------------------------------------------------------------------
# Errors and startup
# ---------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(_):
    if request.path.startswith("/api/"):
        return json_error("Not found.", 404)
    return render_template("error.html", code=404, message="That page does not exist."), 404


@app.errorhandler(405)
def method_not_allowed(_):
    return json_error("Method not allowed.", 405)


@app.errorhandler(413)
def too_large(_):
    return json_error("File is too large (max 25 MB).", 413)


@app.errorhandler(500)
def server_error(exc):
    log.exception("Unhandled error: %s", exc)
    if request.path.startswith("/api/"):
        extra = {"detail": f"{type(exc).__name__}: {exc}"} if os.environ.get("EM_DEBUG") == "1" else {}
        return json_error("Something went wrong on the server. Try again.", 500, **extra)
    return render_template("error.html", code=500, message="Something went wrong. Try again."), 500


def init_app():
    check_database_connection()
    ensure_indexes()
    seed_defaults()
    upgrade_all_projects()
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        threading.Thread(target=change_backup_worker, name="change-backups", daemon=True).start()
        threading.Thread(target=scheduled_backup_loop, name="scheduled-backups", daemon=True).start()


if __name__ == "__main__":
    init_app()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
else:
    init_app()
