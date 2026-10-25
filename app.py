"""
Restaurant Expense Manager
--------------------------
Single-file Flask backend backed by MongoDB (PyMongo).

Run:
    pip install -r requirements.txt
    python app.py

Default login (change the password on first login):
    username: admin
    password: Admin@12345
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
from datetime import datetime, timedelta, timezone
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import (
    Flask,
    Response,
    abort,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from pymongo import ASCENDING, DESCENDING, MongoClient, ReturnDocument
from pymongo.errors import DuplicateKeyError
from werkzeug.security import check_password_hash, generate_password_hash

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def build_mongo_uri():
    """
    Pick the MongoDB connection string from, in order:
      1. MONGODB_URI / EM_MONGO_URI  (full connection string)
      2. MONGODB_USERNAME + MONGODB_PASSWORD + MONGODB_HOST  (Atlas style)
      3. local MongoDB on localhost:27017
    Passwords are URL-encoded automatically, so special characters are safe.
    """
    from urllib.parse import quote_plus
    full = os.environ.get("MONGODB_URI") or os.environ.get("EM_MONGO_URI")
    if full:
        return full
    user = os.environ.get("MONGODB_USERNAME")
    pwd = os.environ.get("MONGODB_PASSWORD")
    host = os.environ.get("MONGODB_HOST", "expensemanager.exoz8sx.mongodb.net")
    if user and pwd:
        return f"mongodb+srv://{quote_plus(user)}:{quote_plus(pwd)}@{host}/?retryWrites=true&w=majority&appName=ExpenseManager"
    return "mongodb://localhost:27017"


CONFIG = {
    # MongoDB connection — see build_mongo_uri() above for the environment variables.
    "MONGO_URI": build_mongo_uri(),
    "DB_NAME": os.environ.get("EM_DB_NAME", "restaurant_expense_manager"),
    # Flask session signing key. Set EM_SECRET_KEY in production.
    "SECRET_KEY": os.environ.get("EM_SECRET_KEY", ""),
    "SESSION_IDLE_MINUTES": 30,       # auto logout after inactivity
    "SESSION_ABSOLUTE_HOURS": 12,     # hard logout regardless of activity
    "MAX_LOGIN_ATTEMPTS": 5,
    "LOCKOUT_MINUTES": 15,
    "BACKUP_DIR": os.path.join(os.path.dirname(os.path.abspath(__file__)), "backups"),
    "BACKUP_INTERVAL_HOURS": 24,        # daily safety backup even when nothing changed
    "BACKUPS_TO_KEEP": 14,              # how many daily scheduled files to keep
    "BACKUP_ON_CHANGE": True,           # write a JSON snapshot after every change
    "BACKUP_DEBOUNCE_SECONDS": 3,       # group rapid changes into one file
    "BACKUP_RETENTION_DAYS": 30,        # keep every change-snapshot for this many days, then one per day
    "SECURE_COOKIES": os.environ.get("EM_SECURE_COOKIES", "0") == "1",  # set to 1 behind HTTPS
    "DEFAULT_ADMIN": {
    "username": os.environ.get("EM_INITIAL_ADMIN_USERNAME", "admin"),
    "password": os.environ.get("EM_INITIAL_ADMIN_PASSWORD", ""),
    "full_name": "Administrator",
},,
    "CURRENCY": "INR",
}

ROLES = ["admin", "manager", "accountant", "viewer"]

ROLE_PERMISSIONS = {
    "admin": {"*"},
    "manager": {
        "expense:view", "expense:create", "expense:edit", "expense:delete", "expense:restore",
        "expense:view_deleted", "category:view", "category:manage", "export", "audit:view",
        "backup:create", "dashboard:customize",
    },
    "accountant": {
        "expense:view", "expense:create", "expense:edit", "expense:view_deleted", "category:view",
        "export", "audit:view", "backup:create", "dashboard:customize",
    },
    "viewer": {"expense:view", "category:view", "export", "dashboard:customize"},
}

PAYMENT_METHODS = ["Cash", "UPI", "Bank Transfer", "Card", "Cheque", "Other"]
PAYMENT_STATUSES = ["Paid", "Pending", "Partially Paid", "Reimbursed"]
EXPENSE_TYPES = ["Setup", "Operational", "Capital", "Recurring", "One-time"]

DEFAULT_CATEGORIES = {
    "Interiors and Civil Work": ["Civil Construction", "Flooring", "Painting", "False Ceiling", "Interior Finishing"],
    "Kitchen Equipment": ["Cooking Equipment", "Refrigeration", "Exhaust and Ventilation", "Kitchen Utensils"],
    "Furniture and Fixtures": ["Dining Tables", "Chairs", "Majlis Seating", "Decorative Fixtures"],
    "Rent and Security Deposit": ["Monthly Rent", "Security Deposit", "Maintenance Charges"],
    "Electrical and Plumbing": ["Electrical Wiring", "Lighting", "Plumbing Materials", "Installation Charges"],
    "Licenses and Registrations": ["FSSAI License", "Trade License", "GST Registration", "Fire NOC"],
    "Raw Materials and Groceries": ["Meat and Poultry", "Vegetables", "Dairy", "Spices and Dry Goods"],
    "Staff Salaries": ["Kitchen Staff", "Service Staff", "Management"],
    "Marketing and Advertising": ["Social Media", "Print", "Signage", "Promotions"],
    "Packaging and Delivery": ["Packaging Material", "Delivery Platform Fees"],
    "Utilities and Maintenance": ["Electricity", "Water", "Gas", "Repairs"],
    "Transportation": ["Fuel", "Vehicle Hire", "Logistics"],
    "Miscellaneous Expenses": [],
}

DASHBOARD_WIDGETS = [
    {"id": "total_expenses", "name": "Total expenses", "size": "small"},
    {"id": "transaction_count", "name": "Number of transactions", "size": "small"},
    {"id": "average_expense", "name": "Average per transaction", "size": "small"},
    {"id": "largest_expense", "name": "Largest single expense", "size": "small"},
    {"id": "monthly_trend", "name": "Expense trend", "size": "large"},
    {"id": "by_category", "name": "Spend by category", "size": "large"},
    {"id": "by_subcategory", "name": "Spend by subcategory", "size": "medium"},
    {"id": "by_payment_method", "name": "Payment methods", "size": "medium"},
    {"id": "top_vendors", "name": "Top vendors", "size": "medium"},
    {"id": "recent_transactions", "name": "Recent transactions", "size": "large"},
    {"id": "pending_payments", "name": "Pending payments", "size": "medium"},
]

DEFAULT_LAYOUTS = {
    "admin": ["total_expenses", "transaction_count", "average_expense", "largest_expense", "monthly_trend",
              "by_category", "by_subcategory", "by_payment_method", "top_vendors", "pending_payments",
              "recent_transactions"],
    "manager": ["total_expenses", "transaction_count", "pending_payments", "monthly_trend", "by_category",
                "top_vendors", "recent_transactions"],
    "accountant": ["total_expenses", "transaction_count", "average_expense", "by_payment_method", "pending_payments",
                   "monthly_trend", "by_category", "by_subcategory", "recent_transactions"],
    "viewer": ["total_expenses", "transaction_count", "monthly_trend", "by_category", "recent_transactions"],
}

# ---------------------------------------------------------------------------
# App and database setup
# ---------------------------------------------------------------------------

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("expense-manager")

if not CONFIG["SECRET_KEY"]:
    raise RuntimeError(
        "EM_SECRET_KEY must be set before starting the application."
    )
    
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config.update(
    SECRET_KEY=CONFIG["SECRET_KEY"],
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=CONFIG["SECURE_COOKIES"],
    PERMANENT_SESSION_LIFETIME=timedelta(hours=CONFIG["SESSION_ABSOLUTE_HOURS"]),
    MAX_CONTENT_LENGTH=25 * 1024 * 1024,
    JSON_SORT_KEYS=False,
)

client = MongoClient(CONFIG["MONGO_URI"], serverSelectionTimeoutMS=10000)
db = client[CONFIG["DB_NAME"]]


def check_database_connection():
    try:
        client.admin.command("ping")
        log.info("Connected to MongoDB (database '%s')", CONFIG["DB_NAME"])
    except Exception as exc:
        raise SystemExit(
            "Could not connect to MongoDB: %s\n"
            "Check MONGODB_USERNAME / MONGODB_PASSWORD (or MONGODB_URI) and that your IP is allowed in Atlas → Network Access." % exc
        )

users_col = db["users"]
expenses_col = db["expenses"]
categories_col = db["categories"]
revisions_col = db["expense_revisions"]
audit_col = db["audit_logs"]
prefs_col = db["dashboard_preferences"]
filters_col = db["saved_filters"]
backup_logs_col = db["backup_logs"]
counters_col = db["counters"]
idempotency_col = db["idempotency_keys"]

# In-memory login attempt tracker: key -> {"count": int, "locked_until": datetime}
_login_attempts = {}
_login_lock = threading.Lock()


def utcnow():
    return datetime.now(timezone.utc)


def ensure_indexes():
    users_col.create_index([("username", ASCENDING)], unique=True)
    expenses_col.create_index([("expense_id", ASCENDING)], unique=True)
    expenses_col.create_index([("transaction_date", DESCENDING)])
    expenses_col.create_index([("category_id", ASCENDING), ("subcategory_id", ASCENDING)])
    expenses_col.create_index([("status", ASCENDING), ("transaction_date", DESCENDING)])
    expenses_col.create_index([("vendor", ASCENDING)])
    expenses_col.create_index([("payment_method", ASCENDING)])
    expenses_col.create_index([("payment_status", ASCENDING)])
    expenses_col.create_index([("amount", ASCENDING)])
    expenses_col.create_index([("description", "text"), ("vendor", "text"), ("notes", "text")])
    categories_col.create_index([("parent_id", ASCENDING), ("name", ASCENDING)])
    revisions_col.create_index([("expense_id", ASCENDING), ("revision", ASCENDING)])
    audit_col.create_index([("at", DESCENDING)])
    audit_col.create_index([("entity_id", ASCENDING)])
    prefs_col.create_index([("user_id", ASCENDING)], unique=True)
    filters_col.create_index([("user_id", ASCENDING)])
    idempotency_col.create_index([("created_at", ASCENDING)], expireAfterSeconds=86400)
    idempotency_col.create_index([("key", ASCENDING), ("user_id", ASCENDING)], unique=True)


def seed_defaults():
    """Create the first admin user and default categories if the database is empty."""
    if users_col.count_documents({}) == 0:
        admin = CONFIG["DEFAULT_ADMIN"]
        users_col.insert_one({
            "username": admin["username"],
            "full_name": admin["full_name"],
            "password_hash": generate_password_hash(admin["password"]),
            "role": "admin",
            "active": True,
            "must_change_password": True,
            "session_version": 1,
            "created_at": utcnow(),
            "last_login_at": None,
        })
        log.info("Created default admin user '%s'", admin["username"])

    if categories_col.count_documents({}) == 0:
        order = 0
        for parent_name, children in DEFAULT_CATEGORIES.items():
            order += 1
            parent = {
                "name": parent_name, "parent_id": None, "path": [parent_name], "path_ids": [],
                "level": 0, "description": "", "status": "active", "sort_order": order,
                "created_at": utcnow(), "is_default": True,
            }
            pid = categories_col.insert_one(parent).inserted_id
            categories_col.update_one({"_id": pid}, {"$set": {"path_ids": [str(pid)]}})
            for i, child_name in enumerate(children):
                child = {
                    "name": child_name, "parent_id": str(pid), "path": [parent_name, child_name],
                    "path_ids": [str(pid)], "level": 1, "description": "", "status": "active",
                    "sort_order": i + 1, "created_at": utcnow(), "is_default": True,
                }
                cid = categories_col.insert_one(child).inserted_id
                categories_col.update_one({"_id": cid}, {"$set": {"path_ids": [str(pid), str(cid)]}})
        log.info("Seeded default categories")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def serialize(doc):
    """Convert ObjectId and datetime values into JSON-friendly values."""
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
    """Parse YYYY-MM-DD (or ISO datetime) into a timezone-aware UTC datetime."""
    if not value:
        return None
    value = str(value).strip()
    try:
        if len(value) == 10:
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


def parse_amount(value):
    try:
        amount = round(float(str(value).replace(",", "")), 2)
    except (TypeError, ValueError):
        return None
    if amount <= 0 or amount > 1_000_000_000:
        return None
    return amount


def clean_str(value, max_len=500):
    if value is None:
        return ""
    return str(value).strip()[:max_len]


def next_expense_id():
    year = utcnow().year
    counter = counters_col.find_one_and_update(
        {"_id": f"expense_{year}"}, {"$inc": {"seq": 1}}, upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return f"EXP-{year}-{counter['seq']:05d}"


def json_error(message, status=400, **extra):
    payload = {"error": message}
    payload.update(extra)
    return jsonify(payload), status


def client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def record_audit(action, entity_type, entity_id, details=None, user=None):
    user = user or getattr(g, "user", None)
    audit_col.insert_one({
        "action": action,
        "entity_type": entity_type,
        "entity_id": str(entity_id) if entity_id is not None else None,
        "user_id": str(user["_id"]) if user else None,
        "user_name": user.get("full_name") or user.get("username") if user else "system",
        "at": utcnow(),
        "ip": client_ip() if request else None,
        "details": details or {},
    })
    if action in DATA_CHANGING_ACTIONS:
        request_backup(action)


DATA_CHANGING_ACTIONS = {
    "expense_created", "expense_edited", "expense_deleted", "expense_restored", "expense_purged",
    "category_created", "category_updated", "category_archived", "category_restored",
    "user_created", "user_updated", "password_changed", "backup_restored",
}


def has_permission(user, perm):
    perms = ROLE_PERMISSIONS.get(user.get("role"), set())
    return "*" in perms or perm in perms


def validate_password(password):
    if not password or len(password) < 8:
        return "Password must be at least 8 characters."
    if not re.search(r"[A-Z]", password):
        return "Password must contain an uppercase letter."
    if not re.search(r"[a-z]", password):
        return "Password must contain a lowercase letter."
    if not re.search(r"[0-9]", password):
        return "Password must contain a number."
    return None


# ---------------------------------------------------------------------------
# Authentication and authorization
# ---------------------------------------------------------------------------

def current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    oid = to_oid(user_id)
    if not oid:
        return None
    user = users_col.find_one({"_id": oid})
    if not user or not user.get("active", False):
        return None
    if user.get("session_version", 1) != session.get("session_version"):
        return None
    return user


def session_expired():
    last = session.get("last_active")
    if not last:
        return True
    idle = utcnow() - datetime.fromisoformat(last)
    return idle > timedelta(minutes=CONFIG["SESSION_IDLE_MINUTES"])


@app.before_request
def load_user():
    g.user = None
    if request.path.startswith("/static/"):
        return None
    if session.get("user_id"):
        if session_expired():
            session.clear()
        else:
            g.user = current_user()
            if g.user:
                session["last_active"] = utcnow().isoformat()
            else:
                session.clear()
    # CSRF protection for every state-changing API call
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
        if request.path != "/api/auth/login":
            token = request.headers.get("X-CSRF-Token", "")
            if not token or not session.get("csrf_token") or not secrets.compare_digest(token, session["csrf_token"]):
                return json_error("Invalid or missing CSRF token. Reload the page and try again.", 403)
    return None


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"
    )
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
        entry = _login_attempts.get(_attempt_key(username))
        if entry and entry.get("locked_until") and entry["locked_until"] > utcnow():
            return int((entry["locked_until"] - utcnow()).total_seconds() // 60) + 1
    return 0


def register_failed_login(username):
    with _login_lock:
        key = _attempt_key(username)
        entry = _login_attempts.setdefault(key, {"count": 0, "locked_until": None})
        entry["count"] += 1
        if entry["count"] >= CONFIG["MAX_LOGIN_ATTEMPTS"]:
            entry["locked_until"] = utcnow() + timedelta(minutes=CONFIG["LOCKOUT_MINUTES"])
            entry["count"] = 0


def clear_failed_logins(username):
    with _login_lock:
        _login_attempts.pop(_attempt_key(username), None)


def public_user(user):
    return {
        "id": str(user["_id"]),
        "username": user["username"],
        "full_name": user.get("full_name", ""),
        "role": user.get("role"),
        "active": user.get("active", True),
        "must_change_password": user.get("must_change_password", False),
        "permissions": sorted(ROLE_PERMISSIONS.get(user.get("role"), set())),
        "last_login_at": serialize(user.get("last_login_at")),
        "created_at": serialize(user.get("created_at")),
    }


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.route("/login")
def login_page():
    if g.user:
        return redirect(url_for("index"))
    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)
    return render_template("login.html", csrf_token=session["csrf_token"])


@app.route("/")
@login_required
def index():
    return render_template(
        "index.html",
        csrf_token=session["csrf_token"],
        user_json=json.dumps(public_user(g.user)).replace("</", "<\\/"),
        meta_json=json.dumps({
            "payment_methods": PAYMENT_METHODS,
            "payment_statuses": PAYMENT_STATUSES,
            "expense_types": EXPENSE_TYPES,
            "roles": ROLES,
            "widgets": DASHBOARD_WIDGETS,
            "currency": CONFIG["CURRENCY"],
            "idle_minutes": CONFIG["SESSION_IDLE_MINUTES"],
        }).replace("</", "<\\/"),
    )


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
    username = clean_str(data.get("username"), 64)
    password = data.get("password") or ""
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
        time.sleep(0.4)  # slow down brute force attempts
        return json_error("Incorrect username or password.", 401)
    if not user.get("active", False):
        record_audit("login_failed", "user", str(user["_id"]), {"reason": "inactive"}, user=None)
        return json_error("This account is disabled. Contact an administrator.", 403)

    clear_failed_logins(username)
    session.clear()
    session.permanent = True
    session["user_id"] = str(user["_id"])
    session["session_version"] = user.get("session_version", 1)
    session["csrf_token"] = secrets.token_urlsafe(32)
    session["last_active"] = utcnow().isoformat()
    users_col.update_one({"_id": user["_id"]}, {"$set": {"last_login_at": utcnow()}})
    g.user = user
    record_audit("login", "user", user["_id"])
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
    current = data.get("current_password") or ""
    new = data.get("new_password") or ""
    confirm = data.get("confirm_password") or ""
    if not check_password_hash(g.user["password_hash"], current):
        return json_error("Current password is incorrect.", 400)
    if new != confirm:
        return json_error("New password and confirmation do not match.")
    if new == current:
        return json_error("New password must be different from the current one.")
    problem = validate_password(new)
    if problem:
        return json_error(problem)
    users_col.update_one({"_id": g.user["_id"]}, {
        "$set": {"password_hash": generate_password_hash(new), "must_change_password": False},
    })
    record_audit("password_changed", "user", g.user["_id"])
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# User management API (admin)
# ---------------------------------------------------------------------------

@app.route("/api/users")
@require("user:manage")
def api_users_list():
    users = list(users_col.find({}).sort("username", ASCENDING))
    return jsonify({"users": [public_user(u) for u in users]})


@app.route("/api/users", methods=["POST"])
@require("user:manage")
def api_users_create():
    data = request.get_json(silent=True) or {}
    username = clean_str(data.get("username"), 64).lower()
    full_name = clean_str(data.get("full_name"), 120)
    role = data.get("role")
    password = data.get("password") or ""
    if not re.fullmatch(r"[a-z0-9._-]{3,64}", username):
        return json_error("Username must be 3-64 characters: letters, numbers, dot, dash or underscore.")
    if role not in ROLES:
        return json_error("Choose a valid role.")
    problem = validate_password(password)
    if problem:
        return json_error(problem)
    doc = {
        "username": username, "full_name": full_name or username, "role": role,
        "password_hash": generate_password_hash(password), "active": True,
        "must_change_password": True, "session_version": 1, "created_at": utcnow(), "last_login_at": None,
    }
    try:
        result = users_col.insert_one(doc)
    except DuplicateKeyError:
        return json_error("That username is already taken.", 409)
    doc["_id"] = result.inserted_id
    record_audit("user_created", "user", result.inserted_id, {"username": username, "role": role})
    return jsonify({"user": public_user(doc)}), 201


@app.route("/api/users/<user_id>", methods=["PUT"])
@require("user:manage")
def api_users_update(user_id):
    oid = to_oid(user_id)
    user = users_col.find_one({"_id": oid}) if oid else None
    if not user:
        return json_error("User not found.", 404)
    data = request.get_json(silent=True) or {}
    updates = {}
    changes = {}
    if "full_name" in data:
        updates["full_name"] = clean_str(data["full_name"], 120) or user["username"]
    if "role" in data:
        if data["role"] not in ROLES:
            return json_error("Choose a valid role.")
        if user["_id"] == g.user["_id"] and data["role"] != "admin":
            return json_error("You cannot remove your own admin role.")
        updates["role"] = data["role"]
    if "active" in data:
        active = bool(data["active"])
        if user["_id"] == g.user["_id"] and not active:
            return json_error("You cannot disable your own account.")
        if not active and user.get("role") == "admin" and users_col.count_documents({"role": "admin", "active": True}) <= 1:
            return json_error("At least one active admin is required.")
        updates["active"] = active
    if data.get("new_password"):
        problem = validate_password(data["new_password"])
        if problem:
            return json_error(problem)
        updates["password_hash"] = generate_password_hash(data["new_password"])
        updates["must_change_password"] = True
        changes["password_reset"] = True
    if not updates:
        return json_error("Nothing to update.")
    # Force re-login when role, status or password changes.
    if any(k in updates for k in ("role", "active", "password_hash")) and user["_id"] != g.user["_id"]:
        updates["session_version"] = user.get("session_version", 1) + 1
    users_col.update_one({"_id": oid}, {"$set": updates})
    changes.update({k: v for k, v in updates.items() if k not in ("password_hash", "session_version")})
    record_audit("user_updated", "user", oid, changes)
    return jsonify({"user": public_user(users_col.find_one({"_id": oid}))})


# ---------------------------------------------------------------------------
# Categories API
# ---------------------------------------------------------------------------

def category_tree(include_archived=False):
    query = {} if include_archived else {"status": "active"}
    cats = list(categories_col.find(query).sort([("level", ASCENDING), ("sort_order", ASCENDING), ("name", ASCENDING)]))
    usage = {}
    for row in expenses_col.aggregate([
        {"$match": {"status": "active"}},
        {"$group": {"_id": "$category_id", "count": {"$sum": 1}, "total": {"$sum": "$amount"}}},
    ]):
        usage[row["_id"]] = {"count": row["count"], "total": round(row["total"], 2)}
    for row in expenses_col.aggregate([
        {"$match": {"status": "active", "subcategory_id": {"$ne": None}}},
        {"$group": {"_id": "$subcategory_id", "count": {"$sum": 1}, "total": {"$sum": "$amount"}}},
    ]):
        existing = usage.get(row["_id"], {"count": 0, "total": 0})
        usage[row["_id"]] = {"count": existing["count"] + row["count"], "total": round(existing["total"] + row["total"], 2)}
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
        if parent:
            parent["children"].append(node)
        else:
            roots.append(node)
    return roots, flat


@app.route("/api/categories")
@require("category:view")
def api_categories():
    include_archived = request.args.get("include_archived") == "1"
    tree, flat = category_tree(include_archived)
    return jsonify({"tree": tree, "flat": flat})


@app.route("/api/categories", methods=["POST"])
@require("category:manage")
def api_categories_create():
    data = request.get_json(silent=True) or {}
    name = clean_str(data.get("name"), 80)
    description = clean_str(data.get("description"), 300)
    parent_id = data.get("parent_id") or None
    if len(name) < 2:
        return json_error("Category name must be at least 2 characters.")
    parent = None
    if parent_id:
        parent = categories_col.find_one({"_id": to_oid(parent_id)}) if to_oid(parent_id) else None
        if not parent:
            return json_error("Parent category not found.", 404)
        if parent.get("status") != "active":
            return json_error("Cannot add under an archived category.")
    if categories_col.find_one({"parent_id": parent_id, "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}):
        return json_error("A category with this name already exists at this level.", 409)
    path = (parent["path"] if parent else []) + [name]
    sort_order = categories_col.count_documents({"parent_id": parent_id}) + 1
    doc = {
        "name": name, "parent_id": parent_id, "path": path, "path_ids": [], "level": len(path) - 1,
        "description": description, "status": "active", "sort_order": sort_order, "created_at": utcnow(),
        "created_by": str(g.user["_id"]), "is_default": False,
    }
    cid = categories_col.insert_one(doc).inserted_id
    path_ids = (parent["path_ids"] if parent else []) + [str(cid)]
    categories_col.update_one({"_id": cid}, {"$set": {"path_ids": path_ids}})
    record_audit("category_created", "category", cid, {"name": name, "path": path})
    return jsonify({"category": serialize(categories_col.find_one({"_id": cid}))}), 201


def rename_descendant_paths(cat):
    """Rebuild path arrays for a renamed category and everything below it."""
    cid = str(cat["_id"])
    descendants = categories_col.find({"path_ids": cid, "_id": {"$ne": cat["_id"]}})
    for d in descendants:
        idx = d["path_ids"].index(cid)
        new_path = cat["path"] + d["path"][idx + 1:]
        categories_col.update_one({"_id": d["_id"]}, {"$set": {"path": new_path}})
        expenses_col.update_many({"$or": [{"category_id": str(d["_id"])}, {"subcategory_id": str(d["_id"])}]},
                                 {"$set": {"category_path": new_path}})


@app.route("/api/categories/<cat_id>", methods=["PUT"])
@require("category:manage")
def api_categories_update(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    data = request.get_json(silent=True) or {}
    updates = {}
    if "name" in data:
        name = clean_str(data["name"], 80)
        if len(name) < 2:
            return json_error("Category name must be at least 2 characters.")
        dup = categories_col.find_one({"parent_id": cat["parent_id"], "_id": {"$ne": oid},
                                       "name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}})
        if dup:
            return json_error("A category with this name already exists at this level.", 409)
        updates["name"] = name
        updates["path"] = cat["path"][:-1] + [name]
    if "description" in data:
        updates["description"] = clean_str(data["description"], 300)
    if "sort_order" in data:
        try:
            updates["sort_order"] = int(data["sort_order"])
        except (TypeError, ValueError):
            pass
    if not updates:
        return json_error("Nothing to update.")
    categories_col.update_one({"_id": oid}, {"$set": updates})
    cat = categories_col.find_one({"_id": oid})
    if "name" in updates:
        expenses_col.update_many({"$or": [{"category_id": cat_id}, {"subcategory_id": cat_id}]},
                                 {"$set": {"category_path": cat["path"]}})
        rename_descendant_paths(cat)
    record_audit("category_updated", "category", oid, updates)
    return jsonify({"category": serialize(cat)})


@app.route("/api/categories/<cat_id>/archive", methods=["POST"])
@require("category:manage")
def api_categories_archive(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    data = request.get_json(silent=True) or {}
    ids = [str(c["_id"]) for c in categories_col.find({"path_ids": cat_id})]
    in_use = expenses_col.count_documents({"status": "active", "$or": [{"category_id": {"$in": ids}}, {"subcategory_id": {"$in": ids}}]})
    reassign_to = data.get("reassign_to")
    if in_use and not reassign_to:
        return json_error(f"{in_use} active expense(s) use this category. Choose a category to move them to first.", 409, in_use=in_use)
    moved = 0
    if in_use and reassign_to:
        target = categories_col.find_one({"_id": to_oid(reassign_to), "status": "active"}) if to_oid(reassign_to) else None
        if not target or str(target["_id"]) in ids:
            return json_error("Choose a valid, active category to move expenses to.")
        if not has_permission(g.user, "expense:edit"):
            return json_error("You need expense edit permission to reassign expenses.", 403)
        new_cat, new_sub = resolve_category_pair(str(target["_id"]))
        for exp in expenses_col.find({"status": "active", "$or": [{"category_id": {"$in": ids}}, {"subcategory_id": {"$in": ids}}]}):
            apply_edit(exp, {"category_id": new_cat, "subcategory_id": new_sub, "category_path": target["path"]},
                       reason=f"Category '{cat['name']}' archived; moved to '{' > '.join(target['path'])}'")
            moved += 1
    categories_col.update_many({"_id": {"$in": [ObjectId(i) for i in ids]}}, {"$set": {"status": "archived", "archived_at": utcnow()}})
    record_audit("category_archived", "category", oid, {"name": cat["name"], "reassigned": moved, "reassign_to": reassign_to})
    return jsonify({"ok": True, "reassigned": moved})


@app.route("/api/categories/<cat_id>/unarchive", methods=["POST"])
@require("category:manage")
def api_categories_unarchive(cat_id):
    oid = to_oid(cat_id)
    cat = categories_col.find_one({"_id": oid}) if oid else None
    if not cat:
        return json_error("Category not found.", 404)
    if cat["parent_id"]:
        parent = categories_col.find_one({"_id": to_oid(cat["parent_id"])})
        if parent and parent.get("status") != "active":
            return json_error("Restore the parent category first.")
    categories_col.update_one({"_id": oid}, {"$set": {"status": "active"}, "$unset": {"archived_at": ""}})
    record_audit("category_restored", "category", oid, {"name": cat["name"]})
    return jsonify({"ok": True})


def resolve_category_pair(selected_id):
    """Given any category node, return (top-level category id, leaf id or None)."""
    cat = categories_col.find_one({"_id": to_oid(selected_id)}) if to_oid(selected_id) else None
    if not cat:
        return None, None
    top = cat["path_ids"][0]
    sub = selected_id if cat["level"] > 0 else None
    return top, sub


# ---------------------------------------------------------------------------
# Expenses API
# ---------------------------------------------------------------------------

EDITABLE_FIELDS = [
    "description", "amount", "transaction_date", "category_id", "subcategory_id", "category_path", "vendor",
    "payment_method", "payment_reference", "payment_status", "notes", "receipt_reference", "expense_type",
    "project_phase",
]


def validate_expense_payload(data, partial=False):
    """Return (clean_values, error)."""
    values = {}
    if "description" in data or not partial:
        desc = clean_str(data.get("description"), 300)
        if len(desc) < 2:
            return None, "Description is required (at least 2 characters)."
        values["description"] = desc
    if "amount" in data or not partial:
        amount = parse_amount(data.get("amount"))
        if amount is None:
            return None, "Enter a valid amount greater than 0."
        values["amount"] = amount
    if "transaction_date" in data or not partial:
        date = parse_date(data.get("transaction_date"))
        if not date:
            return None, "Enter a valid transaction date (YYYY-MM-DD)."
        if date > utcnow() + timedelta(days=1):
            return None, "Transaction date cannot be in the future."
        values["transaction_date"] = date
    if "category_id" in data or not partial:
        selected = data.get("subcategory_id") or data.get("category_id")
        if not selected:
            return None, "Choose a category."
        cat = categories_col.find_one({"_id": to_oid(selected), "status": "active"}) if to_oid(selected) else None
        if not cat:
            return None, "Choose a valid, active category."
        top, sub = resolve_category_pair(selected)
        values["category_id"] = top
        values["subcategory_id"] = sub
        values["category_path"] = cat["path"]
    if "vendor" in data:
        values["vendor"] = clean_str(data.get("vendor"), 120)
    if "payment_method" in data:
        pm = clean_str(data.get("payment_method"), 40)
        if pm and pm not in PAYMENT_METHODS:
            return None, "Choose a valid payment method."
        values["payment_method"] = pm
    if "payment_status" in data:
        ps = clean_str(data.get("payment_status"), 40)
        if ps and ps not in PAYMENT_STATUSES:
            return None, "Choose a valid payment status."
        values["payment_status"] = ps
    if "expense_type" in data:
        et = clean_str(data.get("expense_type"), 40)
        if et and et not in EXPENSE_TYPES:
            return None, "Choose a valid expense type."
        values["expense_type"] = et
    for field, limit in (("payment_reference", 120), ("notes", 2000), ("receipt_reference", 120), ("project_phase", 120)):
        if field in data:
            values[field] = clean_str(data.get(field), limit)
    return values, None


def snapshot(exp):
    return {k: serialize(exp.get(k)) for k in EDITABLE_FIELDS}


def apply_edit(exp, values, reason):
    """Apply an edit with optimistic concurrency and write a revision record."""
    changes = {}
    for k, v in values.items():
        old = exp.get(k)
        if serialize(old) != serialize(v):
            changes[k] = {"from": serialize(old), "to": serialize(v)}
    if not changes:
        return exp, {}
    new_revision = exp.get("revision", 1) + 1
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "revision": exp.get("revision", 1)},
        {"$set": dict(values, revision=new_revision, updated_at=utcnow(),
                      modified_by=str(g.user["_id"]), modified_by_name=g.user.get("full_name") or g.user["username"])},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        return None, None
    revisions_col.insert_one({
        "expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_revision, "action": "edit",
        "changes": changes, "snapshot_before": snapshot(exp), "snapshot_after": snapshot(updated),
        "user_id": str(g.user["_id"]), "user_name": g.user.get("full_name") or g.user["username"],
        "at": utcnow(), "reason": reason,
    })
    record_audit("expense_edited", "expense", exp["expense_id"], {"revision": new_revision, "changes": changes, "reason": reason})
    return updated, changes


def build_expense_query(args, user):
    """Translate query-string filters into a MongoDB query. Returns (query, error)."""
    query = {}
    status = args.get("status", "active")
    if status in ("deleted", "all") and not has_permission(user, "expense:view_deleted"):
        status = "active"
    if status == "deleted":
        query["status"] = "deleted"
    elif status == "edited":
        query["status"] = "active"
        query["revision"] = {"$gt": 1}
    elif status == "all":
        pass
    else:
        query["status"] = "active"

    q = clean_str(args.get("q"), 120)
    if q:
        rx = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"expense_id": rx}, {"description": rx}, {"vendor": rx}, {"notes": rx}, {"payment_reference": rx}]

    def multi(name):
        raw = args.getlist(name) if hasattr(args, "getlist") else [args.get(name)]
        vals = []
        for r in raw:
            if r:
                vals.extend([v.strip() for v in str(r).split(",") if v.strip()])
        return vals

    cat_ids = multi("category_id")
    sub_ids = multi("subcategory_id")
    cat_or_sub = []
    if cat_ids:
        cat_or_sub.append({"category_id": {"$in": cat_ids}})
    if sub_ids:
        cat_or_sub.append({"subcategory_id": {"$in": sub_ids}})
    if cat_or_sub:
        if args.get("logic") == "any" and len(cat_or_sub) > 1:
            query.setdefault("$and", []).append({"$or": cat_or_sub})
        else:
            for clause in cat_or_sub:
                query.update(clause)

    for name in ("vendor", "payment_method", "payment_status", "expense_type", "project_phase"):
        vals = multi(name)
        if vals:
            query[name] = {"$in": vals}

    date_from = parse_date(args.get("date_from"))
    date_to = parse_date(args.get("date_to"), end_of_day=True)
    if args.get("date_from") and not date_from:
        return None, "Invalid 'from' date."
    if args.get("date_to") and not date_to:
        return None, "Invalid 'to' date."
    if args.get("year") and not date_from and not date_to:
        try:
            y = int(args["year"])
            m = int(args.get("month") or 0)
            if m:
                date_from = datetime(y, m, 1, tzinfo=timezone.utc)
                date_to = (datetime(y + (m // 12), (m % 12) + 1, 1, tzinfo=timezone.utc) - timedelta(milliseconds=1))
            else:
                date_from = datetime(y, 1, 1, tzinfo=timezone.utc)
                date_to = datetime(y, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        except ValueError:
            return None, "Invalid year/month."
    if date_from or date_to:
        rng = {}
        if date_from:
            rng["$gte"] = date_from
        if date_to:
            rng["$lte"] = date_to
        query["transaction_date"] = rng

    amt = {}
    if args.get("min_amount"):
        v = parse_amount(args["min_amount"])
        if v is None:
            return None, "Invalid minimum amount."
        amt["$gte"] = v
    if args.get("max_amount"):
        v = parse_amount(args["max_amount"])
        if v is None:
            return None, "Invalid maximum amount."
        amt["$lte"] = v
    if amt:
        query["amount"] = amt
    if args.get("created_by"):
        query["created_by"] = args["created_by"]
    return query, None


SORTABLE = {"transaction_date", "amount", "category_path", "vendor", "created_at", "updated_at", "expense_id", "description", "payment_method"}


@app.route("/api/expenses")
@require("expense:view")
def api_expenses_list():
    query, err = build_expense_query(request.args, g.user)
    if err:
        return json_error(err)
    sort_field = request.args.get("sort", "transaction_date")
    if sort_field not in SORTABLE:
        sort_field = "transaction_date"
    order = DESCENDING if request.args.get("order", "desc") == "desc" else ASCENDING
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(200, max(5, int(request.args.get("per_page", 25))))
    except ValueError:
        page, per_page = 1, 25
    summary = list(expenses_col.aggregate([
        {"$match": query}, {"$group": {"_id": None, "count": {"$sum": 1}, "total": {"$sum": "$amount"}}},
    ]))
    total_count = summary[0]["count"] if summary else 0
    total_amount = round(summary[0]["total"], 2) if summary else 0
    cursor = (expenses_col.find(query).sort([(sort_field, order), ("_id", DESCENDING)])
              .skip((page - 1) * per_page).limit(per_page))
    return jsonify({
        "items": serialize(list(cursor)), "page": page, "per_page": per_page,
        "total_count": total_count, "total_amount": total_amount,
        "pages": max(1, -(-total_count // per_page)),
    })


@app.route("/api/expenses", methods=["POST"])
@require("expense:create")
def api_expenses_create():
    data = request.get_json(silent=True) or {}
    idem_key = clean_str(request.headers.get("Idempotency-Key"), 128)
    if idem_key:
        prior = idempotency_col.find_one({"key": idem_key, "user_id": str(g.user["_id"])})
        if prior:
            return jsonify(prior["response"]), 200
    values, err = validate_expense_payload(data)
    if err:
        return json_error(err)
    now = utcnow()
    doc = dict(values)
    doc.setdefault("vendor", ""); doc.setdefault("payment_method", ""); doc.setdefault("payment_reference", "")
    doc.setdefault("payment_status", ""); doc.setdefault("notes", ""); doc.setdefault("receipt_reference", "")
    doc.setdefault("expense_type", ""); doc.setdefault("project_phase", "")
    doc.update({
        "status": "active", "revision": 1, "created_by": str(g.user["_id"]),
        "created_by_name": g.user.get("full_name") or g.user["username"], "created_at": now, "updated_at": now,
        "deleted_by": None, "deleted_at": None, "deletion_reason": None, "restoration_history": [],
    })
    for _ in range(3):
        doc["expense_id"] = next_expense_id()
        try:
            expenses_col.insert_one(doc)
            break
        except DuplicateKeyError:
            doc.pop("_id", None)
            continue
    else:
        return json_error("Could not generate a unique expense ID. Try again.", 500)
    revisions_col.insert_one({
        "expense_oid": doc["_id"], "expense_id": doc["expense_id"], "revision": 1, "action": "create",
        "changes": {}, "snapshot_before": None, "snapshot_after": snapshot(doc),
        "user_id": str(g.user["_id"]), "user_name": doc["created_by_name"], "at": now, "reason": "Created",
    })
    record_audit("expense_created", "expense", doc["expense_id"], {"amount": doc["amount"], "description": doc["description"]})
    response = {"expense": serialize(doc)}
    if idem_key:
        try:
            idempotency_col.insert_one({"key": idem_key, "user_id": str(g.user["_id"]), "response": response, "created_at": now})
        except DuplicateKeyError:
            pass
    return jsonify(response), 201


def load_expense_or_404(expense_ref):
    oid = to_oid(expense_ref)
    exp = expenses_col.find_one({"_id": oid}) if oid else None
    if not exp:
        exp = expenses_col.find_one({"expense_id": expense_ref})
    return exp


@app.route("/api/expenses/<expense_ref>")
@require("expense:view")
def api_expenses_get(expense_ref):
    exp = load_expense_or_404(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    if exp["status"] == "deleted" and not has_permission(g.user, "expense:view_deleted"):
        return json_error("Expense not found.", 404)
    revisions = list(revisions_col.find({"expense_oid": exp["_id"]}).sort("revision", ASCENDING))
    events = list(audit_col.find({"entity_type": "expense", "entity_id": exp["expense_id"]}).sort("at", ASCENDING))
    return jsonify({"expense": serialize(exp), "revisions": serialize(revisions), "events": serialize(events)})


@app.route("/api/expenses/<expense_ref>", methods=["PUT"])
@require("expense:edit")
def api_expenses_update(expense_ref):
    exp = load_expense_or_404(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    if exp["status"] == "deleted":
        return json_error("Restore this expense before editing it.", 409)
    data = request.get_json(silent=True) or {}
    reason = clean_str(data.get("reason"), 300)
    if len(reason) < 3:
        return json_error("A reason for the change is required.")
    if "expected_revision" in data and int(data["expected_revision"]) != exp.get("revision", 1):
        return json_error("This expense was changed by someone else. Reload and try again.", 409, current_revision=exp.get("revision"))
    values, err = validate_expense_payload(data, partial=True)
    if err:
        return json_error(err)
    updated, changes = apply_edit(exp, values, reason)
    if updated is None:
        return json_error("This expense was changed by someone else. Reload and try again.", 409)
    if not changes:
        return jsonify({"expense": serialize(exp), "changes": {}, "message": "No changes detected."})
    return jsonify({"expense": serialize(updated), "changes": changes})


@app.route("/api/expenses/<expense_ref>", methods=["DELETE"])
@require("expense:delete")
def api_expenses_delete(expense_ref):
    exp = load_expense_or_404(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    data = request.get_json(silent=True) or {}
    reason = clean_str(data.get("reason"), 300)
    permanent = bool(data.get("permanent"))
    if permanent:
        if not has_permission(g.user, "expense:purge"):
            return json_error("Only administrators can permanently delete records.", 403)
        if exp["status"] != "deleted":
            return json_error("Soft-delete the expense before permanently removing it.", 409)
        if len(reason) < 3:
            return json_error("A reason is required for permanent deletion.")
        expenses_col.delete_one({"_id": exp["_id"]})
        record_audit("expense_purged", "expense", exp["expense_id"], {"reason": reason, "snapshot": snapshot(exp)})
        return jsonify({"ok": True, "permanent": True})
    if exp["status"] == "deleted":
        return json_error("This expense is already deleted.", 409)
    if len(reason) < 3:
        return json_error("A deletion reason is required.")
    now = utcnow()
    new_revision = exp.get("revision", 1) + 1
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "status": "active"},
        {"$set": {"status": "deleted", "deleted_by": str(g.user["_id"]), "deleted_by_name": g.user.get("full_name") or g.user["username"],
                  "deleted_at": now, "deletion_reason": reason, "revision": new_revision, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        return json_error("This expense is already deleted.", 409)
    revisions_col.insert_one({
        "expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_revision, "action": "delete",
        "changes": {"status": {"from": "active", "to": "deleted"}}, "snapshot_before": snapshot(exp),
        "snapshot_after": snapshot(updated), "user_id": str(g.user["_id"]),
        "user_name": g.user.get("full_name") or g.user["username"], "at": now, "reason": reason,
    })
    record_audit("expense_deleted", "expense", exp["expense_id"], {"reason": reason, "amount": exp["amount"]})
    return jsonify({"expense": serialize(updated)})


@app.route("/api/expenses/<expense_ref>/restore", methods=["POST"])
@require("expense:restore")
def api_expenses_restore(expense_ref):
    exp = load_expense_or_404(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    if exp["status"] != "deleted":
        return json_error("This expense is not deleted.", 409)
    data = request.get_json(silent=True) or {}
    reason = clean_str(data.get("reason"), 300)
    if len(reason) < 3:
        return json_error("A reason for restoring is required.")
    now = utcnow()
    new_revision = exp.get("revision", 1) + 1
    entry = {"restored_by": str(g.user["_id"]), "restored_by_name": g.user.get("full_name") or g.user["username"],
             "restored_at": now, "reason": reason, "previous_deletion": {
                 "deleted_by_name": exp.get("deleted_by_name"), "deleted_at": exp.get("deleted_at"), "reason": exp.get("deletion_reason")}}
    updated = expenses_col.find_one_and_update(
        {"_id": exp["_id"], "status": "deleted"},
        {"$set": {"status": "active", "deleted_by": None, "deleted_at": None, "deletion_reason": None,
                  "revision": new_revision, "updated_at": now}, "$push": {"restoration_history": entry}},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        return json_error("This expense is not deleted.", 409)
    revisions_col.insert_one({
        "expense_oid": exp["_id"], "expense_id": exp["expense_id"], "revision": new_revision, "action": "restore",
        "changes": {"status": {"from": "deleted", "to": "active"}}, "snapshot_before": snapshot(exp),
        "snapshot_after": snapshot(updated), "user_id": str(g.user["_id"]),
        "user_name": g.user.get("full_name") or g.user["username"], "at": now, "reason": reason,
    })
    record_audit("expense_restored", "expense", exp["expense_id"], {"reason": reason})
    return jsonify({"expense": serialize(updated)})


@app.route("/api/expenses/<expense_ref>/revisions")
@require("expense:view")
def api_expenses_revisions(expense_ref):
    exp = load_expense_or_404(expense_ref)
    if not exp:
        return json_error("Expense not found.", 404)
    revisions = list(revisions_col.find({"expense_oid": exp["_id"]}).sort("revision", ASCENDING))
    return jsonify({"revisions": serialize(revisions)})


@app.route("/api/expenses/meta")
@require("expense:view")
def api_expenses_meta():
    """Distinct vendors / phases for filter dropdowns."""
    vendors = sorted(v for v in expenses_col.distinct("vendor") if v)
    phases = sorted(p for p in expenses_col.distinct("project_phase") if p)
    years = sorted({d.year for d in expenses_col.distinct("transaction_date") if d}, reverse=True)
    return jsonify({"vendors": vendors, "phases": phases, "years": years})


# ---------------------------------------------------------------------------
# Dashboard API
# ---------------------------------------------------------------------------

def period_range(args):
    """Return (date_from, date_to, label) for a dashboard period."""
    period = args.get("period", "this_month")
    now = utcnow()
    df = parse_date(args.get("date_from"))
    dt = parse_date(args.get("date_to"), end_of_day=True)
    if df or dt:
        return df, dt, "Custom range"
    if period == "this_month":
        return datetime(now.year, now.month, 1, tzinfo=timezone.utc), None, now.strftime("%B %Y")
    if period == "last_month":
        first = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
        last_month_end = first - timedelta(milliseconds=1)
        return datetime(last_month_end.year, last_month_end.month, 1, tzinfo=timezone.utc), last_month_end, last_month_end.strftime("%B %Y")
    if period == "this_quarter":
        qm = ((now.month - 1) // 3) * 3 + 1
        return datetime(now.year, qm, 1, tzinfo=timezone.utc), None, f"Q{(now.month - 1) // 3 + 1} {now.year}"
    if period == "this_year":
        return datetime(now.year, 1, 1, tzinfo=timezone.utc), None, str(now.year)
    if period == "last_year":
        return datetime(now.year - 1, 1, 1, tzinfo=timezone.utc), datetime(now.year - 1, 12, 31, 23, 59, 59, tzinfo=timezone.utc), str(now.year - 1)
    if period == "last_30_days":
        return now - timedelta(days=30), None, "Last 30 days"
    if period == "last_90_days":
        return now - timedelta(days=90), None, "Last 90 days"
    return None, None, "All time"


@app.route("/api/dashboard/summary")
@require("expense:view")
def api_dashboard_summary():
    date_from, date_to, label = period_range(request.args)
    match = {"status": "active"}
    if date_from or date_to:
        rng = {}
        if date_from:
            rng["$gte"] = date_from
        if date_to:
            rng["$lte"] = date_to
        match["transaction_date"] = rng

    totals = list(expenses_col.aggregate([
        {"$match": match},
        {"$group": {"_id": None, "total": {"$sum": "$amount"}, "count": {"$sum": 1},
                    "average": {"$avg": "$amount"}, "max": {"$max": "$amount"}}},
    ]))
    t = totals[0] if totals else {"total": 0, "count": 0, "average": 0, "max": 0}

    largest = expenses_col.find_one(match, sort=[("amount", DESCENDING)])

    by_category = list(expenses_col.aggregate([
        {"$match": match},
        {"$group": {"_id": "$category_id", "name": {"$first": {"$arrayElemAt": ["$category_path", 0]}},
                    "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"total": -1}},
    ]))
    by_subcategory = list(expenses_col.aggregate([
        {"$match": dict(match, subcategory_id={"$ne": None})},
        {"$group": {"_id": "$subcategory_id", "path": {"$first": "$category_path"}, "category_id": {"$first": "$category_id"},
                    "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"total": -1}}, {"$limit": 15},
    ]))
    by_payment = list(expenses_col.aggregate([
        {"$match": match},
        {"$group": {"_id": {"$ifNull": ["$payment_method", ""]}, "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"total": -1}},
    ]))
    top_vendors = list(expenses_col.aggregate([
        {"$match": dict(match, vendor={"$nin": ["", None]})},
        {"$group": {"_id": "$vendor", "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"total": -1}}, {"$limit": 8},
    ]))
    pending = list(expenses_col.aggregate([
        {"$match": dict(match, payment_status={"$in": ["Pending", "Partially Paid"]})},
        {"$group": {"_id": "$payment_status", "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
    ]))
    recent = list(expenses_col.find({"status": "active"}).sort([("created_at", DESCENDING)]).limit(8))

    granularity = request.args.get("granularity") or ("day" if (date_from and (date_to or utcnow()) - date_from <= timedelta(days=62)) else "month")
    trend = trend_series(match, granularity)

    return jsonify({
        "period": {"label": label, "date_from": serialize(date_from), "date_to": serialize(date_to)},
        "totals": {"total": round(t["total"] or 0, 2), "count": t["count"], "average": round(t["average"] or 0, 2), "max": round(t["max"] or 0, 2)},
        "largest": serialize(largest),
        "by_category": [{"category_id": r["_id"], "name": r["name"] or "Uncategorised", "total": round(r["total"], 2), "count": r["count"]} for r in by_category],
        "by_subcategory": [{"subcategory_id": r["_id"], "category_id": r["category_id"], "path": r["path"], "name": " > ".join(r["path"]),
                            "total": round(r["total"], 2), "count": r["count"]} for r in by_subcategory],
        "by_payment_method": [{"name": r["_id"] or "Not specified", "total": round(r["total"], 2), "count": r["count"]} for r in by_payment],
        "top_vendors": [{"vendor": r["_id"], "total": round(r["total"], 2), "count": r["count"]} for r in top_vendors],
        "pending": [{"status": r["_id"], "total": round(r["total"], 2), "count": r["count"]} for r in pending],
        "recent": serialize(recent),
        "trend": {"granularity": granularity, "points": trend},
    })


def trend_series(match, granularity):
    fmt = {"day": "%Y-%m-%d", "month": "%Y-%m", "year": "%Y"}.get(granularity, "%Y-%m")
    if granularity == "quarter":
        pipeline = [
            {"$match": match},
            {"$group": {"_id": {"y": {"$year": "$transaction_date"}, "q": {"$ceil": {"$divide": [{"$month": "$transaction_date"}, 3]}}},
                        "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
            {"$sort": {"_id.y": 1, "_id.q": 1}},
        ]
        return [{"label": f"{r['_id']['y']}-Q{int(r['_id']['q'])}", "total": round(r["total"], 2), "count": r["count"]}
                for r in expenses_col.aggregate(pipeline)]
    pipeline = [
        {"$match": match},
        {"$group": {"_id": {"$dateToString": {"format": fmt, "date": "$transaction_date"}},
                    "total": {"$sum": "$amount"}, "count": {"$sum": 1}}},
        {"$sort": {"_id": 1}},
    ]
    return [{"label": r["_id"], "total": round(r["total"], 2), "count": r["count"]} for r in expenses_col.aggregate(pipeline)]


@app.route("/api/dashboard/trends")
@require("expense:view")
def api_dashboard_trends():
    """Drill-down series: year -> month -> day."""
    granularity = request.args.get("granularity", "month")
    if granularity not in ("day", "month", "quarter", "year"):
        granularity = "month"
    query, err = build_expense_query(request.args, g.user)
    if err:
        return json_error(err)
    query["status"] = "active"
    return jsonify({"granularity": granularity, "points": trend_series(query, granularity)})


def default_preferences(role):
    layout = DEFAULT_LAYOUTS.get(role, DEFAULT_LAYOUTS["viewer"])
    sizes = {w["id"]: w["size"] for w in DASHBOARD_WIDGETS}
    return {
        "layout": [{"id": wid, "visible": True, "size": sizes.get(wid, "medium")} for wid in layout],
        "default_period": "this_month",
        "custom_range": {"date_from": None, "date_to": None},
        "chart_type_category": "bar",
        "trend_granularity": "auto",
    }


@app.route("/api/dashboard/preferences")
@login_required
def api_prefs_get():
    doc = prefs_col.find_one({"user_id": str(g.user["_id"])})
    prefs = doc["preferences"] if doc else default_preferences(g.user["role"])
    return jsonify({"preferences": prefs, "is_default": doc is None})


@app.route("/api/dashboard/preferences", methods=["PUT"])
@require("dashboard:customize")
def api_prefs_put():
    data = request.get_json(silent=True) or {}
    valid_ids = {w["id"] for w in DASHBOARD_WIDGETS}
    layout = []
    seen = set()
    for item in data.get("layout", []):
        wid = item.get("id")
        if wid in valid_ids and wid not in seen:
            seen.add(wid)
            layout.append({"id": wid, "visible": bool(item.get("visible", True)),
                           "size": item.get("size") if item.get("size") in ("small", "medium", "large") else "medium"})
    if not layout:
        return json_error("Choose at least one widget.")
    period = data.get("default_period", "this_month")
    if period not in ("this_month", "last_month", "this_quarter", "this_year", "last_year", "last_30_days", "last_90_days", "all_time", "custom"):
        period = "this_month"
    cr = data.get("custom_range") or {}
    prefs = {
        "layout": layout, "default_period": period,
        "custom_range": {"date_from": clean_str(cr.get("date_from"), 10) or None, "date_to": clean_str(cr.get("date_to"), 10) or None},
        "chart_type_category": data.get("chart_type_category") if data.get("chart_type_category") in ("bar", "donut") else "bar",
        "trend_granularity": data.get("trend_granularity") if data.get("trend_granularity") in ("auto", "day", "month", "quarter", "year") else "auto",
    }
    prefs_col.update_one({"user_id": str(g.user["_id"])}, {"$set": {"preferences": prefs, "updated_at": utcnow()}}, upsert=True)
    return jsonify({"preferences": prefs})


@app.route("/api/dashboard/preferences", methods=["DELETE"])
@require("dashboard:customize")
def api_prefs_reset():
    prefs_col.delete_one({"user_id": str(g.user["_id"])})
    return jsonify({"preferences": default_preferences(g.user["role"])})


# ---------------------------------------------------------------------------
# Saved filters API
# ---------------------------------------------------------------------------

@app.route("/api/filters")
@login_required
def api_filters_list():
    docs = list(filters_col.find({"user_id": str(g.user["_id"])}).sort("name", ASCENDING))
    return jsonify({"filters": serialize(docs)})


@app.route("/api/filters", methods=["POST"])
@login_required
def api_filters_create():
    data = request.get_json(silent=True) or {}
    name = clean_str(data.get("name"), 60)
    params = data.get("params") or {}
    if len(name) < 2 or not isinstance(params, dict):
        return json_error("Give the filter a name.")
    clean_params = {k: clean_str(v, 200) for k, v in params.items() if v not in (None, "", [])}
    doc = {"user_id": str(g.user["_id"]), "name": name, "params": clean_params, "created_at": utcnow()}
    filters_col.update_one({"user_id": doc["user_id"], "name": name}, {"$set": doc}, upsert=True)
    return jsonify({"filter": serialize(filters_col.find_one({"user_id": doc["user_id"], "name": name}))}), 201


@app.route("/api/filters/<filter_id>", methods=["DELETE"])
@login_required
def api_filters_delete(filter_id):
    res = filters_col.delete_one({"_id": to_oid(filter_id), "user_id": str(g.user["_id"])})
    if not res.deleted_count:
        return json_error("Filter not found.", 404)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Audit log API
# ---------------------------------------------------------------------------

@app.route("/api/audit")
@require("audit:view")
def api_audit():
    query = {}
    if request.args.get("action"):
        query["action"] = request.args["action"]
    if request.args.get("entity_type"):
        query["entity_type"] = request.args["entity_type"]
    if request.args.get("entity_id"):
        query["entity_id"] = request.args["entity_id"]
    if request.args.get("user_id"):
        query["user_id"] = request.args["user_id"]
    df = parse_date(request.args.get("date_from"))
    dt = parse_date(request.args.get("date_to"), end_of_day=True)
    if df or dt:
        query["at"] = {k: v for k, v in (("$gte", df), ("$lte", dt)) if v}
    try:
        page = max(1, int(request.args.get("page", 1)))
        per_page = min(200, max(10, int(request.args.get("per_page", 50))))
    except ValueError:
        page, per_page = 1, 50
    total = audit_col.count_documents(query)
    docs = list(audit_col.find(query).sort("at", DESCENDING).skip((page - 1) * per_page).limit(per_page))
    actions = sorted(a for a in audit_col.distinct("action") if a)
    return jsonify({"items": serialize(docs), "total": total, "page": page, "pages": max(1, -(-total // per_page)), "actions": actions})


# ---------------------------------------------------------------------------
# Export, backup and restore
# ---------------------------------------------------------------------------

CSV_COLUMNS = [
    ("expense_id", "Expense ID"), ("transaction_date", "Date"), ("description", "Description"), ("amount", "Amount (INR)"),
    ("category", "Category"), ("subcategory", "Subcategory"), ("vendor", "Vendor"), ("payment_method", "Payment Method"),
    ("payment_reference", "Payment Reference"), ("payment_status", "Payment Status"), ("expense_type", "Expense Type"),
    ("project_phase", "Project / Phase"), ("receipt_reference", "Receipt / Invoice"), ("notes", "Notes"),
    ("status", "Status"), ("revision", "Revision"), ("created_by_name", "Created By"), ("created_at", "Created At"),
    ("updated_at", "Updated At"), ("deleted_by_name", "Deleted By"), ("deleted_at", "Deleted At"), ("deletion_reason", "Deletion Reason"),
]


def expense_csv_row(exp):
    path = exp.get("category_path") or []
    row = dict(exp)
    row["category"] = path[0] if path else ""
    row["subcategory"] = " > ".join(path[1:]) if len(path) > 1 else ""
    row["transaction_date"] = exp["transaction_date"].strftime("%Y-%m-%d") if exp.get("transaction_date") else ""
    for k in ("created_at", "updated_at", "deleted_at"):
        v = exp.get(k)
        row[k] = v.strftime("%Y-%m-%d %H:%M:%S") if isinstance(v, datetime) else ""
    return [row.get(key, "") if row.get(key) is not None else "" for key, _ in CSV_COLUMNS]


@app.route("/api/export/csv")
@require("export")
def api_export_csv():
    query, err = build_expense_query(request.args, g.user)
    if err:
        return json_error(err)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([label for _, label in CSV_COLUMNS])
    for exp in expenses_col.find(query).sort("transaction_date", ASCENDING):
        writer.writerow(expense_csv_row(exp))
    record_audit("export_csv", "export", None, {"filters": request.args.to_dict(flat=False)})
    filename = f"expenses_{utcnow().strftime('%Y%m%d_%H%M')}.csv"
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


@app.route("/api/export/json")
@require("export")
def api_export_json():
    query, err = build_expense_query(request.args, g.user)
    if err:
        return json_error(err)
    items = serialize(list(expenses_col.find(query).sort("transaction_date", ASCENDING)))
    payload = {"exported_at": serialize(utcnow()), "filters": request.args.to_dict(flat=False), "count": len(items), "expenses": items}
    if request.args.get("include_history") == "1" and has_permission(g.user, "audit:view"):
        ids = [to_oid(i["id"]) for i in items]
        payload["revisions"] = serialize(list(revisions_col.find({"expense_oid": {"$in": ids}}).sort([("expense_id", 1), ("revision", 1)])))
    record_audit("export_json", "export", None, {"count": len(items)})
    filename = f"expenses_{utcnow().strftime('%Y%m%d_%H%M')}.json"
    return Response(json.dumps(payload, indent=2), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


@app.route("/api/export/audit.csv")
@require("audit:view")
def api_export_audit_csv():
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Time", "User", "Action", "Entity Type", "Entity ID", "IP", "Details"])
    for row in audit_col.find({}).sort("at", DESCENDING).limit(20000):
        writer.writerow([row["at"].strftime("%Y-%m-%d %H:%M:%S"), row.get("user_name"), row.get("action"),
                         row.get("entity_type"), row.get("entity_id"), row.get("ip"), json.dumps(serialize(row.get("details", {})))])
    record_audit("export_audit", "export", None)
    return Response("\ufeff" + buf.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=audit_log.csv"})


BACKUP_VERSION = 1
BACKUP_COLLECTIONS = ["expenses", "categories", "expense_revisions", "audit_logs", "dashboard_preferences", "saved_filters", "counters", "users"]


def build_backup(include_users=True):
    data = {"format": "restaurant-expense-manager-backup", "version": BACKUP_VERSION,
            "generated_at": serialize(utcnow()), "collections": {}}
    for name in BACKUP_COLLECTIONS:
        if name == "users" and not include_users:
            continue
        docs = []
        for d in db[name].find({}):
            docs.append(json.loads(json.dumps(d, default=_bson_default)))
        data["collections"][name] = docs
    return data


def _bson_default(o):
    if isinstance(o, ObjectId):
        return {"$oid": str(o)}
    if isinstance(o, datetime):
        if o.tzinfo is None:
            o = o.replace(tzinfo=timezone.utc)
        return {"$date": o.isoformat()}
    raise TypeError(f"Cannot serialise {type(o)}")


def _bson_restore(obj):
    if isinstance(obj, list):
        return [_bson_restore(x) for x in obj]
    if isinstance(obj, dict):
        if set(obj.keys()) == {"$oid"}:
            return ObjectId(obj["$oid"])
        if set(obj.keys()) == {"$date"}:
            return datetime.fromisoformat(obj["$date"].replace("Z", "+00:00"))
        return {k: _bson_restore(v) for k, v in obj.items()}
    return obj


@app.route("/api/backup")
@require("backup:create")
def api_backup_download():
    include_users = has_permission(g.user, "user:manage")
    data = build_backup(include_users=include_users)
    filename = f"expense_manager_backup_{utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    backup_logs_col.insert_one({"type": "manual_download", "user_id": str(g.user["_id"]), "user_name": g.user.get("full_name"),
                                "at": utcnow(), "counts": {k: len(v) for k, v in data["collections"].items()}})
    record_audit("backup_downloaded", "backup", None, {"include_users": include_users})
    return Response(json.dumps(data), mimetype="application/json",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


def validate_backup_payload(data):
    problems = []
    if not isinstance(data, dict) or data.get("format") != "restaurant-expense-manager-backup":
        return ["This file is not an Expense Manager backup."], {}
    if data.get("version") != BACKUP_VERSION:
        problems.append(f"Unsupported backup version {data.get('version')}.")
    cols = data.get("collections") or {}
    if "expenses" not in cols or "categories" not in cols:
        problems.append("Backup is missing the expenses or categories collection.")
    summary = {}
    for name, docs in cols.items():
        if name not in BACKUP_COLLECTIONS:
            problems.append(f"Unknown collection '{name}'.")
            continue
        if not isinstance(docs, list):
            problems.append(f"Collection '{name}' must be a list.")
            continue
        ids = set()
        dup = 0
        for d in docs:
            if not isinstance(d, dict) or "_id" not in d:
                problems.append(f"A record in '{name}' has no _id.")
                break
            key = json.dumps(d["_id"], sort_keys=True)
            if key in ids:
                dup += 1
            ids.add(key)
        if dup:
            problems.append(f"{dup} duplicate _id value(s) in '{name}'.")
        if name == "expenses":
            eids = [d.get("expense_id") for d in docs if isinstance(d, dict)]
            dups = len(eids) - len(set(eids))
            if dups:
                problems.append(f"{dups} duplicate expense ID(s) in the backup.")
            for d in docs:
                if isinstance(d, dict) and (not isinstance(d.get("amount"), (int, float)) or d.get("amount", 0) <= 0):
                    problems.append(f"Expense {d.get('expense_id')} has an invalid amount.")
                    break
        existing = 0
        if name in ("expenses", "categories", "users"):
            restored_ids = [_bson_restore(d["_id"]) for d in docs if isinstance(d, dict) and "_id" in d]
            existing = db[name].count_documents({"_id": {"$in": restored_ids}}) if restored_ids else 0
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
    mode = request.form.get("mode") or (request.get_json(silent=True) or {}).get("mode") or "merge"
    confirm = (request.form.get("confirm") or str((request.get_json(silent=True) or {}).get("confirm", ""))).lower() == "true"
    if mode not in ("merge", "replace"):
        return json_error("Mode must be 'merge' or 'replace'.")
    if not confirm:
        return json_error("Confirmation is required before restoring.")
    problems, summary = validate_backup_payload(data)
    if problems:
        return json_error("Backup failed validation.", 400, problems=problems)

    # Safety backup before any restore.
    pre = build_backup(include_users=True)
    pre_path = os.path.join(CONFIG["BACKUP_DIR"], f"pre_restore_{utcnow().strftime('%Y%m%d_%H%M%S')}.json")
    os.makedirs(CONFIG["BACKUP_DIR"], exist_ok=True)
    with open(pre_path, "w", encoding="utf-8") as fh:
        json.dump(pre, fh)

    me_id = g.user["_id"]
    results = {}
    for name in BACKUP_COLLECTIONS:
        docs = data["collections"].get(name)
        if docs is None:
            continue
        if name == "users":
            # Never drop the user performing the restore; never import users without password hashes.
            docs = [d for d in docs if d.get("password_hash")]
        restored = [_bson_restore(d) for d in docs]
        inserted = updated = skipped = 0
        if mode == "replace":
            if name == "users":
                db[name].delete_many({"_id": {"$ne": me_id}})
            else:
                db[name].delete_many({})
        for d in restored:
            if name == "users" and d["_id"] == me_id:
                skipped += 1
                continue
            if mode == "replace":
                db[name].insert_one(d)
                inserted += 1
            else:
                res = db[name].replace_one({"_id": d["_id"]}, d, upsert=True)
                if res.upserted_id is not None:
                    inserted += 1
                else:
                    updated += 1
        results[name] = {"inserted": inserted, "updated": updated, "skipped": skipped}
    ensure_indexes()
    backup_logs_col.insert_one({"type": f"restore_{mode}", "user_id": str(me_id), "user_name": g.user.get("full_name"),
                                "at": utcnow(), "results": results, "pre_restore_file": os.path.basename(pre_path)})
    record_audit("backup_restored", "backup", None, {"mode": mode, "results": results})
    return jsonify({"ok": True, "mode": mode, "results": results, "pre_restore_backup": os.path.basename(pre_path)})


@app.route("/api/backup/logs")
@require("backup:create")
def api_backup_logs():
    docs = list(backup_logs_col.find({}).sort("at", DESCENDING).limit(50))
    files = list_backup_files()
    return jsonify({"logs": serialize(docs), "files": files[:60], "total_files": len(files),
                    "schedule_hours": CONFIG["BACKUP_INTERVAL_HOURS"], "on_change": CONFIG["BACKUP_ON_CHANGE"],
                    "retention_days": CONFIG["BACKUP_RETENTION_DAYS"]})


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


# --- automatic JSON backups -------------------------------------------------
# Every data change requests a backup. A worker thread waits a few seconds so a
# burst of edits produces one file, then writes a full snapshot to
#   backups/<YYYY>/<MM>/<DD>/<HHMMSS>_<reason>.json
# and refreshes backups/latest.json. Old snapshots are thinned to one per day
# after BACKUP_RETENTION_DAYS.

_backup_event = threading.Event()
_backup_reasons = []
_backup_lock = threading.Lock()


def request_backup(reason="change"):
    if not CONFIG["BACKUP_ON_CHANGE"]:
        return
    with _backup_lock:
        _backup_reasons.append(reason)
    _backup_event.set()


def write_backup_file(reason, subfolder=True):
    """Write a full JSON backup to disk and record it. Returns the relative path."""
    now = utcnow()
    data = build_backup(include_users=True)
    if subfolder:
        folder = os.path.join(CONFIG["BACKUP_DIR"], now.strftime("%Y"), now.strftime("%m"), now.strftime("%d"))
    else:
        folder = CONFIG["BACKUP_DIR"]
    os.makedirs(folder, exist_ok=True)
    safe_reason = re.sub(r"[^a-z0-9_]+", "_", reason.lower())[:40]
    path = os.path.join(folder, f"{now.strftime('%H%M%S')}_{safe_reason}.json" if subfolder else f"{safe_reason}_{now.strftime('%Y%m%d_%H%M%S')}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)  # atomic: never leaves a half-written file
    latest = os.path.join(CONFIG["BACKUP_DIR"], "latest.json")
    with open(latest + ".tmp", "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(latest + ".tmp", latest)
    rel = os.path.relpath(path, CONFIG["BACKUP_DIR"]).replace(os.sep, "/")
    backup_logs_col.insert_one({"type": "auto_change" if subfolder else "scheduled", "reason": reason, "at": now, "file": rel,
                                "size": os.path.getsize(path), "counts": {k: len(v) for k, v in data["collections"].items()}})
    return rel


def list_backup_files():
    """All backup files on disk, newest first, with paths relative to the backup folder."""
    files = []
    if not os.path.isdir(CONFIG["BACKUP_DIR"]):
        return files
    for root, _dirs, names in os.walk(CONFIG["BACKUP_DIR"]):
        for fn in names:
            if fn.endswith(".json"):
                p = os.path.join(root, fn)
                files.append({"name": os.path.relpath(p, CONFIG["BACKUP_DIR"]).replace(os.sep, "/"), "size": os.path.getsize(p),
                              "modified": serialize(datetime.fromtimestamp(os.path.getmtime(p), timezone.utc)), "mtime": os.path.getmtime(p)})
    files.sort(key=lambda f: f["mtime"], reverse=True)
    for f in files:
        f.pop("mtime", None)
    return files


def prune_change_backups():
    """Keep every snapshot for the retention window; older days keep only their last snapshot."""
    cutoff = time.time() - CONFIG["BACKUP_RETENTION_DAYS"] * 86400
    by_day = {}
    for root, _dirs, names in os.walk(CONFIG["BACKUP_DIR"]):
        if root == CONFIG["BACKUP_DIR"]:
            continue
        for fn in names:
            if fn.endswith(".json"):
                p = os.path.join(root, fn)
                if os.path.getmtime(p) < cutoff:
                    by_day.setdefault(root, []).append(p)
    for folder, paths in by_day.items():
        paths.sort(key=os.path.getmtime)
        for old in paths[:-1]:
            os.remove(old)


def change_backup_worker():
    while True:
        _backup_event.wait()
        time.sleep(CONFIG["BACKUP_DEBOUNCE_SECONDS"])
        _backup_event.clear()
        with _backup_lock:
            reasons = list(_backup_reasons)
            _backup_reasons.clear()
        if not reasons:
            continue
        try:
            reason = reasons[-1] if len(set(reasons)) == 1 else f"{len(reasons)}_changes"
            rel = write_backup_file(reason, subfolder=True)
            prune_change_backups()
            log.info("Change backup written: %s", rel)
        except Exception as exc:  # never let a backup failure crash the worker
            log.exception("Change backup failed: %s", exc)


def scheduled_backup_loop():
    """Background thread: write a full JSON backup every N hours and prune old ones."""
    interval = CONFIG["BACKUP_INTERVAL_HOURS"] * 3600
    while True:
        try:
            os.makedirs(CONFIG["BACKUP_DIR"], exist_ok=True)
            # Skip if another worker already wrote a backup within this interval.
            recent = [os.path.getmtime(os.path.join(CONFIG["BACKUP_DIR"], f)) for f in os.listdir(CONFIG["BACKUP_DIR"]) if f.startswith("scheduled_")]
            if recent and time.time() - max(recent) < interval - 120:
                time.sleep(interval - (time.time() - max(recent)))
                continue
            path = write_backup_file("scheduled", subfolder=False)
            scheduled = sorted(f for f in os.listdir(CONFIG["BACKUP_DIR"]) if f.startswith("scheduled_"))
            for old in scheduled[:-CONFIG["BACKUPS_TO_KEEP"]]:
                os.remove(os.path.join(CONFIG["BACKUP_DIR"], old))
            log.info("Scheduled backup written: %s", path)
        except Exception as exc:  # keep the thread alive no matter what
            log.exception("Scheduled backup failed: %s", exc)
        time.sleep(interval)


# ---------------------------------------------------------------------------
# Error handlers
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
        return json_error("Something went wrong on the server. Try again.", 500)
    return render_template("error.html", code=500, message="Something went wrong. Try again."), 500


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def init_app():
    check_database_connection()
    ensure_indexes()
    seed_defaults()
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        threading.Thread(target=change_backup_worker, name="change-backups", daemon=True).start()
        threading.Thread(target=scheduled_backup_loop, name="scheduled-backups", daemon=True).start()


if __name__ == "__main__":
    init_app()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
else:
    # Running under gunicorn: `gunicorn -w 2 -b 127.0.0.1:8000 app:app`
    init_app()
