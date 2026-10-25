# Restaurant Expense Manager

Web app for recording, searching and auditing restaurant expenses.
Flask + MongoDB backend, plain HTML/CSS/JavaScript frontend, works on phone, tablet and desktop.

## Run locally

```bash
python3 -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
# MongoDB Atlas (set these in the same terminal, then start):
export MONGODB_USERNAME="your_db_username"
export MONGODB_PASSWORD="your_db_password"
# Windows PowerShell:  $env:MONGODB_USERNAME="..."; $env:MONGODB_PASSWORD="..."
python app.py
```

Or give the whole connection string with `MONGODB_URI=mongodb+srv://user:pass@expensemanager.exoz8sx.mongodb.net/`.
Without any of these it falls back to a local MongoDB on `localhost:27017`.
Remember to allow your IP (or the server's IP) in Atlas → Network Access.

Open http://localhost:5000 and sign in:

- username: `admin`
- password: `Admin@12345` (you are forced to change it on first sign-in)

## What is included

| Area | Details |
|---|---|
| Login | Password hashing, 5 failed attempts = 15 min lockout, 30 min idle logout, CSRF tokens on every write, secure cookie flags, forced password change for new accounts |
| Roles | admin · manager · accountant · viewer (permissions enforced on the server) |
| Expenses | Unique IDs (`EXP-2026-00001`), INR amounts, vendor, payment method/reference/status, notes, receipt reference, expense type, setup phase |
| Editing | Reason required; every edit stored as a numbered revision with before/after values, user and time; stale-edit protection |
| Deleting | Soft delete with reason; deleted records viewable and restorable by authorised users; permanent delete is admin-only |
| Categories | Unlimited nesting, rename, archive with "move expenses to…" step, usage counts, 13 default categories seeded |
| Dashboard | Per-user widget layout (show/hide, drag reorder, size), period presets or custom range, drill-down from charts into transactions; year → month → day |
| Search | Text, category/subcategory (AND or OR), date range, amount range, vendor, method, status, record status; sorting, paging, saved filters, match count and total |
| History | Full audit log with filters, deleted and edited record lists, per-record timeline |
| Export | CSV and JSON (with optional revision history), audit CSV, printable report |
| Backup | **Automatic JSON backup after every change** into `backups/YYYY/MM/DD/HHMMSS_reason.json` (rapid edits grouped into one file), `backups/latest.json` always newest, one scheduled copy a day, 30-day retention then one per day; downloadable backup, validate → preview → confirm restore (merge or replace), safety copy before restore |

MongoDB collections: `users`, `expenses`, `categories`, `expense_revisions`, `audit_logs`, `dashboard_preferences`, `saved_filters`, `backup_logs`, `counters`, `idempotency_keys`.

## Production (Ubuntu + Gunicorn + Nginx)

1. Copy the project to `/opt/expense-manager`, create the venv and install requirements.
2. Create a MongoDB user: `mongosh < deploy/mongo-setup.js` (edit the password first) and enable auth in `mongod.conf`.
3. Copy `deploy/expense-manager.service` to `/etc/systemd/system/`, set `EM_MONGO_URI`, `EM_SECRET_KEY` and `EM_SECURE_COOKIES=1`, then `systemctl enable --now expense-manager`.
4. Copy `deploy/nginx.conf` to `/etc/nginx/sites-available/`, enable it and get a TLS certificate (certbot).
5. Backups are written to `backups/` automatically after every change. Keep that folder on persistent storage (or sync it to cloud storage) — on hosts with temporary disks it is wiped on redeploy.

Settings live at the top of `app.py` (`CONFIG`). Environment variables `EM_MONGO_URI`, `EM_DB_NAME`, `EM_SECRET_KEY`, `EM_SECURE_COOKIES` override the defaults so secrets stay out of the code.

## Project layout

```
app.py                  all backend code (routes, auth, audit, backups)
templates/              login.html, index.html (app shell), error.html
static/css/style.css    responsive styles, light + dark
static/js/app.js        core: API client, router, dashboard, expenses
static/js/views.js      categories, history, reports, users, settings
static/js/charts.js     canvas charts (no libraries)
static/js/login.js      sign-in page
deploy/                 systemd, nginx and MongoDB setup files
backups/                scheduled JSON backups are written here
```
