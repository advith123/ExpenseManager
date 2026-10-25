/* Restaurant Expense Manager — categories, history, reports, users, settings */
(function (EM) {
  "use strict";
  var $ = EM.$, esc = EM.esc, api = EM.api, fail = EM.fail, toast = EM.toast, can = EM.can, fmtINR = EM.fmtINR, fmtDate = EM.fmtDate, fmtDateTime = EM.fmtDateTime;
  var openModal = EM.openModal, closeModal = EM.closeModal, navigate = EM.navigate, qs = EM.qs, render = EM.render, state = EM.state, META = EM.META;

  // =================================================================== CATEGORIES
  EM.views.categories = function (main, route) {
    EM.setTitle("Categories");
    var showArchived = route.params.archived === "1";
    return EM.loadCategories(showArchived).then(function (d) {
      if (showArchived) state.categories = { flat: d.flat.filter(function (c) { return c.status === "active"; }), tree: [] };
      var manage = can("category:manage");
      function node(c) {
        var usage = c.usage.count ? c.usage.count + ' expense' + (c.usage.count === 1 ? "" : "s") + ' · ' + fmtINR(c.usage.total, 0) : "unused";
        var acts = "";
        if (manage) {
          acts = c.status === "active"
            ? '<button class="link-btn" data-add="' + esc(c.id) + '">+ Sub</button><button class="link-btn" data-edit="' + esc(c.id) + '">Rename</button><button class="link-btn danger" data-archive="' + esc(c.id) + '">Archive</button>'
            : '<button class="link-btn" data-unarchive="' + esc(c.id) + '">Restore</button>';
        }
        return '<li><div class="cat-row' + (c.status === "archived" ? " archived" : "") + '"><span class="name">' + esc(c.name) + (c.description ? ' <span class="muted small">— ' + esc(c.description) + '</span>' : "") + '</span>' +
          '<button class="link-btn usage" data-view="' + esc(c.id) + '" data-level="' + c.level + '" title="View expenses">' + usage + '</button><span class="cat-actions">' + acts + '</span></div>' +
          (c.children.length ? '<ul>' + c.children.map(node).join("") + '</ul>' : "") + '</li>';
      }
      main.innerHTML = '<div class="panel"><div class="panel-head"><h2>Category tree</h2><div class="btn-row">' +
        '<label class="small"><input type="checkbox" id="cat-archived"' + (showArchived ? " checked" : "") + '> Show archived</label>' +
        (manage ? '<button class="btn btn-primary btn-sm" id="cat-new">+ New category</button>' : "") + '</div></div>' +
        '<p class="muted small">Categories can be nested as deep as you need. Archived categories keep their history but cannot be used for new expenses.</p>' +
        '<ul class="cat-tree" id="cat-tree">' + d.tree.map(node).join("") + '</ul></div>';
      $("#cat-archived").addEventListener("change", function () { navigate("categories", this.checked ? { archived: "1" } : {}); });
      if ($("#cat-new")) $("#cat-new").addEventListener("click", function () { categoryForm(null, null); });
      $("#cat-tree").addEventListener("click", function (e) {
        var t = e.target.closest("button"); if (!t) return;
        var id;
        if ((id = t.getAttribute("data-view"))) {
          var c = d.flat.filter(function (x) { return x.id === id; })[0];
          navigate("expenses", c.level === 0 ? { category_id: id } : { category_id: c.path_ids[0], subcategory_id: id });
        } else if ((id = t.getAttribute("data-add"))) categoryForm(null, id);
        else if ((id = t.getAttribute("data-edit"))) categoryForm(d.flat.filter(function (x) { return x.id === id; })[0], null);
        else if ((id = t.getAttribute("data-archive"))) archiveCategory(d.flat.filter(function (x) { return x.id === id; })[0]);
        else if ((id = t.getAttribute("data-unarchive"))) api("POST", "/api/categories/" + id + "/unarchive").then(function () { toast("Category restored.", "ok"); render(); }).catch(fail);
      });
    });
  };

  function categoryForm(existing, parentId) {
    var parent = parentId ? state.categories.flat.filter(function (x) { return x.id === parentId; })[0] : null;
    var body = openModal(existing ? "Rename category" : (parent ? "New subcategory under " + parent.name : "New category"),
      '<form id="cat-form" novalidate>' +
      (!existing ? '<div class="field"><label for="c-parent">Parent</label><select id="c-parent"><option value="">— Top level —</option>' + EM.categoryOptions(parentId).replace('<option value="">Choose…</option>', "") + '</select></div>' : "") +
      '<div class="field"><label class="required" for="c-name">Name</label><input id="c-name" maxlength="80" value="' + esc(existing ? existing.name : "") + '"></div>' +
      '<div class="field"><label for="c-desc">Description</label><input id="c-desc" maxlength="300" value="' + esc(existing ? existing.description : "") + '"></div>' +
      '<p class="form-error" id="c-error" hidden></p><div class="btn-row end"><button type="button" class="btn" id="c-cancel">Cancel</button><button type="submit" class="btn btn-primary">' + (existing ? "Save" : "Create") + '</button></div></form>');
    $("#c-cancel", body).addEventListener("click", closeModal);
    $("#cat-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = { name: $("#c-name", body).value.trim(), description: $("#c-desc", body).value.trim() };
      if (!existing) payload.parent_id = $("#c-parent", body).value || null;
      var req = existing ? api("PUT", "/api/categories/" + existing.id, payload) : api("POST", "/api/categories", payload);
      req.then(function () { closeModal(); toast(existing ? "Category renamed." : "Category created.", "ok"); render(); })
        .catch(function (err) { $("#c-error", body).textContent = err.message; $("#c-error", body).hidden = false; });
    });
  }

  function archiveCategory(cat) {
    var body = openModal("Archive " + cat.name,
      '<p>Archiving hides this category (and any subcategories) from new expenses. Existing records keep their history.</p>' +
      '<div class="field"><label for="a-target">If expenses still use it, move them to</label><select id="a-target"><option value="">— Do not move —</option>' + EM.categoryOptions("").replace('<option value="">Choose…</option>', "") + '</select>' +
      '<span class="hint">Each moved expense gets a revision entry explaining the change.</span></div>' +
      '<p class="form-error" id="a-error" hidden></p><div class="btn-row end"><button class="btn" id="a-cancel">Cancel</button><button class="btn btn-danger" id="a-ok">Archive</button></div>');
    $("#a-cancel", body).addEventListener("click", closeModal);
    $("#a-ok", body).addEventListener("click", function () {
      api("POST", "/api/categories/" + cat.id + "/archive", { reassign_to: $("#a-target", body).value || null })
        .then(function (d) { closeModal(); toast("Category archived." + (d.reassigned ? " " + d.reassigned + " expense(s) moved." : ""), "ok"); render(); })
        .catch(function (err) { $("#a-error", body).textContent = err.message; $("#a-error", body).hidden = false; });
    });
  }

  // =================================================================== HISTORY & AUDIT
  EM.views.history = function (main, route) {
    EM.setTitle("History & audit");
    if (!can("audit:view")) { main.innerHTML = '<div class="panel"><p>You do not have access to audit history.</p></div>'; return; }
    var p = route.params;
    var tab = p.tab || "audit";
    main.innerHTML = '<div class="btn-row" id="hist-tabs" style="margin-bottom:14px"><button class="btn btn-sm' + (tab === "audit" ? " btn-primary" : "") + '" data-tab="audit">Audit log</button>' +
      (can("expense:view_deleted") ? '<button class="btn btn-sm' + (tab === "deleted" ? " btn-primary" : "") + '" data-tab="deleted">Deleted expenses</button>' : "") +
      '<button class="btn btn-sm' + (tab === "edited" ? " btn-primary" : "") + '" data-tab="edited">Edited expenses</button></div><div id="hist-body"></div>';
    $("#hist-tabs").addEventListener("click", function (e) { var t = e.target.closest("[data-tab]"); if (t) navigate("history", { tab: t.getAttribute("data-tab") }); });
    var box = $("#hist-body");
    if (tab !== "audit") {
      box.innerHTML = '<div class="panel"><div class="result-bar"><span id="result-count"></span><span id="result-total" class="amount"></span></div><div class="table-wrap" id="exp-table"></div><div class="pager" id="pager"></div></div>';
      var q = { status: tab, page: p.page, per_page: p.per_page, sort: "updated_at", order: "desc" };
      return api("GET", "/api/expenses" + qs(q)).then(function (d) {
        $("#result-count").textContent = d.total_count + " record" + (d.total_count === 1 ? "" : "s");
        $("#result-total").textContent = "Total " + fmtINR(d.total_amount);
        $("#exp-table").innerHTML = d.items.length ? '<table class="data cards"><thead><tr><th>ID</th><th>Date</th><th>Description</th><th>' + (tab === "deleted" ? "Deleted by" : "Last edited") + '</th><th>Reason</th><th class="amount">Amount</th></tr></thead><tbody>' +
          d.items.map(function (e) {
            return '<tr class="row-link" data-open="' + esc(e.id) + '"><td data-label="ID">' + esc(e.expense_id) + '</td><td data-label="Date">' + fmtDate(e.transaction_date) + '</td><td data-label="Description">' + esc(e.description) + '</td>' +
              '<td data-label="' + (tab === "deleted" ? "Deleted by" : "Last edited") + '">' + esc(tab === "deleted" ? e.deleted_by_name + " · " + fmtDateTime(e.deleted_at) : (e.modified_by_name || "") + " · " + fmtDateTime(e.updated_at)) + '</td>' +
              '<td data-label="Reason">' + esc(tab === "deleted" ? e.deletion_reason : "rev " + e.revision) + '</td><td class="amount" data-label="Amount">' + fmtINR(e.amount) + '</td></tr>';
          }).join("") + '</tbody></table>' : '<div class="empty">Nothing here.</div>';
        $("#exp-table").addEventListener("click", function (e) { var r = e.target.closest("[data-open]"); if (r) EM.openExpenseDetail(r.getAttribute("data-open")); });
        $("#pager").innerHTML = '<button class="btn btn-sm" id="pg-prev"' + (d.page <= 1 ? " disabled" : "") + '>‹ Prev</button><span class="small">Page ' + d.page + ' of ' + d.pages + '</span><button class="btn btn-sm" id="pg-next"' + (d.page >= d.pages ? " disabled" : "") + '>Next ›</button>';
        $("#pg-prev").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page - 1 })); });
        $("#pg-next").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page + 1 })); });
      });
    }
    box.innerHTML = '<div class="panel"><div class="filters">' +
      '<div class="f"><label for="h-action">Action</label><select id="h-action"><option value="">Any</option></select></div>' +
      '<div class="f"><label for="h-entity">Entity ID</label><input id="h-entity" placeholder="EXP-2026-00012" value="' + esc(p.entity_id || "") + '"></div>' +
      '<div class="f"><label for="h-from">From</label><input id="h-from" type="date" value="' + esc(p.date_from || "") + '"></div>' +
      '<div class="f"><label for="h-to">To</label><input id="h-to" type="date" value="' + esc(p.date_to || "") + '"></div></div>' +
      '<div class="filters-foot"><button class="btn btn-primary btn-sm" id="h-apply">Apply</button><button class="btn btn-sm" id="h-clear">Clear</button><span class="spacer"></span>' +
      (can("export") ? '<a class="btn btn-sm" href="/api/export/audit.csv">Export audit CSV</a>' : "") + '</div></div>' +
      '<div class="panel"><div class="table-wrap" id="audit-table"></div><div class="pager" id="pager"></div></div>';
    $("#h-apply").addEventListener("click", function () { navigate("history", { tab: "audit", action: $("#h-action").value, entity_id: $("#h-entity").value.trim(), date_from: $("#h-from").value, date_to: $("#h-to").value }); });
    $("#h-clear").addEventListener("click", function () { navigate("history", { tab: "audit" }); });
    return api("GET", "/api/audit" + qs({ action: p.action, entity_id: p.entity_id, date_from: p.date_from, date_to: p.date_to, page: p.page })).then(function (d) {
      $("#h-action").innerHTML = '<option value="">Any</option>' + d.actions.map(function (a) { return '<option value="' + esc(a) + '"' + (a === p.action ? " selected" : "") + '>' + esc(a.replace(/_/g, " ")) + '</option>'; }).join("");
      $("#audit-table").innerHTML = d.items.length ? '<table class="data cards"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>' +
        d.items.map(function (a) {
          var det = a.details || {};
          var text = det.reason ? "Reason: " + det.reason : (det.changes ? Object.keys(det.changes).filter(function (k) { return k !== "category_path"; }).map(function (k) { return k + ": " + JSON.stringify(det.changes[k].from) + " → " + JSON.stringify(det.changes[k].to); }).join("; ") : Object.keys(det).map(function (k) { return k + ": " + (typeof det[k] === "object" ? JSON.stringify(det[k]) : det[k]); }).join("; "));
          var rec = a.entity_type === "expense" ? '<button class="link-btn" data-open="' + esc(a.entity_id) + '">' + esc(a.entity_id) + '</button>' : esc(a.entity_type + (a.entity_id ? " " + a.entity_id : ""));
          return '<tr><td data-label="When" class="nowrap">' + fmtDateTime(a.at) + '</td><td data-label="User">' + esc(a.user_name) + '</td><td data-label="Action"><span class="tag">' + esc(a.action.replace(/_/g, " ")) + '</span></td><td data-label="Record">' + rec + '</td><td data-label="Details" class="small">' + esc(text.slice(0, 300)) + '</td></tr>';
        }).join("") + '</tbody></table>' : '<div class="empty">No audit entries match.</div>';
      $("#audit-table").addEventListener("click", function (e) { var r = e.target.closest("[data-open]"); if (r) EM.openExpenseDetail(r.getAttribute("data-open")); });
      $("#pager").innerHTML = '<button class="btn btn-sm" id="pg-prev"' + (d.page <= 1 ? " disabled" : "") + '>‹ Prev</button><span class="small">Page ' + d.page + ' of ' + d.pages + ' · ' + d.total + ' entries</span><button class="btn btn-sm" id="pg-next"' + (d.page >= d.pages ? " disabled" : "") + '>Next ›</button>';
      $("#pg-prev").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page - 1 })); });
      $("#pg-next").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page + 1 })); });
    });
  };

  // =================================================================== REPORTS
  EM.views.reports = function (main, route) {
    EM.setTitle("Reports & export");
    var p = route.params;
    var period = p.period || "this_month";
    main.innerHTML = '<div class="dash-toolbar no-print"><label class="small muted" for="r-period">Period</label><select id="r-period">' + EM.PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select>' +
      '<span id="r-custom"' + (period === "custom" ? "" : " hidden") + '><input type="date" id="r-from" value="' + esc(p.date_from || "") + '"> <input type="date" id="r-to" value="' + esc(p.date_to || "") + '"> <button class="btn btn-sm" id="r-apply">Apply</button></span>' +
      '<span style="flex:1"></span><button class="btn btn-sm" id="r-print">Print report</button></div>' +
      '<div class="panel no-print"><h2>Export data</h2><p class="muted small">Exports respect the period selected above. Audit history is included in JSON when you tick the box.</p>' +
      '<div class="btn-row"><button class="btn" id="r-csv">Expenses CSV</button><button class="btn" id="r-json">Expenses JSON</button><label class="small"><input type="checkbox" id="r-hist"' + (can("audit:view") ? "" : " disabled") + '> include revision history</label>' +
      (can("export") && can("expense:view_deleted") ? '<button class="btn" id="r-csv-all">CSV including deleted</button>' : "") + '</div></div>' +
      '<div id="report"><div class="empty">Loading…</div></div>';
    function params() { var sel = $("#r-period").value; return sel === "custom" ? { period: "custom", date_from: $("#r-from").value, date_to: $("#r-to").value } : { period: sel }; }
    $("#r-period").addEventListener("change", function () { $("#r-custom").hidden = this.value !== "custom"; if (this.value !== "custom") navigate("reports", params()); });
    $("#r-apply").addEventListener("click", function () { navigate("reports", params()); });
    $("#r-print").addEventListener("click", function () { window.print(); });
    var query = { period: period === "custom" ? "" : period, date_from: period === "custom" ? p.date_from : "", date_to: period === "custom" ? p.date_to : "", granularity: "month" };
    return api("GET", "/api/dashboard/summary" + qs(query)).then(function (d) {
      var exp = { status: "active", date_from: d.period.date_from ? d.period.date_from.slice(0, 10) : "", date_to: d.period.date_to ? d.period.date_to.slice(0, 10) : "" };
      $("#r-csv").addEventListener("click", function () { location.href = "/api/export/csv" + qs(exp); });
      $("#r-json").addEventListener("click", function () { location.href = "/api/export/json" + qs(Object.assign({ include_history: $("#r-hist").checked ? "1" : "" }, exp)); });
      if ($("#r-csv-all")) $("#r-csv-all").addEventListener("click", function () { location.href = "/api/export/csv" + qs(Object.assign({}, exp, { status: "all" })); });
      function table(head, rows) { return '<div class="table-wrap"><table class="data"><thead><tr>' + head.map(function (h, i) { return '<th' + (i ? ' class="amount"' : "") + '>' + h + '</th>'; }).join("") + '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="amount"' : "") + '>' + c + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table></div>'; }
      var total = d.totals.total || 1;
      $("#report").innerHTML = '<div class="panel"><h2>Expense report — ' + esc(d.period.label) + '</h2><p class="muted small">Generated ' + fmtDateTime(new Date().toISOString()) + ' by ' + esc(EM.USER.full_name) + '</p>' +
        '<dl class="detail-grid"><div><dt>Total expenses</dt><dd class="amount">' + fmtINR(d.totals.total) + '</dd></div><div><dt>Transactions</dt><dd>' + d.totals.count + '</dd></div><div><dt>Average</dt><dd class="amount">' + fmtINR(d.totals.average) + '</dd></div><div><dt>Largest</dt><dd class="amount">' + fmtINR(d.totals.max) + '</dd></div></dl></div>' +
        '<div class="panel"><h3>By category</h3>' + table(["Category", "Transactions", "Amount", "Share"], d.by_category.map(function (c) { return [esc(c.name), c.count, fmtINR(c.total), (c.total / total * 100).toFixed(1) + "%"]; })) + '</div>' +
        '<div class="panel"><h3>By subcategory (top 15)</h3>' + table(["Subcategory", "Transactions", "Amount"], d.by_subcategory.map(function (c) { return [esc(c.name), c.count, fmtINR(c.total)]; })) + '</div>' +
        '<div class="panel"><h3>By month</h3>' + table(["Month", "Transactions", "Amount"], d.trend.points.map(function (c) { return [esc(c.label), c.count, fmtINR(c.total)]; })) + '</div>' +
        '<div class="panel"><h3>By payment method</h3>' + table(["Method", "Transactions", "Amount"], d.by_payment_method.map(function (c) { return [esc(c.name), c.count, fmtINR(c.total)]; })) + '</div>' +
        '<div class="panel"><h3>Top vendors</h3>' + table(["Vendor", "Transactions", "Amount"], d.top_vendors.map(function (c) { return [esc(c.vendor), c.count, fmtINR(c.total)]; })) + '</div>';
    });
  };

  // =================================================================== USERS
  EM.views.users = function (main) {
    EM.setTitle("Users");
    if (!can("user:manage")) { main.innerHTML = '<div class="panel"><p>Only administrators can manage users.</p></div>'; return; }
    return api("GET", "/api/users").then(function (d) {
      main.innerHTML = '<div class="panel"><div class="panel-head"><h2>User accounts</h2><button class="btn btn-primary btn-sm" id="u-new">+ New user</button></div>' +
        '<p class="muted small">Roles: <strong>admin</strong> full control · <strong>manager</strong> add, edit, delete, restore, categories, backups · <strong>accountant</strong> add, edit, view deleted, export, backups · <strong>viewer</strong> read-only with export.</p>' +
        '<div class="table-wrap" id="users-table"><table class="data cards"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
        d.users.map(function (u) {
          return '<tr><td data-label="User"><strong>' + esc(u.full_name) + '</strong><br><span class="muted small">' + esc(u.username) + '</span></td><td data-label="Role">' + esc(u.role) + '</td>' +
            '<td data-label="Status">' + (u.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Disabled</span>') + (u.must_change_password ? ' <span class="tag warn">Must change password</span>' : "") + '</td>' +
            '<td data-label="Last sign-in">' + fmtDateTime(u.last_login_at) + '</td><td class="no-label"><button class="link-btn" data-edit="' + esc(u.id) + '">Edit</button></td></tr>';
        }).join("") + '</tbody></table></div></div>';
      $("#u-new").addEventListener("click", function () { userForm(null); });
      $("#users-table").addEventListener("click", function (e) { var t = e.target.closest("[data-edit]"); if (t) userForm(d.users.filter(function (u) { return u.id === t.getAttribute("data-edit"); })[0]); });
    });
  };

  function userForm(u) {
    var isSelf = u && u.id === EM.USER.id;
    var body = openModal(u ? "Edit " + u.username : "New user",
      '<form id="u-form" novalidate>' +
      (!u ? '<div class="field"><label class="required" for="u-username">Username</label><input id="u-username" maxlength="64" autocapitalize="none" placeholder="e.g. rahul.k"></div>' : "") +
      '<div class="field"><label class="required" for="u-name">Full name</label><input id="u-name" maxlength="120" value="' + esc(u ? u.full_name : "") + '"></div>' +
      '<div class="field"><label for="u-role">Role</label><select id="u-role"' + (isSelf ? " disabled" : "") + '>' + META.roles.map(function (r) { return '<option' + ((u ? u.role : "viewer") === r ? " selected" : "") + '>' + r + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label for="u-pw">' + (u ? "Reset password (leave blank to keep)" : "Temporary password") + '</label><input id="u-pw" type="password" autocomplete="new-password"><span class="hint">The user must change it on first sign-in.</span></div>' +
      (u && !isSelf ? '<div class="field inline"><input type="checkbox" id="u-active"' + (u.active ? " checked" : "") + '><label for="u-active">Account active</label></div>' : "") +
      '<p class="form-error" id="u-error" hidden></p><div class="btn-row end"><button type="button" class="btn" id="u-cancel">Cancel</button><button type="submit" class="btn btn-primary">' + (u ? "Save" : "Create user") + '</button></div></form>');
    $("#u-cancel", body).addEventListener("click", closeModal);
    $("#u-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = { full_name: $("#u-name", body).value.trim() };
      if (!isSelf) payload.role = $("#u-role", body).value;
      var pw = $("#u-pw", body).value;
      var req;
      if (u) {
        if (pw) payload.new_password = pw;
        if (!isSelf) payload.active = $("#u-active", body).checked;
        req = api("PUT", "/api/users/" + u.id, payload);
      } else {
        payload.username = $("#u-username", body).value.trim();
        payload.password = pw;
        req = api("POST", "/api/users", payload);
      }
      req.then(function () { closeModal(); toast(u ? "User updated." : "User created.", "ok"); render(); })
        .catch(function (err) { $("#u-error", body).textContent = err.message; $("#u-error", body).hidden = false; });
    });
  }

  // =================================================================== SETTINGS & BACKUPS
  EM.views.settings = function (main) {
    EM.setTitle("Settings & backups");
    var canBackup = can("backup:create"), canRestore = can("backup:restore");
    main.innerHTML =
      '<div class="panel"><h2>Your account</h2><p>Signed in as <strong>' + esc(EM.USER.full_name) + '</strong> (' + esc(EM.USER.username) + ', ' + esc(EM.USER.role) + ').</p>' +
      '<div class="btn-row"><button class="btn" id="s-pw">Change password</button>' + (can("dashboard:customize") ? '<a class="btn" href="#/dashboard">Customise dashboard</a>' : "") + '</div></div>' +
      (canBackup ? '<div class="panel"><h2>Backups</h2><p class="muted small">A JSON backup is written automatically after every change (expense, category or user) into dated folders — <code>backups/year/month/day/</code> — plus one scheduled copy a day. Each file contains expenses, categories, revision history, audit logs and preferences: everything needed to rebuild the records.</p>' +
        '<div class="btn-row"><a class="btn btn-primary" href="/api/backup">Download full backup (JSON)</a></div>' +
        '<div id="backup-list" style="margin-top:14px"></div></div>' : "") +
      (canRestore ? '<div class="panel"><h2>Restore from backup</h2><p class="muted small">Upload a backup file. It is validated first and you see a preview before anything changes. A safety copy of the current data is saved automatically before restoring.</p>' +
        '<div class="field"><label for="rs-file">Backup file</label><input type="file" id="rs-file" accept="application/json,.json"></div>' +
        '<div class="btn-row"><button class="btn" id="rs-validate">Validate &amp; preview</button></div><div id="rs-preview" style="margin-top:14px"></div></div>' : "") +
      '<div class="panel"><h2>About</h2><p class="small muted">Restaurant Expense Manager · Flask + MongoDB · amounts in ' + esc(META.currency) + '.</p></div>';
    $("#s-pw").addEventListener("click", function () { EM.openChangePassword(false); });
    if (canBackup) {
      api("GET", "/api/backup/logs").then(function (d) {
        var files = d.files.length ? '<h3>Backup files on the server</h3><p class="muted small">' + d.total_files + ' file(s). Every change is kept for ' + d.retention_days + ' days, then one per day. <code>latest.json</code> is always the newest copy.</p><div class="table-wrap"><table class="data cards"><thead><tr><th>File</th><th>Size</th><th>Created</th></tr></thead><tbody>' +
          d.files.map(function (f) { return '<tr><td data-label="File">' + (canRestore ? '<a href="/api/backup/files/' + esc(f.name) + '">' + esc(f.name) + '</a>' : esc(f.name)) + '</td><td data-label="Size">' + (f.size / 1024).toFixed(1) + ' KB</td><td data-label="Created">' + fmtDateTime(f.modified) + '</td></tr>'; }).join("") + '</tbody></table></div>' : '<p class="muted small">No server-side backups yet.</p>';
        var logs = d.logs.length ? '<h3 style="margin-top:14px">Backup activity</h3><ul class="timeline">' + d.logs.slice(0, 10).map(function (l) { return '<li><div><strong>' + esc(l.type.replace(/_/g, " ")) + '</strong>' + (l.user_name ? ' by ' + esc(l.user_name) : "") + (l.reason ? ' — ' + esc(String(l.reason).replace(/_/g, " ")) : "") + (l.file ? ' <span class="muted small">' + esc(l.file) + '</span>' : "") + '</div><div class="when">' + fmtDateTime(l.at) + '</div></li>'; }).join("") + '</ul>' : "";
        $("#backup-list").innerHTML = files + logs;
      }).catch(fail);
    }
    if (canRestore) {
      $("#rs-validate").addEventListener("click", function () {
        var f = $("#rs-file").files[0];
        if (!f) { toast("Choose a backup file first.", "error"); return; }
        var fd = new FormData(); fd.append("file", f);
        api("POST", "/api/backup/validate", fd).then(function (d) {
          var box = $("#rs-preview");
          var rows = Object.keys(d.summary).map(function (k) { return '<tr><td data-label="Collection">' + esc(k) + '</td><td data-label="Records">' + d.summary[k].records + '</td><td data-label="Conflicts">' + d.summary[k].conflicts + '</td></tr>'; }).join("");
          box.innerHTML = (d.valid ? '<div class="notice ok">Backup is valid' + (d.generated_at ? ' (created ' + fmtDateTime(d.generated_at) + ')' : "") + '.</div>' : '<div class="notice danger"><strong>Backup failed validation:</strong><ul>' + d.problems.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul></div>') +
            '<div class="table-wrap"><table class="data cards"><thead><tr><th>Collection</th><th>Records</th><th>Already exist</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
            (d.valid ? '<div class="field" style="margin-top:14px"><label for="rs-mode">Restore mode</label><select id="rs-mode"><option value="merge">Merge — add new records, overwrite records with the same ID</option><option value="replace">Replace — delete current data, then import the backup</option></select></div>' +
              '<div class="field inline"><input type="checkbox" id="rs-confirm"><label for="rs-confirm">I understand this changes financial records and a safety backup will be taken first.</label></div>' +
              '<button class="btn btn-danger" id="rs-go">Restore now</button>' : "");
          if (d.valid) {
            $("#rs-go").addEventListener("click", function () {
              if (!$("#rs-confirm").checked) { toast("Tick the confirmation box first.", "error"); return; }
              var fd2 = new FormData(); fd2.append("file", f); fd2.append("mode", $("#rs-mode").value); fd2.append("confirm", "true");
              $("#rs-go").disabled = true;
              api("POST", "/api/backup/restore", fd2).then(function (r) {
                box.innerHTML = '<div class="notice ok">Restore complete (' + esc(r.mode) + '). Safety copy: ' + esc(r.pre_restore_backup) + '</div><pre class="small">' + esc(JSON.stringify(r.results, null, 2)) + '</pre>';
                state.categories = { flat: [], tree: [] };
              }).catch(function (err) { $("#rs-go").disabled = false; fail(err); });
            });
          }
        }).catch(fail);
      });
    }
  };
})(window.EM);
