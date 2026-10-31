# Firm Expense Manager

Web app for a firm with several projects (the restaurant is one) where partners record expenses, see who paid what, and settle up against their percentage share.
Flask + MongoDB backend, plain HTML/CSS/JavaScript frontend. Works on phone, tablet and desktop.

## Run

```bash
python3 -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

export MONGODB_USERNAME="your_db_username"            # Atlas login
export MONGODB_PASSWORD="your_db_password"
export EM_FIRM_NAME="Your Firm Name"                  # shown in the app (optional)
python app.py
```

Open http://localhost:5000 — sign in as `admin` / `Admin@12345` and set a new password.

**First run:** the database is empty, so the app creates the "Restaurant" project with partners Advith 60% / Vibhav 40% and imports the 141 rows from the partners' Google Sheet (`seed_data.py`). Categories follow the agreed 14-group list in `seed_data.py` and were assigned from the descriptions — change any under Expenses → open → Edit. On an existing database the app adds the new list on startup, re-files untouched ledger rows, and archives old default categories that are no longer used (manually edited expenses and your own categories are left alone).

## How it works

- **Firm → Projects → Expenses.** Each project has its own partners, percentages, categories and expense-field settings. Switch projects from the left menu.
- **Who paid.** Every expense records how much each partner paid. Enter one partner's amount and the rest fills in automatically; the split must equal the total.
- **Partner contributions widget.** For each partner: share %, should bear, actually paid, net, and a tag — *Paid more ₹X (+y%)* or *Deficit ₹X (−y%)* — plus "A needs to pay B ₹X". Percentages are applied to current totals, so changing them recalculates everything.
- **Partner view.** The dashboard and reports can be switched to one partner's payments only.
- **Categories.** Pick a category, subcategories load for it. "+ New" on the expense form adds a category or subcategory on the spot.
- **Expense fields.** Projects & partners → Expense fields: choose which optional fields to record (vendor, payment method, notes…), make them required, or add your own fields (text, number, date, dropdown).
- **Reports.** Full report, category-wise, partner-wise (one column per partner) and expense list — each as CSV (Excel) and PDF, for any period or partner.
- **Custom reports.** Reports → Custom reports: choose what each row is (expense, category, subcategory, partner, month, vendor), tick and order the columns (including per-partner paid / should bear / difference / running balance), group with subtotals, add your own calculated columns (e.g. `Total * 0.18`), filter, then generate, save by name, and download as CSV or PDF.
- **Roles.** One `admin` (full control, the only one who can delete expenses and change partners), `editor` (partners: add/edit expenses, categories, downloads), `viewer` (read-only).
- **Audit.** History & audit shows every change, edited expenses with before/after values and reason, deleted expenses with reason, and every sign-in, failed sign-in and sign-out with IP.
- **Backups.** After every change the app rewrites three identical JSON copies — `backups/copy_1`, `copy_2`, `copy_3` — and the day's file in `backups/history/` (kept 30 days). Files are replaced atomically (written to a temp file, then renamed), never edited in place. If a copy is deleted, it is re-created on the next change. Settings shows whether all copies match. Download / restore under Settings.

## Deploy (Render)

Build: `pip install -r requirements.txt` · Start: `gunicorn -w 2 -b 0.0.0.0:$PORT --timeout 120 app:app`
Environment: `MONGODB_USERNAME`, `MONGODB_PASSWORD`, `EM_SECRET_KEY` (long random text), `EM_SECURE_COOKIES=1`, `EM_FIRM_NAME`.
Allow `0.0.0.0/0` in Atlas → Network Access. Note the `backups/` folder is wiped on each redeploy on free tiers — download a backup regularly.
Set `EM_DEBUG=1` temporarily to see the real error text in API responses when something returns "Something went wrong".

## Files

```
app.py              backend (auth, projects, partners, expenses, reports, audit, backups)
seed_data.py        the imported ledger + default categories
templates/          login.html, index.html, error.html
static/css          style.css
static/js           app.js (core, dashboard, expenses) · views.js (other pages) · charts.js · login.js
deploy/             systemd, nginx, MongoDB setup
```
