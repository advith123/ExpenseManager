/* Expense Manager — categories, reports, history, projects, users, settings */
(function (EM) {
  "use strict";
  var $ = EM.$, $$ = EM.$$, esc = EM.esc, api = EM.api, fail = EM.fail, toast = EM.toast, can = EM.can, fmtINR = EM.fmtINR, fmtDate = EM.fmtDate, fmtDateTime = EM.fmtDateTime;
  var openModal = EM.openModal, closeModal = EM.closeModal, navigate = EM.navigate, qs = EM.qs, render = EM.render, state = EM.state, META = EM.META;

  // =================================================================== CATEGORIES
  EM.views.categories = function (main, route, isCurrent) {
    EM.setTitle("Categories · " + state.project.name);
    var showArchived = route.params.archived === "1";
    return EM.loadCategories(showArchived).then(function (d) {
      if (!isCurrent()) return;
      if (showArchived) state.categories = { flat: d.flat.filter(function (c) { return c.status === "active"; }), tree: [] };
      var manage = can("category:manage");
      var tops = d.tree, subCount = d.flat.filter(function (c) { return c.level > 0; }).length;
      var grand = tops.reduce(function (a, c) { return a + c.usage.total; }, 0);
      var open = {};
      function fmtUse(u) { return u.count ? fmtINR(u.total, 0) + ' <span class="muted">· ' + u.count + '</span>' : '<span class="muted">—</span>'; }
      function rowActions(c) {
        if (!manage) return "";
        return c.status === "active"
          ? '<button class="icon-btn sm" data-edit="' + esc(c.id) + '" title="Rename">✎</button><button class="icon-btn sm" data-archive="' + esc(c.id) + '" title="Archive">⌫</button>'
          : '<button class="link-btn" data-unarchive="' + esc(c.id) + '">Restore</button>';
      }
      function card(c, q) {
        var kids = c.children, match = !q || c.name.toLowerCase().indexOf(q) >= 0;
        var shown = q ? kids.filter(function (k) { return k.name.toLowerCase().indexOf(q) >= 0 || match; }) : kids;
        if (q && !match && !shown.length) return "";
        var isOpen = open[c.id] || !!q;
        var pct = grand ? Math.round(c.usage.total / grand * 100) : 0;
        return '<section class="cat-card' + (c.status === "archived" ? " archived" : "") + '" data-card="' + esc(c.id) + '">' +
          '<header class="cat-card-head" data-toggle="' + esc(c.id) + '"><span class="chev">' + (isOpen ? "▾" : "▸") + '</span>' +
          '<div class="cat-card-title"><strong>' + esc(c.name) + '</strong><span class="muted small">' + kids.length + ' subcategor' + (kids.length === 1 ? "y" : "ies") + (c.status === "archived" ? " · archived" : "") + '</span></div>' +
          '<div class="cat-card-usage amount">' + fmtUse(c.usage) + (c.usage.count ? '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' : "") + '</div>' +
          '<div class="cat-card-actions">' + rowActions(c) + '</div></header>' +
          (isOpen ? '<div class="cat-card-body"><table class="data sub-table"><tbody>' +
            (shown.length ? shown.map(function (k) {
              return '<tr class="' + (k.status === "archived" ? "archived" : "") + '"><td class="sub-name"><button class="link-btn plain" data-view="' + esc(k.id) + '" title="Show expenses">' + esc(k.name) + '</button>' + (k.status === "archived" ? ' <span class="tag">archived</span>' : "") + '</td><td class="amount">' + fmtUse(k.usage) + '</td><td class="sub-actions">' + rowActions(k) + '</td></tr>';
            }).join("") : '<tr><td colspan="3" class="muted small">No subcategories yet.</td></tr>') +
            '</tbody></table>' +
            '<div class="cat-card-foot"><button class="link-btn plain" data-view="' + esc(c.id) + '">View all ' + esc(c.name) + ' expenses →</button>' + (manage && c.status === "active" ? '<button class="btn btn-sm" data-add="' + esc(c.id) + '">+ Add subcategory</button>' : "") + '</div></div>' : "") +
          '</section>';
      }
      main.innerHTML = '<div class="panel"><div class="panel-head"><div><h2>Categories</h2><p class="muted small" style="margin:0">' + tops.filter(function (c) { return c.status === "active"; }).length + ' categories · ' + subCount + ' subcategories · ' + fmtINR(grand, 0) + ' recorded</p></div>' +
        '<div class="btn-row">' + (manage ? '<button class="btn btn-primary btn-sm" id="cat-new">+ New category</button>' : "") + '</div></div>' +
        '<div class="cat-toolbar"><input type="search" id="cat-q" placeholder="Search categories and subcategories…" aria-label="Search"><button class="btn btn-sm" id="cat-expand">Expand all</button><button class="btn btn-sm" id="cat-collapse">Collapse all</button><label class="chk"><input type="checkbox" id="cat-archived"' + (showArchived ? " checked" : "") + '> Show archived</label></div>' +
        '<div class="cat-cards" id="cat-cards"></div></div>';
      var box = $("#cat-cards");
      function draw() { var q = $("#cat-q").value.trim().toLowerCase(); box.innerHTML = tops.map(function (c) { return card(c, q); }).join("") || '<div class="empty">Nothing matches.</div>'; }
      draw();
      $("#cat-q").addEventListener("input", draw);
      $("#cat-expand").addEventListener("click", function () { tops.forEach(function (c) { open[c.id] = true; }); draw(); });
      $("#cat-collapse").addEventListener("click", function () { open = {}; draw(); });
      $("#cat-archived").addEventListener("change", function () { navigate("categories", this.checked ? { archived: "1" } : {}); });
      if ($("#cat-new")) $("#cat-new").addEventListener("click", function () { categoryForm(null, null); });
      box.addEventListener("click", function (e) {
        var t = e.target.closest("button, [data-toggle]"); if (!t) return;
        var id, c;
        if (t.hasAttribute("data-toggle") && !e.target.closest("button")) { id = t.getAttribute("data-toggle"); open[id] = !open[id]; draw(); return; }
        if ((id = t.getAttribute("data-view"))) { c = d.flat.filter(function (x) { return x.id === id; })[0]; navigate("expenses", c.level === 0 ? { category_id: id } : { category_id: c.path_ids[0], subcategory_id: id }); }
        else if ((id = t.getAttribute("data-add"))) categoryForm(null, id);
        else if ((id = t.getAttribute("data-edit"))) categoryForm(d.flat.filter(function (x) { return x.id === id; })[0], null);
        else if ((id = t.getAttribute("data-archive"))) archiveCategory(d.flat.filter(function (x) { return x.id === id; })[0]);
        else if ((id = t.getAttribute("data-unarchive"))) api("POST", "/api/categories/" + id + "/unarchive").then(function () { toast("Restored.", "ok"); render(); }).catch(fail);
      });
    });
  };

  function allCategoryOptions(selected) {
    return state.categories.flat.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === selected ? " selected" : "") + '>' + (c.level ? "\u00a0\u00a0↳ " : "") + esc(c.name) + '</option>'; }).join("");
  }

  function categoryForm(existing, parentId) {
    var body = openModal(existing ? "Rename category" : (parentId ? "New subcategory under " + EM.categoryName(parentId) : "New category"),
      '<form id="cat-form" novalidate>' + (!existing ? '<div class="field"><label for="c-parent">Under</label><select id="c-parent"><option value="">— Top level —</option>' + allCategoryOptions(parentId) + '</select></div>' : "") +
      '<div class="field"><label class="required" for="c-name">Name</label><input id="c-name" maxlength="80" value="' + esc(existing ? existing.name : "") + '"></div>' +
      '<p class="form-error" id="c-error" hidden></p><div class="btn-row end"><button type="button" class="btn" id="c-cancel">Cancel</button><button type="submit" class="btn btn-primary">' + (existing ? "Save" : "Create") + '</button></div></form>');
    $("#c-cancel", body).addEventListener("click", closeModal);
    $("#cat-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = { name: $("#c-name", body).value.trim() };
      if (!existing) payload.parent_id = $("#c-parent", body).value || null;
      (existing ? api("PUT", "/api/categories/" + existing.id, payload) : api("POST", "/api/categories", payload))
        .then(function () { closeModal(); toast("Saved.", "ok"); render(); })
        .catch(function (err) { $("#c-error", body).textContent = err.message; $("#c-error", body).hidden = false; });
    });
  }

  function archiveCategory(cat) {
    var body = openModal("Archive " + cat.name,
      '<p>Archived categories are hidden from new expenses. Existing records keep their history.</p>' +
      '<div class="field"><label for="a-target">If expenses still use it, move them to</label><select id="a-target"><option value="">— Do not move —</option>' + allCategoryOptions("") + '</select></div>' +
      '<p class="form-error" id="a-error" hidden></p><div class="btn-row end"><button class="btn" id="a-cancel">Cancel</button><button class="btn btn-danger" id="a-ok">Archive</button></div>');
    $("#a-cancel", body).addEventListener("click", closeModal);
    $("#a-ok", body).addEventListener("click", function () {
      api("POST", "/api/categories/" + cat.id + "/archive", { reassign_to: $("#a-target", body).value || null })
        .then(function (d) { closeModal(); toast("Archived." + (d.reassigned ? " " + d.reassigned + " expense(s) moved." : ""), "ok"); render(); })
        .catch(function (err) { $("#a-error", body).textContent = err.message; $("#a-error", body).hidden = false; });
    });
  }

  // =================================================================== REPORTS
  EM.views.reports = function (main, route, isCurrent) {
    EM.setTitle("Reports · " + state.project.name);
    var p = route.params, period = p.period || "all_time", partnerId = p.partner_id || "";
    var partners = state.project.partners.filter(function (x) { return x.active !== false; });
    main.innerHTML = '<div class="dash-toolbar no-print"><select id="r-period">' + EM.PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select>' +
      '<span id="r-custom"' + (period === "custom" ? "" : " hidden") + '><input type="date" id="r-from" value="' + esc(p.date_from || "") + '"> <input type="date" id="r-to" value="' + esc(p.date_to || "") + '"> <button class="btn btn-sm" id="r-apply">Apply</button></span>' +
      '<select id="r-partner"><option value="">All partners</option>' + partners.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === partnerId ? " selected" : "") + '>' + esc(x.name) + "'s payments only</option>"; }).join("") + '</select>' +
      '<span style="flex:1"></span><a class="btn btn-primary btn-sm" href="#/custom">Custom reports</a><button class="btn btn-sm" id="r-print">Print this page</button></div>' +
      '<div class="panel no-print"><h2>Download reports</h2><div class="report-grid" id="r-cards"></div></div><div id="report"><div class="empty">Loading…</div></div>';
    function params() { var sel = $("#r-period").value, o = { period: sel, partner_id: $("#r-partner").value }; if (sel === "custom") { o.date_from = $("#r-from").value; o.date_to = $("#r-to").value; } return o; }
    $("#r-period").addEventListener("change", function () { $("#r-custom").hidden = this.value !== "custom"; if (this.value !== "custom") navigate("reports", params()); });
    $("#r-apply").addEventListener("click", function () { navigate("reports", params()); });
    $("#r-partner").addEventListener("change", function () { navigate("reports", params()); });
    $("#r-print").addEventListener("click", function () { window.print(); });
    var q = { period: period === "custom" ? "" : period, date_from: period === "custom" ? p.date_from : "", date_to: period === "custom" ? p.date_to : "", partner_id: partnerId };
    var cards = [["full", "Full report", "Summary, partner contributions, category and subcategory totals, and every expense."],
      ["category", "Category-wise report", "Totals and share of spend per category and subcategory."],
      ["partner", "Partner-wise report", "Every expense with a column per partner, category-wise totals, each partner's share vs paid, and who owes whom."],
      ["expenses", "Expense list", "Every expense with who paid, as a flat table."]];
    $("#r-cards").innerHTML = cards.map(function (c) { return '<div class="report-card"><h3>' + c[1] + '</h3><p>' + c[2] + '</p><div class="btn-row"><a class="btn btn-sm" href="' + EM.fileUrl("/api/reports/" + c[0] + ".csv", q) + '">CSV (Excel)</a><a class="btn btn-sm" href="' + EM.fileUrl("/api/reports/" + c[0] + ".pdf", q) + '">PDF</a></div></div>'; }).join("");
    return Promise.all([api("GET", "/api/dashboard/summary" + qs(Object.assign({ granularity: "month" }, q))), api("GET", "/api/reports/partner-table" + qs(q))]).then(function (res) {
      if (!isCurrent()) return;
      var d = res[0], pt = res[1];
      function table(head, rows) { return '<div class="table-wrap"><table class="data"><thead><tr>' + head.map(function (h, i) { return '<th' + (i ? ' class="amount"' : "") + '>' + h + '</th>'; }).join("") + '</tr></thead><tbody>' + (rows.length ? rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (i ? ' class="amount"' : "") + '>' + c + '</td>'; }).join("") + '</tr>'; }).join("") : '<tr><td colspan="' + head.length + '" class="muted">Nothing in this period</td></tr>') + '</tbody></table></div>'; }
      var total = d.totals.total || 1, ps = d.partner_summary;
      $("#report").innerHTML = '<div class="panel"><h2>' + esc(state.project.name) + ' — ' + esc(d.period.label) + (d.partner_filter ? ' — ' + esc(d.partner_filter.name) + "'s payments" : "") + '</h2>' +
        '<dl class="detail-grid"><div><dt>Total</dt><dd class="amount">' + fmtINR(d.totals.total) + '</dd></div><div><dt>Expenses</dt><dd>' + d.totals.count + '</dd></div><div><dt>Average</dt><dd class="amount">' + fmtINR(d.totals.average) + '</dd></div><div><dt>Largest</dt><dd class="amount">' + fmtINR(d.totals.max) + '</dd></div></dl></div>' +
        '<div class="panel"><h3>Partners</h3>' + table(["Partner", "Share", "Should bear", "Paid", "Net", "Status"], ps.partners.map(function (r) { return [esc(r.name), r.share + "%", fmtINR(r.should_bear), fmtINR(r.paid) + " (" + r.paid_pct.toFixed(1) + "%)", (r.net > 0 ? "+" : "") + fmtINR(r.net), r.status === "paid_more" ? "Paid more" : r.status === "deficit" ? "Deficit" : "Balanced"]; })) +
        (ps.settlements.length ? '<div class="settle">' + ps.settlements.map(function (s) { return esc(s.from) + " needs to pay " + esc(s.to) + " " + fmtINR(s.amount); }).join("<br>") + '</div>' : "") + '</div>' +
        '<div class="panel"><h3>Payments by partner</h3><p class="muted small">One row per expense, one column per partner.' + (pt.truncated ? " Showing the last 400 of " + pt.total_rows + " — download the CSV or PDF for the full list." : "") + '</p>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' + pt.head.map(function (h, i) { return '<th' + (i >= 3 ? ' class="amount"' : "") + '>' + esc(h) + '</th>'; }).join("") + '</tr></thead><tbody>' +
        pt.rows.map(function (r) { var tot = r[0] === "TOTAL"; return '<tr' + (tot ? ' style="font-weight:600;background:var(--brand-soft)"' : "") + '>' + r.map(function (c, i) { return '<td' + (i >= 3 ? ' class="amount"' : "") + '>' + (i >= 3 ? (c ? fmtINR(c, 0) : "") : esc(c)) + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table></div></div>' +
        '<div class="panel"><h3>Category-wise, by partner</h3><div class="table-wrap"><table class="data"><thead><tr><th>Category</th>' + pt.head.slice(4).map(function (h) { return '<th class="amount">' + esc(h) + '</th>'; }).join("") + '<th class="amount">Total</th></tr></thead><tbody>' +
        pt.by_category.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td>' + r.slice(1).map(function (c) { return '<td class="amount">' + (c ? fmtINR(c, 0) : "") + '</td>'; }).join("") + '</tr>'; }).join("") + '</tbody></table></div></div>' +
        '<div class="panel"><h3>By category</h3>' + table(["Category", "Expenses", "Amount", "Share"], d.by_category.map(function (c) { return [esc(c.name), c.count, fmtINR(c.total), (c.total / total * 100).toFixed(1) + "%"]; })) + '</div>' +
        '<div class="panel"><h3>By subcategory</h3>' + table(["Subcategory", "Expenses", "Amount"], d.by_subcategory.map(function (c) { return [esc(c.name), c.count, fmtINR(c.total)]; })) + '</div>' +
        '<div class="panel"><h3>By month</h3>' + table(["Month", "Expenses", "Amount"], d.trend.points.map(function (c) { return [esc(c.label), c.count, fmtINR(c.total)]; })) + '</div>';
    });
  };

  // =================================================================== CUSTOM REPORT BUILDER
  EM.views.custom = function (main, route, isCurrent) {
    EM.setTitle("Custom reports · " + state.project.name);
    var partners = state.project.partners.filter(function (x) { return x.active !== false; });
    var spec = { rows: "expense", columns: ["date", "expense", "category", "total"].concat(partners.map(function (p) { return "paid:" + p.id; })), group_by: "", formulas: [], filters: { period: "all_time" } };
    var currentId = null, currentName = "";
    return Promise.all([api("GET", "/api/reports/custom/options"), api("GET", "/api/reports/custom")]).then(function (res) {
      if (!isCurrent()) return;
      var opt = res[0], saved = res[1].reports;
      var canEdit = can("expense:edit");
      main.innerHTML =
        '<div class="panel"><div class="panel-head"><h2>Saved reports</h2><a class="btn btn-sm" href="#/reports">← Back to reports</a></div><div id="saved-list" class="btn-row"></div></div>' +
        '<div class="panel"><h2 id="builder-title">Build a report</h2>' +
        '<div class="form-grid">' +
        '<div class="field"><label for="cr-rows">Each row is one…</label><select id="cr-rows">' + [["expense", "Expense"], ["category", "Category (totals)"], ["subcategory", "Subcategory (totals)"], ["partner", "Partner (totals)"], ["month", "Month (totals)"], ["vendor", "Vendor (totals)"]].map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join("") + '</select></div>' +
        '<div class="field" id="cr-group-wrap"><label for="cr-group">Group rows by (with subtotals)</label><select id="cr-group"><option value="">No grouping</option><option value="category">Category</option><option value="subcategory">Subcategory</option><option value="month">Month</option><option value="partner">Who paid</option><option value="vendor">Vendor</option></select></div>' +
        '</div>' +
        '<div class="field" id="cr-cols-wrap"><label>Columns (tick to include; use ↑↓ to order)</label><ul class="widget-pick" id="cr-cols"></ul></div>' +
        '<div class="field"><label>Your own calculated columns</label><p class="muted small" style="margin:0 0 6px">Use + − * / and brackets with these names: <code id="cr-vars"></code>. Example: <code>Total * 0.18</code> or <code>' + esc(opt.formula_variables[3] || "Total") + ' - ' + esc(opt.formula_variables[4] || "Count") + '</code></p><div id="cr-formulas"></div><button type="button" class="btn btn-sm" id="cr-formula-add">+ Add calculated column</button></div>' +
        '<h3 style="margin-top:14px">Filters</h3><div class="filters">' +
        '<div class="f"><label for="cr-period">Period</label><select id="cr-period">' + EM.PERIODS.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="cr-from">From</label><input type="date" id="cr-from"></div><div class="f"><label for="cr-to">To</label><input type="date" id="cr-to"></div>' +
        '<div class="f"><label for="cr-partner">Paid by</label><select id="cr-partner"><option value="">Anyone</option>' + partners.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="cr-cat">Category</label><select id="cr-cat"><option value="">All</option>' + opt.categories.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="cr-min">Min amount</label><input type="number" id="cr-min" min="0"></div><div class="f"><label for="cr-max">Max amount</label><input type="number" id="cr-max" min="0"></div>' +
        '<div class="f"><label for="cr-q">Search text</label><input id="cr-q" placeholder="e.g. welder"></div></div>' +
        '<div class="btn-row" style="margin-top:16px"><button class="btn btn-primary" id="cr-run">Generate report</button>' + (canEdit ? '<button class="btn" id="cr-save">Save report…</button>' : "") + '<button class="btn" id="cr-reset">Start over</button><span class="spacer" style="flex:1"></span><a class="btn btn-sm" id="cr-csv" href="#">CSV</a><a class="btn btn-sm" id="cr-pdf" href="#">PDF</a></div>' +
        '<p class="form-error" id="cr-error" hidden></p></div>' +
        '<div class="panel" id="cr-result"><div class="empty">Choose your columns and click “Generate report”.</div></div>';
      $("#cr-vars").textContent = opt.formula_variables.join(", ");

      // ---- columns list
      var colsBox = $("#cr-cols");
      function drawCols() {
        var ordered = spec.columns.map(function (k) { return opt.columns.filter(function (c) { return c.key === k; })[0]; }).filter(Boolean);
        var rest = opt.columns.filter(function (c) { return spec.columns.indexOf(c.key) < 0; });
        var all = ordered.concat(rest);
        var agg = spec.rows !== "expense" && spec.rows !== "partner";
        colsBox.innerHTML = all.map(function (c) {
          var on = spec.columns.indexOf(c.key) >= 0, dim = agg && c.kind === "text";
          return '<li' + (dim ? ' style="opacity:.45"' : "") + '><span class="muted small">' + (c.kind === "number" ? "#" : "Aa") + '</span><label class="chk"><input type="checkbox" data-col="' + esc(c.key) + '"' + (on ? " checked" : "") + (dim ? " disabled" : "") + '> ' + esc(c.label) + '</label><span></span><span>' + (on ? '<button class="link-btn" data-up="' + esc(c.key) + '">↑</button><button class="link-btn" data-down="' + esc(c.key) + '">↓</button>' : "") + '</span></li>';
        }).join("");
      }
      colsBox.addEventListener("change", function (e) {
        var k = e.target.getAttribute("data-col"); if (!k) return;
        if (e.target.checked) { if (spec.columns.indexOf(k) < 0) spec.columns.push(k); } else spec.columns = spec.columns.filter(function (x) { return x !== k; });
        drawCols();
      });
      colsBox.addEventListener("click", function (e) {
        var up = e.target.closest("[data-up]"), down = e.target.closest("[data-down]");
        var k = up ? up.getAttribute("data-up") : down ? down.getAttribute("data-down") : null; if (!k) return;
        var i = spec.columns.indexOf(k), j = up ? i - 1 : i + 1;
        if (j < 0 || j >= spec.columns.length) return;
        var t = spec.columns[i]; spec.columns[i] = spec.columns[j]; spec.columns[j] = t; drawCols();
      });

      // ---- formulas
      var fBox = $("#cr-formulas");
      function drawFormulas() {
        fBox.innerHTML = spec.formulas.map(function (f, i) { return '<div class="split-row" style="grid-template-columns: minmax(0,1fr) minmax(0,2fr) auto"><input placeholder="Column name" value="' + esc(f.label) + '" data-fl="' + i + '"><input placeholder="Formula, e.g. Total * 0.18" value="' + esc(f.expr) + '" data-fe="' + i + '"><button type="button" class="link-btn danger" data-fx="' + i + '">Remove</button></div>'; }).join("");
      }
      fBox.addEventListener("input", function (e) { var i = e.target.getAttribute("data-fl"), j = e.target.getAttribute("data-fe"); if (i !== null) spec.formulas[+i].label = e.target.value; if (j !== null) spec.formulas[+j].expr = e.target.value; });
      fBox.addEventListener("click", function (e) { var r = e.target.closest("[data-fx]"); if (r) { spec.formulas.splice(+r.getAttribute("data-fx"), 1); drawFormulas(); } });
      $("#cr-formula-add").addEventListener("click", function () { spec.formulas.push({ label: "Column " + (spec.formulas.length + 1), expr: "" }); drawFormulas(); });

      // ---- rows / group / filters
      function applyToForm() {
        $("#cr-rows").value = spec.rows; $("#cr-group").value = spec.group_by || "";
        $("#cr-group-wrap").style.display = spec.rows === "expense" ? "" : "none";
        $("#cr-cols-wrap").style.display = spec.rows === "partner" ? "none" : "";
        var f = spec.filters || {};
        $("#cr-period").value = f.period || "all_time"; $("#cr-from").value = f.date_from || ""; $("#cr-to").value = f.date_to || "";
        $("#cr-partner").value = f.partner_id || ""; $("#cr-cat").value = f.category_id || ""; $("#cr-min").value = f.min_amount || ""; $("#cr-max").value = f.max_amount || ""; $("#cr-q").value = f.q || "";
        drawCols(); drawFormulas();
      }
      function readForm() {
        spec.rows = $("#cr-rows").value; spec.group_by = $("#cr-group").value;
        var period = $("#cr-period").value;
        spec.filters = { period: period === "custom" ? "" : period, date_from: period === "custom" ? $("#cr-from").value : "", date_to: period === "custom" ? $("#cr-to").value : "",
          partner_id: $("#cr-partner").value, category_id: $("#cr-cat").value, min_amount: $("#cr-min").value, max_amount: $("#cr-max").value, q: $("#cr-q").value.trim() };
        spec.formulas = spec.formulas.filter(function (f) { return f.expr.trim(); }).map(function (f) { return { label: f.label.trim() || "Column", expr: f.expr.trim() }; });
        return spec;
      }
      $("#cr-rows").addEventListener("change", function () { spec.rows = this.value; applyToForm(); });
      $("#cr-period").addEventListener("change", function () { var c = this.value === "custom"; $("#cr-from").disabled = !c; $("#cr-to").disabled = !c; });

      function updateLinks() {
        var q = { spec: JSON.stringify(readForm()), name: currentName || "Custom report" };
        $("#cr-csv").href = EM.fileUrl("/api/reports/custom/download.csv", q); $("#cr-pdf").href = EM.fileUrl("/api/reports/custom/download.pdf", q);
      }
      function run() {
        var err = $("#cr-error"); err.hidden = true;
        readForm();
        $("#cr-result").innerHTML = '<div class="empty">Generating…</div>';
        api("POST", "/api/reports/custom/run", spec).then(function (r) {
          updateLinks();
          var numCols = r.head.map(function (_, i) { return r.rows.some(function (row) { return typeof row[i] === "number"; }); });
          $("#cr-result").innerHTML = '<div class="panel-head"><h2>' + esc(currentName || "Report") + ' <span class="muted small">· ' + esc(r.period) + ' · ' + r.count + ' expenses</span></h2></div>' +
            (r.ignored_text_columns && r.ignored_text_columns.length ? '<p class="muted small">Text columns (' + esc(r.ignored_text_columns.join(", ")) + ') are not shown for totals rows.</p>' : "") +
            (r.rows.length <= 1 ? '<div class="empty">No expenses match these filters.</div>' :
            '<div class="table-wrap"><table class="data"><thead><tr>' + r.head.map(function (h, i) { return '<th' + (numCols[i] ? ' class="amount"' : "") + '>' + esc(h) + '</th>'; }).join("") + '</tr></thead><tbody>' +
            r.rows.map(function (row) {
              var first = String(row[0]); var kind = first.indexOf("TOTAL") === 0 || first.indexOf("Subtotal") === 0 ? "total" : first.indexOf("—") === 0 ? "group" : "";
              return '<tr' + (kind === "total" ? ' style="font-weight:600;background:var(--brand-soft)"' : kind === "group" ? ' style="background:var(--surface-2);font-weight:500"' : "") + '>' + row.map(function (c, i) { return '<td' + (numCols[i] ? ' class="amount"' : "") + '>' + (typeof c === "number" ? (r.head[i].indexOf("%") >= 0 || r.head[i] === "Count" ? c : fmtINR(c, 2)) : esc(c)) + '</td>'; }).join("") + '</tr>';
            }).join("") + '</tbody></table></div>');
        }).catch(function (e) { err.textContent = e.message; err.hidden = false; $("#cr-result").innerHTML = ""; });
      }
      $("#cr-run").addEventListener("click", run);
      $("#cr-reset").addEventListener("click", function () { currentId = null; currentName = ""; $("#builder-title").textContent = "Build a report"; spec = { rows: "expense", columns: ["date", "expense", "category", "total"].concat(partners.map(function (p) { return "paid:" + p.id; })), group_by: "", formulas: [], filters: { period: "all_time" } }; applyToForm(); $("#cr-result").innerHTML = '<div class="empty">Choose your columns and click “Generate report”.</div>'; });
      $("#cr-csv").addEventListener("click", updateLinks); $("#cr-pdf").addEventListener("click", updateLinks);
      if ($("#cr-save")) $("#cr-save").addEventListener("click", function () {
        var name = prompt("Name this report", currentName || ""); if (!name) return;
        readForm();
        api("POST", "/api/reports/custom", { name: name.trim(), spec: spec }).then(function (d) { currentId = d.report.id; currentName = d.report.name; $("#builder-title").textContent = "Report: " + currentName; toast("Report saved.", "ok"); return api("GET", "/api/reports/custom"); }).then(function (d) { saved = d.reports; drawSaved(); }).catch(fail);
      });

      // ---- saved list
      function drawSaved() {
        $("#saved-list").innerHTML = saved.length ? saved.map(function (r) { return '<span class="tag" style="padding:6px 10px;font-size:.9rem"><button class="link-btn" data-load="' + esc(r.id) + '" style="padding:0 4px">' + esc(r.name) + '</button> <a class="link-btn" href="' + EM.fileUrl("/api/reports/custom/download.csv", { report_id: r.id }) + '" title="CSV">CSV</a> <a class="link-btn" href="' + EM.fileUrl("/api/reports/custom/download.pdf", { report_id: r.id }) + '" title="PDF">PDF</a>' + (canEdit ? ' <button class="link-btn danger" data-del="' + esc(r.id) + '" title="Delete">×</button>' : "") + '</span>'; }).join("") : '<p class="muted small" style="margin:0">No saved reports yet. Build one below and click “Save report”.</p>';
      }
      $("#saved-list").addEventListener("click", function (e) {
        var l = e.target.closest("[data-load]"), d = e.target.closest("[data-del]");
        if (l) { var r = saved.filter(function (x) { return x.id === l.getAttribute("data-load"); })[0]; if (r) { spec = JSON.parse(JSON.stringify(r.spec)); spec.formulas = spec.formulas || []; spec.columns = spec.columns || []; currentId = r.id; currentName = r.name; $("#builder-title").textContent = "Report: " + r.name; applyToForm(); run(); } }
        if (d) { var rr = saved.filter(function (x) { return x.id === d.getAttribute("data-del"); })[0]; if (rr && confirm("Delete report “" + rr.name + "”?")) api("DELETE", "/api/reports/custom/" + rr.id).then(function () { saved = saved.filter(function (x) { return x.id !== rr.id; }); drawSaved(); toast("Deleted.", "ok"); }).catch(fail); }
      });
      drawSaved(); applyToForm();
      $("#cr-from").disabled = true; $("#cr-to").disabled = true;
      var load = route.params.load && saved.filter(function (x) { return x.id === route.params.load; })[0];
      if (load) { spec = JSON.parse(JSON.stringify(load.spec)); currentId = load.id; currentName = load.name; applyToForm(); run(); }
    });
  };

  // =================================================================== HISTORY & AUDIT
  EM.views.history = function (main, route, isCurrent) {
    EM.setTitle("History & audit");
    var p = route.params, tab = p.tab || "changes";
    var tabs = [["changes", "All changes"], ["edits", "Edited expenses"], ["deleted", "Deleted expenses"], ["logins", "Login access"]];
    main.innerHTML = '<div class="btn-row" id="hist-tabs" style="margin-bottom:14px">' + tabs.map(function (t) { return '<button class="btn btn-sm' + (tab === t[0] ? " btn-primary" : "") + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join("") + '</div>' +
      '<div class="panel"><div class="filters"><div class="f"><label for="h-user">User</label><select id="h-user"><option value="">Anyone</option></select></div><div class="f"><label for="h-entity">Expense ID</label><input id="h-entity" placeholder="EXP-2026-00012" value="' + esc(p.entity_id || "") + '"></div>' +
      '<div class="f"><label for="h-from">From</label><input id="h-from" type="date" value="' + esc(p.date_from || "") + '"></div><div class="f"><label for="h-to">To</label><input id="h-to" type="date" value="' + esc(p.date_to || "") + '"></div></div>' +
      '<div class="filters-foot"><button class="btn btn-primary btn-sm" id="h-apply">Apply</button><button class="btn btn-sm" id="h-clear">Clear</button><span class="spacer"></span>' + (can("export") ? '<a class="btn btn-sm" href="/api/export/audit.csv">Export audit CSV</a>' : "") + '</div></div>' +
      '<div class="panel"><div class="table-wrap" id="audit-table"></div><div class="pager" id="pager"></div></div>';
    $("#hist-tabs").addEventListener("click", function (e) { var t = e.target.closest("[data-tab]"); if (t) navigate("history", { tab: t.getAttribute("data-tab") }); });
    $("#h-apply").addEventListener("click", function () { navigate("history", { tab: tab, user_id: $("#h-user").value, entity_id: $("#h-entity").value.trim(), date_from: $("#h-from").value, date_to: $("#h-to").value }); });
    $("#h-clear").addEventListener("click", function () { navigate("history", { tab: tab }); });
    var usersReq = can("user:manage") ? api("GET", "/api/users").catch(function () { return { users: [] }; }) : Promise.resolve({ users: [] });
    return Promise.all([api("GET", "/api/audit" + qs({ kind: tab, user_id: p.user_id, entity_id: p.entity_id, date_from: p.date_from, date_to: p.date_to, page: p.page })), usersReq]).then(function (res) {
      if (!isCurrent()) return;
      var d = res[0];
      $("#h-user").innerHTML = '<option value="">Anyone</option>' + res[1].users.map(function (u) { return '<option value="' + esc(u.id) + '"' + (u.id === p.user_id ? " selected" : "") + '>' + esc(u.full_name) + '</option>'; }).join("");
      function describe(a) {
        var det = a.details || {};
        if (a.action === "login") return "Signed in" + (det.user_agent ? " · " + det.user_agent.split(") ")[0].replace("(", "— ") : "");
        if (a.action === "login_failed") return "Failed sign-in (" + (det.reason || "") + ") for '" + a.entity_id + "'";
        if (a.action === "logout") return "Signed out";
        if (det.changes) return Object.keys(det.changes).filter(function (k) { return k !== "category_path"; }).map(function (k) { return k.replace(/_/g, " ") + ": " + JSON.stringify(det.changes[k].from) + " → " + JSON.stringify(det.changes[k].to); }).join("; ") + (det.reason ? " · Reason: " + det.reason : "");
        if (det.reason) return (det.description ? det.description + " · " : "") + "Reason: " + det.reason;
        return Object.keys(det).map(function (k) { return k + ": " + (typeof det[k] === "object" ? JSON.stringify(det[k]) : det[k]); }).join("; ");
      }
      $("#audit-table").innerHTML = d.items.length ? '<table class="data cards"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>IP</th><th>Details</th></tr></thead><tbody>' +
        d.items.map(function (a) {
          var rec = a.entity_type === "expense" ? '<button class="link-btn" data-open="' + esc(a.entity_id) + '">' + esc(a.entity_id) + '</button>' : esc(a.entity_type + (a.entity_id && a.entity_type !== "user" ? " " + a.entity_id : ""));
          var cls = a.action.indexOf("deleted") >= 0 || a.action === "login_failed" ? "bad" : a.action === "login" || a.action.indexOf("created") >= 0 ? "ok" : a.action.indexOf("edited") >= 0 ? "warn" : "";
          return '<tr><td data-label="When" class="nowrap">' + fmtDateTime(a.at) + '</td><td data-label="User">' + esc(a.user_name) + '</td><td data-label="Action"><span class="tag ' + cls + '">' + esc(a.action.replace(/_/g, " ")) + '</span></td><td data-label="Record">' + rec + '</td><td data-label="IP" class="small">' + esc(a.ip || "") + '</td><td data-label="Details" class="small">' + esc(describe(a).slice(0, 300)) + '</td></tr>';
        }).join("") + '</tbody></table>' : '<div class="empty">Nothing here.</div>';
      $("#audit-table").addEventListener("click", function (e) { var r = e.target.closest("[data-open]"); if (r) EM.openExpenseDetail(r.getAttribute("data-open")); });
      $("#pager").innerHTML = '<button class="btn btn-sm" id="pg-prev"' + (d.page <= 1 ? " disabled" : "") + '>‹ Prev</button><span class="small">Page ' + d.page + ' of ' + d.pages + ' · ' + d.total + ' entries</span><button class="btn btn-sm" id="pg-next"' + (d.page >= d.pages ? " disabled" : "") + '>Next ›</button>';
      $("#pg-prev").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page - 1 })); });
      $("#pg-next").addEventListener("click", function () { navigate("history", Object.assign({}, p, { page: d.page + 1 })); });
    });
  };

  // =================================================================== PROJECTS & PARTNERS
  EM.views.projects = function (main, route, isCurrent) {
    EM.setTitle("Projects & partners");
    var manage = can("project:manage");
    return api("GET", "/api/projects").then(function (d) {
      if (!isCurrent()) return;
      state.projects = d.projects;
      main.innerHTML = '<div class="panel"><div class="panel-head"><h2>' + esc(d.firm_name) + ' — projects</h2>' + (manage ? '<button class="btn btn-primary btn-sm" id="p-new">+ New project</button>' : "") + '</div>' +
        '<p class="muted small">Each project has its own partners, percentages, categories and expenses. Percentages are applied to the current totals, so a change recalculates everything.</p>' +
        '<div class="project-grid" id="p-list">' + d.projects.map(function (p) {
          var active = p.partners.filter(function (x) { return x.active !== false; });
          return '<div class="project-card"><h3>' + esc(p.name) + (p.status === "archived" ? ' <span class="tag">archived</span>' : "") + (state.project && state.project.id === p.id ? ' <span class="tag ok">current</span>' : "") + '</h3>' +
            (p.description ? '<p class="muted small" style="margin:0">' + esc(p.description) + '</p>' : "") +
            '<div class="stats"><div class="stat"><span>Expenses</span><strong>' + p.expense_count + '</strong></div><div class="stat"><span>Total</span><strong class="amount">' + fmtINR(p.expense_total, 0) + '</strong></div><div class="stat"><span>Partners</span><strong>' + active.length + '</strong></div></div>' +
            '<div class="partners">' + active.map(function (x) { return '<span class="tag">' + esc(x.name) + ' · ' + x.share + '%</span>'; }).join("") + '</div>' +
            '<div class="btn-row"><button class="btn btn-primary btn-sm" data-use="' + esc(p.id) + '">Open</button>' + (manage ? '<button class="btn btn-sm" data-partners="' + esc(p.id) + '">Partners</button><button class="btn btn-sm" data-fields="' + esc(p.id) + '">Expense fields</button><button class="btn btn-sm" data-edit="' + esc(p.id) + '">Edit</button>' : "") + '</div></div>';
        }).join("") + '</div></div>';
      if ($("#p-new")) $("#p-new").addEventListener("click", function () { projectForm(null); });
      $("#p-list").addEventListener("click", function (e) {
        var t = e.target.closest("button"); if (!t) return;
        var id, proj;
        if ((id = t.getAttribute("data-use"))) { EM.setProject(id); $("#project-select").value = id; navigate("dashboard", {}); }
        else if ((id = t.getAttribute("data-partners"))) { proj = d.projects.filter(function (x) { return x.id === id; })[0]; partnersForm(proj); }
        else if ((id = t.getAttribute("data-fields"))) { proj = d.projects.filter(function (x) { return x.id === id; })[0]; fieldsForm(proj); }
        else if ((id = t.getAttribute("data-edit"))) { proj = d.projects.filter(function (x) { return x.id === id; })[0]; projectForm(proj); }
      });
    });
  };

  function partnerRowsHtml(partners) {
    return partners.map(function (x, i) {
      return '<div class="split-row partner-row" data-i="' + i + '"><input placeholder="Name" value="' + esc(x.name || "") + '" data-f="name"><input type="number" step="0.01" min="0" max="100" placeholder="%" value="' + (x.share === undefined ? "" : x.share) + '" data-f="share">' +
        '<input placeholder="Phone" value="' + esc(x.phone || "") + '" data-f="phone"><label class="chk"><input type="checkbox" data-f="active"' + (x.active === false ? "" : " checked") + '> active</label><button type="button" class="link-btn danger" data-remove="' + i + '">Remove</button></div>';
    }).join("");
  }
  function readPartnerRows(body) {
    return $$(".partner-row", body).map(function (row, i) {
      var r = { name: $('[data-f="name"]', row).value.trim(), share: $('[data-f="share"]', row).value, phone: $('[data-f="phone"]', row).value.trim(), active: $('[data-f="active"]', row).checked };
      if (row.getAttribute("data-id")) r.id = row.getAttribute("data-id");
      return r;
    });
  }
  function wirePartnerRows(body, partners) {
    var box = $("#partner-rows", body);
    function draw() {
      box.innerHTML = partnerRowsHtml(partners);
      $$(".partner-row", box).forEach(function (row, i) { if (partners[i].id) row.setAttribute("data-id", partners[i].id); });
      total();
    }
    function total() {
      var sum = readPartnerRows(body).filter(function (r) { return r.active; }).reduce(function (a, r) { return a + (parseFloat(r.share) || 0); }, 0);
      var st = $("#partner-total", body);
      st.textContent = "Active partners total " + (Math.round(sum * 100) / 100) + "%" + (Math.abs(sum - 100) < 0.01 ? " ✓" : " — must be 100%");
      st.className = "split-status " + (Math.abs(sum - 100) < 0.01 ? "ok" : "bad");
    }
    box.addEventListener("input", total);
    box.addEventListener("change", total);
    box.addEventListener("click", function (e) {
      var r = e.target.closest("[data-remove]");
      if (r) { var cur = readPartnerRows(body); cur.splice(+r.getAttribute("data-remove"), 1); partners.length = 0; cur.forEach(function (x) { partners.push(x); }); draw(); }
    });
    $("#partner-add", body).addEventListener("click", function () { var cur = readPartnerRows(body); cur.push({ name: "", share: "", phone: "", active: true }); partners.length = 0; cur.forEach(function (x) { partners.push(x); }); draw(); });
    $("#partner-equal", body).addEventListener("click", function () {
      var cur = readPartnerRows(body), active = cur.filter(function (x) { return x.active; });
      if (!active.length) return;
      var each = Math.floor(10000 / active.length) / 100, left = Math.round((100 - each * active.length) * 100) / 100, first = true;
      cur.forEach(function (x) { if (x.active) { x.share = first ? Math.round((each + left) * 100) / 100 : each; first = false; } });
      partners.length = 0; cur.forEach(function (x) { partners.push(x); }); draw();
    });
    draw();
  }

  function projectForm(existing) {
    var partners = existing ? JSON.parse(JSON.stringify(existing.partners)) : [{ name: "", share: 50, phone: "", active: true }, { name: "", share: 50, phone: "", active: true }];
    var body = openModal(existing ? "Edit project" : "New project",
      '<form id="p-form" novalidate><div class="field"><label class="required" for="p-name">Project name</label><input id="p-name" maxlength="80" value="' + esc(existing ? existing.name : "") + '"></div>' +
      '<div class="field"><label for="p-desc">Description</label><input id="p-desc" maxlength="300" value="' + esc(existing ? existing.description : "") + '"></div>' +
      (existing ? '<div class="field inline"><input type="checkbox" id="p-archived"' + (existing.status === "archived" ? " checked" : "") + '><label for="p-archived">Archived (hidden from daily use)</label></div>'
        : '<h3>Partners</h3><p class="muted small">Name, percentage share and phone. Percentages of active partners must total 100.</p><div class="split-rows partner-rows" id="partner-rows"></div><div class="split-status" id="partner-total"></div><div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-sm" id="partner-add">+ Add partner</button><button type="button" class="btn btn-sm" id="partner-equal">Split equally</button></div>') +
      '<p class="form-error" id="p-error" hidden></p><div class="btn-row end" style="margin-top:14px"><button type="button" class="btn" id="p-cancel">Cancel</button><button type="submit" class="btn btn-primary">' + (existing ? "Save" : "Create project") + '</button></div></form>', { wide: true });
    if (!existing) wirePartnerRows(body, partners);
    $("#p-cancel", body).addEventListener("click", closeModal);
    $("#p-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = { name: $("#p-name", body).value.trim(), description: $("#p-desc", body).value.trim() };
      if (existing) payload.status = $("#p-archived", body).checked ? "archived" : "active"; else payload.partners = readPartnerRows(body);
      (existing ? api("PUT", "/api/projects/" + existing.id, payload) : api("POST", "/api/projects", payload))
        .then(function (d) { closeModal(); toast(existing ? "Project saved." : "Project created.", "ok"); return EM.refreshProject().then(function () { if (!existing) { EM.setProject(d.project.id); $("#project-select").value = d.project.id; } render(); }); })
        .catch(function (err) { $("#p-error", body).textContent = err.message; $("#p-error", body).hidden = false; });
    });
  }

  function partnersForm(proj) {
    var partners = JSON.parse(JSON.stringify(proj.partners));
    var body = openModal("Partners — " + proj.name,
      '<p class="muted small">Partner count: <strong id="partner-count">' + partners.length + '</strong>. A partner who has already paid cannot be removed — untick “active” instead. Changing a percentage recalculates the shares on the dashboard immediately.</p>' +
      '<div class="split-rows partner-rows" id="partner-rows"></div><div class="split-status" id="partner-total"></div>' +
      '<div class="btn-row" style="margin-top:8px"><button type="button" class="btn btn-sm" id="partner-add">+ Add partner</button><button type="button" class="btn btn-sm" id="partner-equal">Split equally</button></div>' +
      '<p class="form-error" id="pp-error" hidden></p><div class="btn-row end" style="margin-top:14px"><button class="btn" id="pp-cancel">Cancel</button><button class="btn btn-primary" id="pp-save">Save partners</button></div>', { wide: true });
    wirePartnerRows(body, partners);
    $("#partner-rows", body).addEventListener("click", function () { $("#partner-count", body).textContent = $$(".partner-row", body).length; });
    $("#pp-cancel", body).addEventListener("click", closeModal);
    $("#pp-save", body).addEventListener("click", function () {
      api("PUT", "/api/projects/" + proj.id, { partners: readPartnerRows(body) })
        .then(function () { closeModal(); toast("Partners saved.", "ok"); return EM.refreshProject().then(render); })
        .catch(function (err) { $("#pp-error", body).textContent = err.message; $("#pp-error", body).hidden = false; });
    });
  }

  function fieldsForm(proj) {
    var cfg = proj.field_config || {}, custom = JSON.parse(JSON.stringify(proj.custom_fields || []));
    var body = openModal("Expense fields — " + proj.name,
      '<p class="muted small">Description, amount, date, category and “paid by” are always recorded. Choose what else to record.</p>' +
      META.optional_fields.map(function (f) { var c = cfg[f[0]] || {}; return '<div class="field-config-row"><label>' + esc(f[1]) + '</label><label class="chk"><input type="checkbox" data-en="' + f[0] + '"' + (c.enabled ? " checked" : "") + '> show</label><label class="chk"><input type="checkbox" data-req="' + f[0] + '"' + (c.required ? " checked" : "") + '> required</label></div>'; }).join("") +
      '<h3 style="margin-top:18px">Your own fields</h3><p class="muted small">Add anything else you want on the form — for example “Bill number” (text), “Quantity” (number), “Site” (dropdown).</p><div id="custom-rows"></div>' +
      '<button type="button" class="btn btn-sm" id="cf-add">+ Add field</button>' +
      '<p class="form-error" id="ff-error" hidden></p><div class="btn-row end" style="margin-top:14px"><button class="btn" id="ff-cancel">Cancel</button><button class="btn btn-primary" id="ff-save">Save</button></div>', { wide: true });
    var box = $("#custom-rows", body);
    function draw() {
      box.innerHTML = custom.map(function (f, i) {
        return '<div class="custom-row" data-i="' + i + '"><input placeholder="Label" value="' + esc(f.label || "") + '" data-f="label"><select data-f="type">' + META.custom_field_types.map(function (t) { return '<option' + (t === f.type ? " selected" : "") + '>' + t + '</option>'; }).join("") + '</select>' +
          '<input placeholder="Options, comma separated (dropdown only)" value="' + esc((f.options || []).join(", ")) + '" data-f="options"' + (f.type === "select" ? "" : " disabled") + '><label class="chk"><input type="checkbox" data-f="required"' + (f.required ? " checked" : "") + '> required</label><button type="button" class="link-btn danger" data-remove="' + i + '">Remove</button></div>';
      }).join("");
    }
    function read() {
      return $$(".custom-row", box).map(function (row, i) {
        return { key: custom[i].key, label: $('[data-f="label"]', row).value.trim(), type: $('[data-f="type"]', row).value, required: $('[data-f="required"]', row).checked,
          options: $('[data-f="options"]', row).value.split(",").map(function (s) { return s.trim(); }).filter(Boolean) };
      });
    }
    box.addEventListener("change", function (e) { if (e.target.getAttribute("data-f") === "type") { custom = read(); draw(); } });
    box.addEventListener("click", function (e) { var r = e.target.closest("[data-remove]"); if (r) { custom = read(); custom.splice(+r.getAttribute("data-remove"), 1); draw(); } });
    $("#cf-add", body).addEventListener("click", function () { custom = read(); custom.push({ label: "", type: "text", required: false, options: [] }); draw(); });
    draw();
    $("#ff-cancel", body).addEventListener("click", closeModal);
    $("#ff-save", body).addEventListener("click", function () {
      var fc = {};
      META.optional_fields.forEach(function (f) { fc[f[0]] = { enabled: $('[data-en="' + f[0] + '"]', body).checked, required: $('[data-req="' + f[0] + '"]', body).checked }; });
      api("PUT", "/api/projects/" + proj.id, { field_config: fc, custom_fields: read() })
        .then(function () { closeModal(); toast("Fields saved.", "ok"); return EM.refreshProject().then(render); })
        .catch(function (err) { $("#ff-error", body).textContent = err.message; $("#ff-error", body).hidden = false; });
    });
  }

  // =================================================================== USERS
  EM.views.users = function (main, route, isCurrent) {
    EM.setTitle("Users");
    if (!can("user:manage")) { main.innerHTML = '<div class="panel"><p>Only the administrator can manage users.</p></div>'; return; }
    return api("GET", "/api/users").then(function (d) {
      if (!isCurrent()) return;
      main.innerHTML = '<div class="panel"><div class="panel-head"><h2>User accounts</h2><button class="btn btn-primary btn-sm" id="u-new">+ New user</button></div>' +
        '<p class="muted small"><strong>admin</strong> — you, full control (only one) · <strong>editor</strong> — partners: add and edit expenses, manage categories, download reports · <strong>viewer</strong> — read-only with downloads. Every sign-in is logged under History → Login access.</p>' +
        '<div class="table-wrap" id="users-table"><table class="data cards"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>' +
        d.users.map(function (u) {
          return '<tr><td data-label="User"><strong>' + esc(u.full_name) + '</strong><br><span class="muted small">' + esc(u.username) + '</span></td><td data-label="Role">' + esc(u.role) + '</td>' +
            '<td data-label="Status">' + (u.active ? '<span class="tag ok">Active</span>' : '<span class="tag bad">Disabled</span>') + (u.must_change_password ? ' <span class="tag warn">Must change password</span>' : "") + '</td><td data-label="Last sign-in">' + fmtDateTime(u.last_login_at) + '</td><td class="no-label"><button class="link-btn" data-edit="' + esc(u.id) + '">Edit</button></td></tr>';
        }).join("") + '</tbody></table></div></div>';
      $("#u-new").addEventListener("click", function () { userForm(null); });
      $("#users-table").addEventListener("click", function (e) { var t = e.target.closest("[data-edit]"); if (t) userForm(d.users.filter(function (u) { return u.id === t.getAttribute("data-edit"); })[0]); });
    });
  };

  function userForm(u) {
    var isSelf = u && u.id === EM.USER.id, isAdmin = u && u.role === "admin";
    var body = openModal(u ? "Edit " + u.username : "New user",
      '<form id="u-form" novalidate>' + (!u ? '<div class="field"><label class="required" for="u-username">Username</label><input id="u-username" maxlength="64" autocapitalize="none"></div>' : "") +
      '<div class="field"><label class="required" for="u-name">Full name</label><input id="u-name" maxlength="120" value="' + esc(u ? u.full_name : "") + '"></div>' +
      (isAdmin ? "" : '<div class="field"><label for="u-role">Role</label><select id="u-role"><option value="editor"' + ((u ? u.role : "editor") === "editor" ? " selected" : "") + '>editor</option><option value="viewer"' + (u && u.role === "viewer" ? " selected" : "") + '>viewer</option></select></div>') +
      '<div class="field"><label for="u-pw">' + (u ? "Reset password (leave blank to keep)" : "Temporary password") + '</label><input id="u-pw" type="password" autocomplete="new-password"><span class="hint">They must change it on first sign-in.</span></div>' +
      (u && !isSelf ? '<div class="field inline"><input type="checkbox" id="u-active"' + (u.active ? " checked" : "") + '><label for="u-active">Account active</label></div>' : "") +
      '<p class="form-error" id="u-error" hidden></p><div class="btn-row end"><button type="button" class="btn" id="u-cancel">Cancel</button><button type="submit" class="btn btn-primary">' + (u ? "Save" : "Create user") + '</button></div></form>');
    $("#u-cancel", body).addEventListener("click", closeModal);
    $("#u-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = { full_name: $("#u-name", body).value.trim() }, pw = $("#u-pw", body).value, req;
      if ($("#u-role", body)) payload.role = $("#u-role", body).value;
      if (u) { if (pw) payload.new_password = pw; if (!isSelf) payload.active = $("#u-active", body).checked; req = api("PUT", "/api/users/" + u.id, payload); }
      else { payload.username = $("#u-username", body).value.trim(); payload.password = pw; req = api("POST", "/api/users", payload); }
      req.then(function () { closeModal(); toast(u ? "User updated." : "User created.", "ok"); render(); }).catch(function (err) { $("#u-error", body).textContent = err.message; $("#u-error", body).hidden = false; });
    });
  }

  // =================================================================== SETTINGS & BACKUPS
  EM.views.settings = function (main, route, isCurrent) {
    EM.setTitle("Settings & backups");
    var canBackup = can("backup:create"), canRestore = can("backup:restore");
    main.innerHTML = '<div class="panel"><h2>Your account</h2><p>Signed in as <strong>' + esc(EM.USER.full_name) + '</strong> (' + esc(EM.USER.username) + ', ' + esc(EM.USER.role) + ').</p><div class="btn-row"><button class="btn" id="s-pw">Change password</button><a class="btn" href="#/projects">Projects, partners &amp; expense fields</a></div></div>' +
      (canBackup ? '<div class="panel"><h2>Backups</h2><p class="muted small">After every change the app rewrites three identical JSON copies (<code>backups/copy_1</code>, <code>copy_2</code>, <code>copy_3</code>) and the day’s file in <code>backups/history/</code>. Each contains all projects, expenses, categories, history and users.</p><div class="btn-row"><a class="btn btn-primary" href="/api/backup">Download full backup (JSON)</a></div><div id="backup-list" style="margin-top:14px"></div></div>' : "") +
      (canRestore ? '<div class="panel"><h2>Restore from backup</h2><p class="muted small">Upload a backup file. It is checked first and you see a preview before anything changes. A safety copy of the current data is saved automatically.</p><div class="field"><label for="rs-file">Backup file</label><input type="file" id="rs-file" accept="application/json,.json"></div><div class="btn-row"><button class="btn" id="rs-validate">Check &amp; preview</button></div><div id="rs-preview" style="margin-top:14px"></div></div>' : "");
    $("#s-pw").addEventListener("click", function () { EM.openChangePassword(false); });
    if (canBackup) {
      api("GET", "/api/backup/logs").then(function (d) {
        if (!isCurrent() || !$("#backup-list")) return;
        var st = d.status;
        var copies = '<h3>The ' + d.copies + ' copies</h3><div class="copy-status">' + st.copies.map(function (c) { return c.exists ? '<span class="tag ' + (st.all_identical ? "ok" : "warn") + '">copy_' + c.copy + ' · ' + (c.size / 1024).toFixed(0) + ' KB · ' + fmtDateTime(c.modified) + '</span>' : '<span class="tag bad">copy_' + c.copy + ' missing (will be re-created on the next change)</span>'; }).join("") + '</div>' +
          '<p class="small ' + (st.all_identical ? "muted" : "") + '">' + (st.all_identical ? "All copies are identical (checksum " + esc(st.copies[0].checksum) + "). If one is lost, the others hold the same data." : "Copies differ or are missing — they will be rewritten identically on the next change.") + '</p>';
        var files = d.files.length ? '<h3 style="margin-top:14px">Files on the server</h3><p class="muted small">History keeps one copy per day for ' + d.history_days + ' days, so a mistaken change can still be undone from an earlier day.</p><div class="table-wrap"><table class="data cards"><thead><tr><th>File</th><th>Size</th><th>Updated</th></tr></thead><tbody>' +
          d.files.map(function (f) { return '<tr><td data-label="File">' + (canRestore ? '<a href="/api/backup/files/' + esc(f.name) + '">' + esc(f.name) + '</a>' : esc(f.name)) + '</td><td data-label="Size">' + (f.size / 1024).toFixed(1) + ' KB</td><td data-label="Updated">' + fmtDateTime(f.modified) + '</td></tr>'; }).join("") + '</tbody></table></div>' : '<p class="muted small">No backup files yet — they appear after the first change.</p>';
        $("#backup-list").innerHTML = copies + files;
      }).catch(fail);
    }
    if (canRestore) {
      $("#rs-validate").addEventListener("click", function () {
        var f = $("#rs-file").files[0];
        if (!f) { toast("Choose a backup file first.", "error"); return; }
        var fd = new FormData(); fd.append("file", f);
        api("POST", "/api/backup/validate", fd).then(function (d) {
          var box = $("#rs-preview");
          box.innerHTML = (d.valid ? '<div class="notice ok">Backup is valid' + (d.generated_at ? ' (created ' + fmtDateTime(d.generated_at) + ')' : "") + '.</div>' : '<div class="notice danger"><strong>Problems:</strong><ul>' + d.problems.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul></div>') +
            '<div class="table-wrap"><table class="data cards"><thead><tr><th>Collection</th><th>Records</th><th>Already exist</th></tr></thead><tbody>' + Object.keys(d.summary).map(function (k) { return '<tr><td data-label="Collection">' + esc(k) + '</td><td data-label="Records">' + d.summary[k].records + '</td><td data-label="Conflicts">' + d.summary[k].conflicts + '</td></tr>'; }).join("") + '</tbody></table></div>' +
            (d.valid ? '<div class="field" style="margin-top:14px"><label for="rs-mode">Restore mode</label><select id="rs-mode"><option value="merge">Merge — add new records, overwrite same IDs</option><option value="replace">Replace — delete current data, then import</option></select></div><div class="field inline"><input type="checkbox" id="rs-confirm"><label for="rs-confirm">I understand this changes financial records.</label></div><button class="btn btn-danger" id="rs-go">Restore now</button>' : "");
          if (d.valid) $("#rs-go").addEventListener("click", function () {
            if (!$("#rs-confirm").checked) { toast("Tick the confirmation box first.", "error"); return; }
            var fd2 = new FormData(); fd2.append("file", f); fd2.append("mode", $("#rs-mode").value); fd2.append("confirm", "true");
            $("#rs-go").disabled = true;
            api("POST", "/api/backup/restore", fd2).then(function (r) { box.innerHTML = '<div class="notice ok">Restore complete (' + esc(r.mode) + '). Safety copy: ' + esc(r.pre_restore_backup) + '</div>'; return EM.refreshProject(); }).catch(function (err) { $("#rs-go").disabled = false; fail(err); });
          });
        }).catch(fail);
      });
    }
  };
})(window.EM);
