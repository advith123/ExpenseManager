/* Expense Manager — frontend core (vanilla JS) */
(function (global) {
  "use strict";

  var USER = JSON.parse(document.getElementById("bootstrap-user").textContent);
  var META = JSON.parse(document.getElementById("bootstrap-meta").textContent);
  var CSRF = document.querySelector('meta[name="csrf-token"]').getAttribute("content");

  var state = { projects: [], project: null, categories: { flat: [], tree: [] }, prefs: null, savedFilters: [], expenseMeta: { vendors: [], phases: [] } };
  var renderToken = 0;

  // ------------------------------------------------------------------ utils
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function fmtINR(n, decimals) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var d = decimals === undefined ? 2 : decimals;
    return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtDate(iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }); }
  function fmtDateTime(iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function todayISO() { return isoDate(new Date()); }
  function can(perm) { return USER.permissions.indexOf("*") >= 0 || USER.permissions.indexOf(perm) >= 0; }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function uuid() { return (global.crypto && crypto.randomUUID) ? crypto.randomUUID() : "k-" + Date.now() + "-" + Math.random().toString(16).slice(2); }
  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
      [].concat(v).forEach(function (x) { parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(x)); });
    });
    return parts.length ? "?" + parts.join("&") : "";
  }
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, ""), i = h.indexOf("?");
    var params = {};
    if (i >= 0) new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) { params[k] = params[k] !== undefined ? [].concat(params[k], v) : v; });
    return { path: (i >= 0 ? h.slice(0, i) : h) || "dashboard", params: params };
  }
  function navigate(path, params) { location.hash = "#/" + path + qs(params || {}); }
  function categoryName(id) { var c = state.categories.flat.filter(function (x) { return x.id === id; })[0]; return c ? c.name : id; }
  function partnerName(id) { var p = (state.project ? state.project.partners : []).filter(function (x) { return x.id === id; })[0]; return p ? p.name : id; }
  function fieldLabel(key) {
    var m = { description: "Description", amount: "Amount", transaction_date: "Date", category_id: "Category", subcategory_id: "Subcategory", category_path: "Category path",
      payments: "Paid by", vendor: "Vendor", payment_method: "Payment method", payment_reference: "Payment reference", payment_status: "Payment status", notes: "Notes",
      receipt_reference: "Receipt / invoice", expense_type: "Expense type", project_phase: "Phase", status: "Status", custom: "Custom fields" };
    return m[key] || key;
  }
  function fmtValue(key, v) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "(empty)";
    if (key === "amount") return fmtINR(v);
    if (key === "transaction_date") return fmtDate(v);
    if (key === "category_path" && Array.isArray(v)) return v.join(" > ");
    if (key === "category_id" || key === "subcategory_id") return categoryName(v);
    if (key === "payments" && Array.isArray(v)) return v.map(function (p) { return p.partner_name + " " + fmtINR(p.amount, 0); }).join(", ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function paidByText(e) { var ps = Array.isArray(e.payments) ? e.payments : (e.payments ? [e.payments] : []); return ps.map(function (p) { return p.partner_name + (e.payments.length > 1 ? " " + fmtINR(p.amount, 0) : ""); }).join(", ") || "—"; }
  function _pl(e) { return Array.isArray(e.payments) ? e.payments : (e.payments ? [e.payments] : []); }

  // ------------------------------------------------------------------ toast / modal
  function toast(msg, kind) {
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    $("#toast-root").appendChild(el);
    setTimeout(function () { el.remove(); }, kind === "error" ? 6000 : 3500);
  }
  var modalCloseHandler = null;
  function openModal(title, bodyHtml, opts) {
    opts = opts || {};
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal").classList.toggle("wide", !!opts.wide);
    $("#modal-root").hidden = false;
    document.body.style.overflow = "hidden";
    modalCloseHandler = opts.onClose || null;
    var first = $("#modal-body input:not([type=hidden]), #modal-body select, #modal-body textarea, #modal-body button");
    if (first) setTimeout(function () { first.focus(); }, 30);
    return $("#modal-body");
  }
  function closeModal() {
    $("#modal-root").hidden = true;
    document.body.style.overflow = "";
    if (modalCloseHandler) { var h = modalCloseHandler; modalCloseHandler = null; h(); }
  }
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("#modal-root").hidden) closeModal(); });

  function askReason(title, prompt, confirmLabel, danger) {
    return new Promise(function (resolve) {
      var body = openModal(title, '<p>' + esc(prompt) + '</p><div class="field"><label for="reason-input" class="required">Reason</label>' +
        '<textarea id="reason-input" maxlength="300" placeholder="Why? (saved in the history)"></textarea></div><p class="form-error" id="reason-error" hidden></p>' +
        '<div class="btn-row end"><button class="btn" id="reason-cancel">Cancel</button><button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" id="reason-ok">' + esc(confirmLabel) + '</button></div>',
        { onClose: function () { resolve(null); } });
      $("#reason-cancel", body).addEventListener("click", closeModal);
      $("#reason-ok", body).addEventListener("click", function () {
        var r = $("#reason-input", body).value.trim();
        if (r.length < 3) { $("#reason-error", body).textContent = "Enter a reason (at least 3 characters)."; $("#reason-error", body).hidden = false; return; }
        modalCloseHandler = null; closeModal(); resolve(r);
      });
    });
  }

  // ------------------------------------------------------------------ API
  function api(method, url, body, opts) {
    opts = opts || {};
    var headers = { "X-CSRF-Token": CSRF };
    if (state.project) headers["X-Project-Id"] = state.project.id;
    var init = { method: method, headers: headers, credentials: "same-origin" };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });
    return fetch(url, init).then(function (r) {
      if (r.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.hash); throw new Error("Not signed in"); }
      return r.json().catch(function () { return { error: "Unexpected server response." }; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.error || "Request failed"); e.status = r.status; e.data = data; throw e; }
        return data;
      });
    });
  }
  function fail(err) { if (err && err.message !== "Not signed in") toast(err.message || "Something went wrong.", "error"); }
  function fileUrl(path, params) { return path + qs(Object.assign({ project_id: state.project ? state.project.id : "" }, params || {})); }

  // ------------------------------------------------------------------ projects
  function loadProjects() {
    return api("GET", "/api/projects").then(function (d) {
      state.projects = d.projects;
      var saved = localStorage.getItem("em_project");
      state.project = state.projects.filter(function (p) { return p.id === saved; })[0] || state.projects.filter(function (p) { return p.status === "active"; })[0] || state.projects[0] || null;
      var sel = $("#project-select");
      sel.innerHTML = state.projects.map(function (p) { return '<option value="' + esc(p.id) + '"' + (state.project && p.id === state.project.id ? " selected" : "") + '>' + esc(p.name) + (p.status === "archived" ? " (archived)" : "") + '</option>'; }).join("") || '<option value="">No projects yet</option>';
      state.categories = { flat: [], tree: [] };
      return state.project;
    });
  }
  function setProject(id) {
    state.project = state.projects.filter(function (p) { return p.id === id; })[0] || null;
    if (state.project) localStorage.setItem("em_project", state.project.id);
    state.categories = { flat: [], tree: [] };
    state.prefs = null;
  }
  function refreshProject() {
    return api("GET", "/api/projects").then(function (d) {
      state.projects = d.projects;
      var cur = state.project ? state.project.id : null;
      state.project = state.projects.filter(function (p) { return p.id === cur; })[0] || state.projects[0] || null;
      $("#project-select").innerHTML = state.projects.map(function (p) { return '<option value="' + esc(p.id) + '"' + (state.project && p.id === state.project.id ? " selected" : "") + '>' + esc(p.name) + (p.status === "archived" ? " (archived)" : "") + '</option>'; }).join("");
    });
  }

  // ------------------------------------------------------------------ shell
  function setupShell() {
    $("#user-name").textContent = USER.full_name || USER.username;
    $("#user-role").textContent = USER.role;
    $("#user-avatar").textContent = (USER.full_name || USER.username).slice(0, 1).toUpperCase();
    $$("[data-perm]").forEach(function (el) { if (!can(el.getAttribute("data-perm"))) el.remove(); });
    $("#logout-btn").addEventListener("click", function () { api("POST", "/api/auth/logout").then(function () { location.href = "/login"; }).catch(function () { location.href = "/login"; }); });
    var sidebar = $("#sidebar"), backdrop = $("#sidebar-backdrop");
    function closeNav() { sidebar.classList.remove("open"); backdrop.hidden = true; }
    $("#menu-btn").addEventListener("click", function () { sidebar.classList.add("open"); backdrop.hidden = false; });
    $("#sidebar-close").addEventListener("click", closeNav);
    backdrop.addEventListener("click", closeNav);
    $("#nav").addEventListener("click", function (e) { if (e.target.closest("a")) closeNav(); });
    $("#project-select").addEventListener("change", function () { setProject(this.value); closeNav(); render(); });
    var quick = $("#quick-add-btn");
    if (quick) quick.addEventListener("click", function () { openExpenseForm(null); });
    var idleMs = (META.idle_minutes || 30) * 60000, idleTimer;
    function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(function () { location.href = "/login"; }, idleMs); }
    ["click", "keydown", "touchstart", "mousemove"].forEach(function (ev) { document.addEventListener(ev, debounce(resetIdle, 1000), { passive: true }); });
    resetIdle();
    if (USER.must_change_password) setTimeout(function () { openChangePassword(true); }, 200);
  }

  function openChangePassword(forced) {
    var body = openModal(forced ? "Set a new password" : "Change password",
      (forced ? '<div class="notice">Set a new password before continuing.</div>' : "") +
      '<form id="pw-form" novalidate><div class="field"><label for="pw-current">Current password</label><input id="pw-current" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password"><span class="hint">At least 8 characters with uppercase, lowercase and a number.</span></div>' +
      '<div class="field"><label for="pw-confirm">Confirm new password</label><input id="pw-confirm" type="password" autocomplete="new-password"></div>' +
      '<p class="form-error" id="pw-error" hidden></p><div class="btn-row end">' + (forced ? "" : '<button type="button" class="btn" id="pw-cancel">Cancel</button>') +
      '<button type="submit" class="btn btn-primary">Save new password</button></div></form>',
      { onClose: function () { if (forced) setTimeout(function () { openChangePassword(true); }, 50); } });
    if (!forced) $("#pw-cancel", body).addEventListener("click", closeModal);
    $("#pw-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      api("POST", "/api/auth/change-password", { current_password: $("#pw-current", body).value, new_password: $("#pw-new", body).value, confirm_password: $("#pw-confirm", body).value })
        .then(function () { USER.must_change_password = false; modalCloseHandler = null; closeModal(); toast("Password updated.", "ok"); })
        .catch(function (err) { $("#pw-error", body).textContent = err.message; $("#pw-error", body).hidden = false; });
    });
  }

  // ------------------------------------------------------------------ categories
  function loadCategories(includeArchived) {
    return api("GET", "/api/categories" + (includeArchived ? "?include_archived=1" : "")).then(function (d) { if (!includeArchived) state.categories = d; return d; });
  }
  function topCategories() { return state.categories.flat.filter(function (c) { return c.level === 0; }); }
  function childrenOf(parentId) { return state.categories.flat.filter(function (c) { return c.parent_id === parentId; }); }
  function topOptions(selectedId, blankLabel) {
    return '<option value="">' + esc(blankLabel || "Choose category…") + '</option>' + topCategories().map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + '>' + esc(c.name) + '</option>'; }).join("");
  }
  function subOptions(parentId, selectedId, blankLabel) {
    var kids = parentId ? childrenOf(parentId) : [];
    return '<option value="">' + esc(blankLabel || (kids.length ? "Choose subcategory (optional)" : "No subcategories")) + '</option>' + kids.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + '>' + esc(c.name) + '</option>'; }).join("");
  }
  function quickAddCategory(parentId, onDone) {
    var name = prompt(parentId ? "New subcategory under " + categoryName(parentId) + ":" : "New category name:");
    if (!name || name.trim().length < 2) return;
    api("POST", "/api/categories", { name: name.trim(), parent_id: parentId || null }).then(function (d) {
      return loadCategories().then(function () { toast("Added " + d.category.name + ".", "ok"); onDone(d.category); });
    }).catch(fail);
  }

  // ------------------------------------------------------------------ router
  var views = {};
  function setTitle(t) { $("#page-title").textContent = t; document.title = t + " · " + META.firm_name; }
  function render() {
    var token = ++renderToken;
    var route = parseHash(), main = $("#main");
    $$(".nav-link").forEach(function (a) { var v = route.path.split("/")[0]; a.classList.toggle("active", a.getAttribute("data-view") === (v === "custom" ? "reports" : v)); });
    var name = route.path.split("/")[0];
    var view = views[name] || views.dashboard;
    main.innerHTML = '<div class="empty">Loading…</div>';
    closeModal();
    var needsProject = ["dashboard", "expenses", "categories", "reports", "custom"].indexOf(name) >= 0;
    if (needsProject && !state.project) {
      main.innerHTML = '<div class="panel"><h2>No project yet</h2><p>Create your first project to start recording expenses.</p>' + (can("project:manage") ? '<a class="btn btn-primary" href="#/projects">Go to Projects &amp; partners</a>' : "") + '</div>';
      return;
    }
    var isCurrent = function () { return token === renderToken; };
    Promise.resolve(view(main, route, isCurrent)).catch(function (err) {
      if (!isCurrent()) return;
      fail(err);
      main.innerHTML = '<div class="panel"><p class="form-error">' + esc(err.message || "Could not load this page.") + '</p></div>';
    });
  }
  window.addEventListener("hashchange", render);

  // =================================================================== DASHBOARD
  var PERIODS = [["all_time", "All time"], ["this_month", "This month"], ["last_month", "Last month"], ["this_quarter", "This quarter"], ["this_year", "This year"],
    ["last_30_days", "Last 30 days"], ["last_90_days", "Last 90 days"], ["custom", "Custom range"]];

  views.dashboard = function (main, route, isCurrent) {
    setTitle("Dashboard · " + state.project.name);
    return Promise.all([api("GET", "/api/dashboard/preferences"), state.categories.flat.length ? null : loadCategories()]).then(function (res) {
      if (!isCurrent()) return;
      state.prefs = res[0].preferences;
      var p = route.params;
      var period = p.period || state.prefs.default_period || "all_time";
      var dateFrom = p.date_from || (period === "custom" ? state.prefs.custom_range.date_from : "") || "";
      var dateTo = p.date_to || (period === "custom" ? state.prefs.custom_range.date_to : "") || "";
      var gran = p.granularity || (state.prefs.trend_granularity !== "auto" ? state.prefs.trend_granularity : "");
      var partnerId = p.partner_id || "";
      var partners = state.project.partners.filter(function (x) { return x.active !== false; });
      main.innerHTML =
        '<div class="dash-toolbar">' +
        '<select id="dash-partner" aria-label="Partner view"><option value="">All partners</option>' + partners.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === partnerId ? " selected" : "") + '>' + esc(x.name) + "'s payments</option>"; }).join("") + '</select>' +
        '<select id="dash-period" aria-label="Period">' + PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select>' +
        '<span id="dash-custom" ' + (period === "custom" ? "" : "hidden") + '><input type="date" id="dash-from" value="' + esc(dateFrom) + '"> <input type="date" id="dash-to" value="' + esc(dateTo) + '"> <button class="btn btn-sm" id="dash-apply">Apply</button></span>' +
        '<select id="dash-gran" aria-label="Trend by"><option value="">Trend: auto</option><option value="day"' + (gran === "day" ? " selected" : "") + '>Trend: day</option><option value="month"' + (gran === "month" ? " selected" : "") + '>Trend: month</option><option value="quarter"' + (gran === "quarter" ? " selected" : "") + '>Trend: quarter</option><option value="year"' + (gran === "year" ? " selected" : "") + '>Trend: year</option></select>' +
        '<span style="flex:1"></span>' + (can("dashboard:customize") ? '<button class="btn btn-sm" id="dash-customize">Widgets</button>' : "") + '<button class="btn btn-sm no-print" id="dash-print">Print</button></div>' +
        '<div class="dash-grid" id="dash-grid"><div class="empty">Loading…</div></div>';
      function go() {
        var sel = $("#dash-period").value, params = { period: sel, partner_id: $("#dash-partner").value };
        if (sel === "custom") { params.date_from = $("#dash-from").value; params.date_to = $("#dash-to").value; }
        if ($("#dash-gran").value) params.granularity = $("#dash-gran").value;
        navigate("dashboard", params);
      }
      $("#dash-period").addEventListener("change", function () { $("#dash-custom").hidden = this.value !== "custom"; if (this.value !== "custom") go(); });
      $("#dash-apply").addEventListener("click", go);
      $("#dash-gran").addEventListener("change", go);
      $("#dash-partner").addEventListener("change", go);
      $("#dash-print").addEventListener("click", function () { window.print(); });
      if ($("#dash-customize")) $("#dash-customize").addEventListener("click", openCustomise);
      var query = { period: period === "custom" ? "" : period, date_from: period === "custom" ? dateFrom : "", date_to: period === "custom" ? dateTo : "", granularity: gran, partner_id: partnerId };
      return api("GET", "/api/dashboard/summary" + qs(query)).then(function (data) { if (isCurrent()) renderWidgets(data, query, $("#dash-grid")); });
    });
  };

  function drillParams(data, extra) {
    var base = { status: "active" };
    if (data.period.date_from) base.date_from = data.period.date_from.slice(0, 10);
    if (data.period.date_to) base.date_to = data.period.date_to.slice(0, 10);
    if (data.partner_filter) base.partner_id = data.partner_filter.partner_id;
    Object.keys(extra || {}).forEach(function (k) { base[k] = extra[k]; });
    return base;
  }

  function partnerWidgetHtml(ps, filtered) {
    if (!ps.partners.length) return '<div class="empty">No partners set up. Add them under Projects &amp; partners.</div>';
    var rows = ps.partners.map(function (r) {
      var tag = r.status === "paid_more" ? '<span class="tag ok">Paid more · ' + fmtINR(r.net, 0) + ' (+' + r.pct_diff.toFixed(1) + '%)</span>'
        : r.status === "deficit" ? '<span class="tag bad">Deficit · ' + fmtINR(-r.net, 0) + ' (' + r.pct_diff.toFixed(1) + '%)</span>' : '<span class="tag">Balanced</span>';
      return '<tr class="row-link" data-partner="' + esc(r.partner_id) + '"><td data-label="Partner"><strong>' + esc(r.name) + '</strong>' + (r.active === false ? ' <span class="muted small">(inactive)</span>' : "") + '</td>' +
        '<td data-label="Share">' + r.share + '%</td><td data-label="Should bear" class="amount">' + fmtINR(r.should_bear, 0) + '</td>' +
        '<td data-label="Paid" class="amount">' + fmtINR(r.paid, 0) + ' <span class="muted small">(' + r.paid_pct.toFixed(1) + '%)</span></td>' +
        '<td data-label="Net" class="amount ' + (r.net > 0 ? "net-pos" : r.net < 0 ? "net-neg" : "") + '">' + (r.net > 0 ? "+" : "") + fmtINR(r.net, 0) + '</td><td data-label="Status">' + tag + '</td></tr>';
    }).join("");
    var settle = ps.settlements.length ? '<div class="settle">' + ps.settlements.map(function (s) { return esc(s.from) + " needs to pay " + esc(s.to) + " <span class='amount'>" + fmtINR(s.amount, 0) + "</span>"; }).join("<br>") + '</div>' : '<div class="settle">Everyone has paid their share.</div>';
    return '<div class="table-wrap"><table class="data cards partner-table"><thead><tr><th>Partner</th><th>Share</th><th class="amount">Should bear</th><th class="amount">Paid</th><th class="amount">Net</th><th>Status</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="muted small" style="margin:8px 0 0">Total ' + fmtINR(ps.total, 0) + ' · share is applied to the total of ' + (filtered ? "this period" : "all expenses") + '. Click a partner to see their payments.</p>' + settle;
  }

  function renderWidgets(data, query, grid) {
    if (!grid || !document.contains(grid)) return;
    grid.innerHTML = "";
    var layout = state.prefs.layout.filter(function (w) { return w.visible; });
    if (!layout.length) { grid.innerHTML = '<div class="empty" style="grid-column: span 12">No widgets selected. Use “Widgets” to add some.</div>'; return; }
    var names = {}; META.widgets.forEach(function (w) { names[w.id] = w.name; });
    var pf = data.partner_filter ? " (" + data.partner_filter.name + ")" : "";
    layout.forEach(function (w) {
      var el = document.createElement("section");
      el.className = "widget"; el.setAttribute("data-size", w.size); el.setAttribute("data-id", w.id); el.draggable = can("dashboard:customize");
      var head = '<div class="widget-head"><h3>' + esc(names[w.id] || w.id) + esc(w.id === "partner_summary" ? "" : pf) + '</h3>' + (el.draggable ? '<span class="widget-drag" title="Drag to reorder">⋮⋮</span>' : "") + '</div>';
      var body = "";
      switch (w.id) {
        case "total_expenses": body = '<div class="big amount">' + fmtINR(data.totals.total, 0) + '</div><div class="sub">' + esc(data.period.label) + ' · <button class="link-btn" data-drill="all">View</button></div>'; break;
        case "transaction_count": body = '<div class="big">' + data.totals.count + '</div><div class="sub">expenses · ' + esc(data.period.label) + '</div>'; break;
        case "average_expense": body = '<div class="big amount">' + fmtINR(data.totals.average, 0) + '</div><div class="sub">average per expense</div>'; break;
        case "largest_expense": body = data.largest ? '<div class="big amount">' + fmtINR(data.largest.amount, 0) + '</div><div class="sub"><button class="link-btn" data-open="' + esc(data.largest.id) + '">' + esc(data.largest.description) + '</button></div>' : '<div class="big">—</div>'; break;
        case "partner_summary": body = partnerWidgetHtml(data.partner_summary, !!(data.period.date_from || data.period.date_to)); break;
        case "monthly_trend": body = '<canvas id="c-trend"></canvas><div class="sub">By ' + esc(data.trend.granularity) + '. Click a point to drill down.</div>'; break;
        case "by_category": body = '<canvas id="c-cat"></canvas><ul class="bar-list" id="l-cat" style="margin-top:10px"></ul>'; break;
        case "by_subcategory": body = data.by_subcategory.length ? '<ul class="bar-list" id="l-sub"></ul>' : '<div class="empty">No subcategory data</div>'; break;
        case "by_partner_chart": body = '<canvas id="c-partner" style="height:200px"></canvas><div class="legend" id="lg-partner"></div>'; break;
        case "by_payment_method": body = '<canvas id="c-pay" style="height:200px"></canvas><div class="legend" id="lg-pay"></div>'; break;
        case "top_vendors": body = data.top_vendors.length ? '<ul class="bar-list" id="l-vendor"></ul>' : '<div class="empty">No vendor data</div>'; break;
        case "recent_transactions":
          body = data.recent.length ? '<div class="table-wrap"><table class="data cards"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Paid by</th><th class="amount">Amount</th></tr></thead><tbody>' +
            data.recent.map(function (e) { return '<tr class="row-link" data-open="' + esc(e.id) + '"><td data-label="Date">' + fmtDate(e.transaction_date) + '</td><td data-label="Description">' + esc(e.description) + '</td><td data-label="Category">' + esc((e.category_path || []).join(" > ")) + '</td><td data-label="Paid by">' + esc(paidByText(e)) + '</td><td class="amount" data-label="Amount">' + fmtINR(e.amount) + '</td></tr>'; }).join("") + '</tbody></table></div>'
            : '<div class="empty">No expenses yet. <button class="link-btn" data-add="1">Add the first one</button></div>'; break;
      }
      el.innerHTML = head + body;
      grid.appendChild(el);
    });
    var c;
    if ((c = $("#c-trend"))) {
      var draw = data.trend.points.length > 1 ? Charts.line : Charts.bar;
      draw(c, data.trend.points.map(function (x) { return x.label; }), data.trend.points.map(function (x) { return x.total; }), { onClick: function (i) { drillTrend(data.trend.granularity, data.trend.points[i].label, data); } });
    }
    if ((c = $("#c-cat"))) {
      var onCat = function (i) { navigate("expenses", drillParams(data, { category_id: data.by_category[i].category_id })); };
      (state.prefs.chart_type_category === "donut" ? Charts.donut : Charts.bar)(c, data.by_category.map(function (x) { return x.name; }), data.by_category.map(function (x) { return x.total; }), { multicolor: true, onClick: onCat });
      barList($("#l-cat"), data.by_category, function (x) { return x.name; }, function (x) { navigate("expenses", drillParams(data, { category_id: x.category_id })); });
    }
    if ($("#l-sub")) barList($("#l-sub"), data.by_subcategory, function (x) { return x.name; }, function (x) { navigate("expenses", drillParams(data, { category_id: x.category_id, subcategory_id: x.subcategory_id })); });
    if ($("#l-vendor")) barList($("#l-vendor"), data.top_vendors, function (x) { return x.vendor; }, function (x) { navigate("expenses", drillParams(data, { vendor: x.vendor })); });
    if ((c = $("#c-partner"))) {
      var ps = data.partner_summary.partners;
      Charts.donut(c, ps.map(function (x) { return x.name; }), ps.map(function (x) { return x.paid; }), { onClick: function (i) { navigate("expenses", drillParams(data, { partner_id: ps[i].partner_id })); } });
      $("#lg-partner").innerHTML = ps.map(function (x, i) { return '<span style="--c: var(--chart-' + ((i % 8) + 1) + ')">' + esc(x.name) + " " + fmtINR(x.paid, 0) + '</span>'; }).join("");
    }
    if ((c = $("#c-pay"))) {
      Charts.donut(c, data.by_payment_method.map(function (x) { return x.name; }), data.by_payment_method.map(function (x) { return x.total; }), { onClick: function (i) { var m = data.by_payment_method[i].name; navigate("expenses", drillParams(data, m === "Not specified" ? {} : { payment_method: m })); } });
      $("#lg-pay").innerHTML = data.by_payment_method.map(function (x, i) { return '<span style="--c: var(--chart-' + ((i % 8) + 1) + ')">' + esc(x.name) + " " + fmtINR(x.total, 0) + '</span>'; }).join("");
    }
    grid.__data = data;
    if (!grid.__bound) {
      grid.__bound = true;
      grid.addEventListener("click", function (e) {
        var t = e.target.closest("[data-drill], [data-open], [data-add], [data-partner]");
        if (!t) return;
        var d = grid.__data;
        if (t.hasAttribute("data-open")) openExpenseDetail(t.getAttribute("data-open"));
        else if (t.hasAttribute("data-add")) openExpenseForm(null);
        else if (t.hasAttribute("data-partner")) navigate("expenses", drillParams(d, { partner_id: t.getAttribute("data-partner") }));
        else navigate("expenses", drillParams(d));
      });
      setupWidgetDrag(grid);
      var lastW = grid.getBoundingClientRect().width;
      var redraw = debounce(function () { if (!document.contains(grid)) return; var w = grid.getBoundingClientRect().width; if (Math.abs(w - lastW) < 2) return; lastW = w; renderWidgets(grid.__data, query, grid); }, 200);
      if (global.ResizeObserver) { grid.__ro = new ResizeObserver(function () { if (document.contains(grid)) redraw(); else grid.__ro.disconnect(); }); grid.__ro.observe(grid); }
    }
  }

  function drillTrend(granularity, label, data) {
    var params = { period: "custom", partner_id: data.partner_filter ? data.partner_filter.partner_id : "" };
    if (granularity === "year") { params.date_from = label + "-01-01"; params.date_to = label + "-12-31"; params.granularity = "month"; navigate("dashboard", params); }
    else if (granularity === "quarter") { var y = +label.slice(0, 4), q = +label.slice(6); params.date_from = y + "-" + String((q - 1) * 3 + 1).padStart(2, "0") + "-01"; params.date_to = isoDate(new Date(Date.UTC(y, q * 3, 0))); params.granularity = "month"; navigate("dashboard", params); }
    else if (granularity === "month") { var yy = +label.slice(0, 4), mm = +label.slice(5, 7); params.date_from = label + "-01"; params.date_to = isoDate(new Date(Date.UTC(yy, mm, 0))); params.granularity = "day"; navigate("dashboard", params); }
    else navigate("expenses", drillParams(data, { date_from: label, date_to: label }));
  }

  function barList(ul, rows, labelFn, onClick) {
    if (!ul) return;
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; }).concat([1]));
    ul.innerHTML = rows.slice(0, 10).map(function (r, i) { return '<li data-i="' + i + '" tabindex="0"><span class="label">' + esc(labelFn(r)) + '</span><span class="amount">' + fmtINR(r.total, 0) + ' <span class="muted small">(' + r.count + ')</span></span><span class="track"><span class="fill" style="width:' + (r.total / max * 100) + '%"></span></span></li>'; }).join("");
    ul.addEventListener("click", function (e) { var li = e.target.closest("li"); if (li) onClick(rows[+li.getAttribute("data-i")]); });
  }

  function setupWidgetDrag(grid) {
    if (!can("dashboard:customize")) return;
    var dragging = null;
    grid.addEventListener("dragstart", function (e) { dragging = e.target.closest(".widget"); if (dragging) { dragging.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; } });
    grid.addEventListener("dragover", function (e) { var t = e.target.closest(".widget"); if (t && dragging && t !== dragging) { e.preventDefault(); t.classList.add("drop-target"); } });
    grid.addEventListener("dragleave", function (e) { var t = e.target.closest(".widget"); if (t) t.classList.remove("drop-target"); });
    grid.addEventListener("drop", function (e) {
      var t = e.target.closest(".widget");
      if (!t || !dragging || t === dragging) return;
      e.preventDefault(); t.classList.remove("drop-target");
      var items = $$(".widget", grid);
      if (items.indexOf(dragging) < items.indexOf(t)) t.after(dragging); else t.before(dragging);
      var order = $$(".widget", grid).map(function (w) { return w.getAttribute("data-id"); });
      state.prefs.layout = order.map(function (id) { return state.prefs.layout.filter(function (l) { return l.id === id; })[0]; }).concat(state.prefs.layout.filter(function (l) { return !l.visible; }));
      api("PUT", "/api/dashboard/preferences", state.prefs).then(function (d) { state.prefs = d.preferences; toast("Layout saved.", "ok"); }).catch(fail);
    });
    grid.addEventListener("dragend", function () { if (dragging) dragging.classList.remove("is-dragging"); $$(".drop-target", grid).forEach(function (x) { x.classList.remove("drop-target"); }); dragging = null; });
  }

  function openCustomise() {
    var prefs = JSON.parse(JSON.stringify(state.prefs));
    META.widgets.forEach(function (w) { if (!prefs.layout.some(function (l) { return l.id === w.id; })) prefs.layout.push({ id: w.id, visible: false, size: w.size }); });
    var names = {}; META.widgets.forEach(function (w) { names[w.id] = w.name; });
    var body = openModal("Dashboard widgets",
      '<p class="muted small">Tick what you want to see, use the arrows to reorder, pick a size.</p><ul class="widget-pick" id="wp"></ul>' +
      '<div class="form-grid" style="margin-top:16px"><div class="field"><label for="pref-period">Default period</label><select id="pref-period">' + PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === prefs.default_period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label for="pref-cat-chart">Category chart</label><select id="pref-cat-chart"><option value="bar"' + (prefs.chart_type_category === "bar" ? " selected" : "") + '>Bars</option><option value="donut"' + (prefs.chart_type_category === "donut" ? " selected" : "") + '>Donut</option></select></div></div>' +
      '<div class="btn-row end"><button class="btn" id="pref-reset">Reset</button><button class="btn" id="pref-cancel">Cancel</button><button class="btn btn-primary" id="pref-save">Save</button></div>');
    var ul = $("#wp", body);
    function draw() {
      ul.innerHTML = prefs.layout.map(function (l, i) {
        return '<li><span class="widget-drag">⋮⋮</span><label><input type="checkbox" data-vis="' + i + '"' + (l.visible ? " checked" : "") + '> ' + esc(names[l.id]) + '</label><select data-size="' + i + '">' + ["small", "medium", "large"].map(function (s) { return '<option value="' + s + '"' + (s === l.size ? " selected" : "") + '>' + s + '</option>'; }).join("") + '</select>' +
          '<span><button class="link-btn" data-up="' + i + '">↑</button><button class="link-btn" data-down="' + i + '">↓</button></span></li>';
      }).join("");
    }
    draw();
    ul.addEventListener("change", function (e) {
      if (e.target.hasAttribute("data-vis")) prefs.layout[+e.target.getAttribute("data-vis")].visible = e.target.checked;
      if (e.target.hasAttribute("data-size")) prefs.layout[+e.target.getAttribute("data-size")].size = e.target.value;
    });
    ul.addEventListener("click", function (e) {
      var up = e.target.closest("[data-up]"), down = e.target.closest("[data-down]");
      if (up) { var i = +up.getAttribute("data-up"); if (i > 0) { var t = prefs.layout[i]; prefs.layout[i] = prefs.layout[i - 1]; prefs.layout[i - 1] = t; draw(); } }
      if (down) { var j = +down.getAttribute("data-down"); if (j < prefs.layout.length - 1) { var u = prefs.layout[j]; prefs.layout[j] = prefs.layout[j + 1]; prefs.layout[j + 1] = u; draw(); } }
    });
    $("#pref-cancel", body).addEventListener("click", closeModal);
    $("#pref-reset", body).addEventListener("click", function () { api("DELETE", "/api/dashboard/preferences").then(function () { closeModal(); render(); }).catch(fail); });
    $("#pref-save", body).addEventListener("click", function () {
      prefs.default_period = $("#pref-period", body).value; prefs.chart_type_category = $("#pref-cat-chart", body).value;
      api("PUT", "/api/dashboard/preferences", prefs).then(function () { closeModal(); toast("Saved.", "ok"); render(); }).catch(fail);
    });
  }

  // =================================================================== EXPENSES
  views.expenses = function (main, route, isCurrent) {
    setTitle("Expenses · " + state.project.name);
    var p = route.params;
    return Promise.all([state.categories.flat.length ? null : loadCategories(), api("GET", "/api/expenses/meta"), api("GET", "/api/filters")]).then(function (res) {
      if (!isCurrent()) return;
      state.expenseMeta = res[1]; state.savedFilters = res[2].filters;
      var partners = state.project.partners;
      var cfg = state.project.field_config || {};
      var topCat = p.category_id && !Array.isArray(p.category_id) ? p.category_id : "";
      main.innerHTML =
        '<div class="panel"><div class="filters">' +
        '<div class="f span-2"><label for="f-q">Search</label><input id="f-q" type="search" placeholder="ID, description, vendor, notes…" value="' + esc(p.q || "") + '"></div>' +
        '<div class="f"><label for="f-cat">Category</label><select id="f-cat">' + topOptions(topCat, "All categories") + '</select></div>' +
        '<div class="f"><label for="f-sub">Subcategory</label><select id="f-sub">' + subOptions(topCat, p.subcategory_id, "All subcategories") + '</select></div>' +
        '<div class="f"><label for="f-partner">Paid by</label><select id="f-partner"><option value="">Anyone</option>' + partners.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === p.partner_id ? " selected" : "") + '>' + esc(x.name) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="f-from">From</label><input id="f-from" type="date" value="' + esc(p.date_from || "") + '"></div>' +
        '<div class="f"><label for="f-to">To</label><input id="f-to" type="date" value="' + esc(p.date_to || "") + '"></div>' +
        '<div class="f"><label for="f-status">Records</label><select id="f-status"><option value="active">Active</option><option value="edited"' + (p.status === "edited" ? " selected" : "") + '>Edited only</option>' + (can("expense:view_deleted") ? '<option value="deleted"' + (p.status === "deleted" ? " selected" : "") + '>Deleted</option><option value="all"' + (p.status === "all" ? " selected" : "") + '>All</option>' : "") + '</select></div>' +
        '</div><details class="adv"' + ((p.min_amount || p.max_amount || p.vendor || p.payment_method) ? " open" : "") + '><summary>More filters</summary><div class="filters">' +
        '<div class="f"><label for="f-min">Min amount</label><input id="f-min" type="number" min="0" value="' + esc(p.min_amount || "") + '"></div>' +
        '<div class="f"><label for="f-max">Max amount</label><input id="f-max" type="number" min="0" value="' + esc(p.max_amount || "") + '"></div>' +
        (cfg.vendor && cfg.vendor.enabled ? '<div class="f"><label for="f-vendor">Vendor</label><input id="f-vendor" list="vendor-list" value="' + esc(p.vendor || "") + '"><datalist id="vendor-list">' + state.expenseMeta.vendors.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist></div>' : "") +
        (cfg.payment_method && cfg.payment_method.enabled ? '<div class="f"><label for="f-pm">Payment method</label><select id="f-pm"><option value="">Any</option>' + META.payment_methods.map(function (m) { return '<option' + (m === p.payment_method ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' : "") +
        '<div class="f"><label for="f-logic">Category match</label><select id="f-logic"><option value="all">Category AND subcategory</option><option value="any"' + (p.logic === "any" ? " selected" : "") + '>Either (OR)</option></select></div>' +
        '</div></details><div class="filters-foot"><button class="btn btn-primary btn-sm" id="f-apply">Apply</button><button class="btn btn-sm" id="f-clear">Clear</button>' +
        '<select id="f-saved" aria-label="Saved filters"><option value="">Saved filters…</option>' + state.savedFilters.map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>'; }).join("") + '</select><button class="btn btn-sm" id="f-save">Save filter</button><button class="btn btn-sm" id="f-del" hidden>Delete saved</button>' +
        '<span class="spacer"></span>' + (can("export") ? '<a class="btn btn-sm" id="f-csv" href="' + fileUrl("/api/reports/expenses.csv", p) + '">CSV</a><a class="btn btn-sm" href="' + fileUrl("/api/reports/expenses.pdf", p) + '">PDF</a>' : "") + '</div></div>' +
        '<div class="panel"><div id="chips" class="chips"></div><div class="result-bar"><span id="result-count"></span><span id="result-total" class="amount"></span></div><div class="table-wrap" id="exp-table"></div><div class="pager" id="pager"></div></div>';
      $("#f-cat").addEventListener("change", function () { $("#f-sub").innerHTML = subOptions(this.value, "", "All subcategories"); });
      function collect() {
        var o = { q: $("#f-q").value.trim(), category_id: $("#f-cat").value, subcategory_id: $("#f-sub").value, partner_id: $("#f-partner").value, date_from: $("#f-from").value, date_to: $("#f-to").value,
          min_amount: $("#f-min").value, max_amount: $("#f-max").value, status: $("#f-status").value, logic: $("#f-logic").value, sort: p.sort, order: p.order, per_page: p.per_page };
        if ($("#f-vendor")) o.vendor = $("#f-vendor").value.trim();
        if ($("#f-pm")) o.payment_method = $("#f-pm").value;
        return o;
      }
      $("#f-apply").addEventListener("click", function () { navigate("expenses", collect()); });
      $("#f-q").addEventListener("keydown", function (e) { if (e.key === "Enter") navigate("expenses", collect()); });
      $("#f-clear").addEventListener("click", function () { navigate("expenses", {}); });
      $("#f-saved").addEventListener("change", function () { var f = state.savedFilters.filter(function (x) { return x.id === $("#f-saved").value; })[0]; $("#f-del").hidden = !f; if (f) navigate("expenses", f.params); });
      $("#f-del").addEventListener("click", function () {
        var f = state.savedFilters.filter(function (x) { return x.id === $("#f-saved").value; })[0];
        if (f && confirm("Delete saved filter “" + f.name + "”?")) api("DELETE", "/api/filters/" + f.id).then(function () { toast("Filter deleted.", "ok"); navigate("expenses", {}); render(); }).catch(fail);
      });
      $("#f-save").addEventListener("click", function () { var name = prompt("Name this filter"); if (name) api("POST", "/api/filters", { name: name.trim(), params: collect() }).then(function () { toast("Filter saved.", "ok"); render(); }).catch(fail); });
      var chipKeys = { q: "Search", category_id: "Category", subcategory_id: "Subcategory", partner_id: "Paid by", date_from: "From", date_to: "To", min_amount: "Min", max_amount: "Max", vendor: "Vendor", payment_method: "Method", status: "Records" };
      $("#chips").innerHTML = Object.keys(chipKeys).filter(function (k) { return p[k] && !(k === "status" && p[k] === "active"); }).map(function (k) {
        var v = [].concat(p[k]).map(function (x) { return k === "category_id" || k === "subcategory_id" ? categoryName(x) : k === "partner_id" ? partnerName(x) : x; }).join(", ");
        return '<button class="chip" data-chip="' + esc(k) + '">' + esc(chipKeys[k]) + ': ' + esc(v) + ' <span class="x">×</span></button>';
      }).join("");
      $("#chips").addEventListener("click", function (e) {
        var c = e.target.closest("[data-chip]"); if (!c) return;
        var np = {}; Object.keys(p).forEach(function (k) { if (k !== c.getAttribute("data-chip") && k !== "page") np[k] = p[k]; });
        if (c.getAttribute("data-chip") === "category_id") delete np.subcategory_id;
        navigate("expenses", np);
      });
      return loadExpenseTable(p, isCurrent);
    });
  };

  function loadExpenseTable(p, isCurrent) {
    return api("GET", "/api/expenses" + qs(p)).then(function (d) {
      if (!isCurrent()) return;
      $("#result-count").textContent = d.total_count + " expense" + (d.total_count === 1 ? "" : "s");
      $("#result-total").textContent = "Total " + fmtINR(d.total_amount);
      var sort = p.sort || "transaction_date", order = p.order || "desc";
      function th(key, label, cls) { return '<th class="sortable ' + (cls || "") + (sort === key ? " sorted-" + order : "") + '" data-sort="' + key + '">' + label + '</th>'; }
      var wrap = $("#exp-table");
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty">No expenses match.' + (can("expense:create") ? ' <button class="link-btn" id="empty-add">Add an expense</button>' : "") + '</div>';
        if ($("#empty-add")) $("#empty-add").addEventListener("click", function () { openExpenseForm(null); });
      } else {
        wrap.innerHTML = '<table class="data cards"><thead><tr>' + th("expense_id", "ID") + th("transaction_date", "Date") + th("description", "Description") + th("category_path", "Category") + '<th>Paid by</th><th>Status</th>' + th("amount", "Amount", "amount") + '</tr></thead><tbody>' +
          d.items.map(function (e) {
            var status = e.status === "deleted" ? '<span class="tag bad">Deleted</span>' : (e.revision > 1 ? '<span class="tag warn">Edited ×' + (e.revision - 1) + '</span>' : '<span class="tag ok">Active</span>');
            return '<tr class="row-link' + (e.status === "deleted" ? " deleted" : "") + '" data-open="' + esc(e.id) + '"><td data-label="ID" class="nowrap">' + esc(e.expense_id) + '</td><td data-label="Date" class="nowrap">' + fmtDate(e.transaction_date) + '</td>' +
              '<td data-label="Description" class="desc">' + esc(e.description) + '</td><td data-label="Category">' + esc((e.category_path || []).join(" > ")) + '</td><td data-label="Paid by">' + esc(paidByText(e)) + '</td><td data-label="Status">' + status + '</td><td data-label="Amount" class="amount">' + fmtINR(e.amount) + '</td></tr>';
          }).join("") + '</tbody></table>';
        wrap.addEventListener("click", function (e) {
          var s = e.target.closest("[data-sort]");
          if (s) { var k = s.getAttribute("data-sort"); navigate("expenses", Object.assign({}, p, { sort: k, order: sort === k && order === "desc" ? "asc" : "desc", page: 1 })); return; }
          var row = e.target.closest("[data-open]"); if (row) openExpenseDetail(row.getAttribute("data-open"));
        });
      }
      $("#pager").innerHTML = '<label class="small muted">Per page <select id="per-page">' + [10, 25, 50, 100, 200].map(function (n) { return '<option' + (n === d.per_page ? " selected" : "") + '>' + n + '</option>'; }).join("") + '</select></label>' +
        '<button class="btn btn-sm" id="pg-prev"' + (d.page <= 1 ? " disabled" : "") + '>‹ Prev</button><span class="small">Page ' + d.page + ' of ' + d.pages + '</span><button class="btn btn-sm" id="pg-next"' + (d.page >= d.pages ? " disabled" : "") + '>Next ›</button>';
      $("#per-page").addEventListener("change", function () { navigate("expenses", Object.assign({}, p, { per_page: this.value, page: 1 })); });
      $("#pg-prev").addEventListener("click", function () { navigate("expenses", Object.assign({}, p, { page: d.page - 1 })); });
      $("#pg-next").addEventListener("click", function () { navigate("expenses", Object.assign({}, p, { page: d.page + 1 })); });
    });
  }

  // ---------------- expense form: category → subcategory, split payment, configurable fields
  function openExpenseForm(existing) {
    var proj = state.project;
    var ready = state.categories.flat.length ? Promise.resolve() : loadCategories();
    ready.then(function () {
      var e = existing || {};
      var cfg = proj.field_config || {};
      var partners = proj.partners.filter(function (x) { return x.active !== false || (e.payments || []).some(function (pp) { return pp.partner_id === x.id; }); });
      var paid = {}; (e.payments || []).forEach(function (pp) { paid[pp.partner_id] = pp.amount; });
      function optField(key, label, html) { return cfg[key] && cfg[key].enabled ? '<div class="field"><label for="x-' + key + '"' + (cfg[key].required ? ' class="required"' : "") + '>' + esc(label) + '</label>' + html + '</div>' : ""; }
      function sel(key, options) { return '<select id="x-' + key + '"><option value="">Not specified</option>' + options.map(function (m) { return '<option' + (m === e[key] ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select>'; }
      var customHtml = (proj.custom_fields || []).map(function (f) {
        var v = (e.custom || {})[f.key]; v = v === undefined || v === null ? "" : v;
        var input = f.type === "select" ? '<select id="cf-' + f.key + '"><option value="">Choose…</option>' + f.options.map(function (o) { return '<option' + (o === v ? " selected" : "") + '>' + esc(o) + '</option>'; }).join("") + '</select>'
          : '<input id="cf-' + f.key + '" type="' + (f.type === "number" ? "number" : f.type === "date" ? "date" : "text") + '" value="' + esc(v) + '"' + (f.type === "number" ? ' step="any"' : "") + '>';
        return '<div class="field"><label for="cf-' + f.key + '"' + (f.required ? ' class="required"' : "") + '>' + esc(f.label) + '</label>' + input + '</div>';
      }).join("");
      var body = openModal(existing ? "Edit " + e.expense_id : "Add expense",
        '<form id="exp-form" novalidate><div class="form-grid">' +
        '<div class="field span-2"><label class="required" for="x-desc">Description</label><input id="x-desc" maxlength="300" value="' + esc(e.description || "") + '"></div>' +
        '<div class="field"><label class="required" for="x-amount">Amount (₹)</label><input id="x-amount" type="number" inputmode="decimal" min="0.01" step="0.01" value="' + esc(e.amount || "") + '"></div>' +
        '<div class="field"><label class="required" for="x-date">Date</label><input id="x-date" type="date" max="' + todayISO() + '" value="' + esc(e.transaction_date ? e.transaction_date.slice(0, 10) : todayISO()) + '"></div>' +
        '<div class="field"><label class="required" for="x-cat">Category</label><div class="inline-add"><select id="x-cat">' + topOptions(e.category_id) + '</select>' + (can("category:manage") ? '<button type="button" class="btn btn-sm" id="x-cat-add">+ New</button>' : "") + '</div></div>' +
        '<div class="field"><label for="x-sub">Subcategory</label><div class="inline-add"><select id="x-sub">' + subOptions(e.category_id, e.subcategory_id) + '</select>' + (can("category:manage") ? '<button type="button" class="btn btn-sm" id="x-sub-add">+ New</button>' : "") + '</div></div>' +
        '<div class="field span-2"><label class="required">Paid by</label><div class="split-rows" id="split">' +
        partners.map(function (x) { return '<div class="split-row"><span class="name">' + esc(x.name) + (x.active === false ? ' <span class="muted small">(inactive)</span>' : "") + '</span><input type="number" inputmode="decimal" min="0" step="0.01" data-partner="' + esc(x.id) + '" value="' + (paid[x.id] || "") + '" placeholder="0"><button type="button" class="link-btn" data-full="' + esc(x.id) + '">Paid all</button></div>'; }).join("") +
        '</div><div class="split-status" id="split-status"></div></div>' +
        optField("vendor", "Vendor / payee", '<input id="x-vendor" list="x-vendor-list" maxlength="120" value="' + esc(e.vendor || "") + '"><datalist id="x-vendor-list">' + state.expenseMeta.vendors.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist>') +
        optField("payment_method", "Payment method", sel("payment_method", META.payment_methods)) +
        optField("payment_reference", "Payment reference", '<input id="x-payment_reference" maxlength="120" value="' + esc(e.payment_reference || "") + '">') +
        optField("payment_status", "Payment status", sel("payment_status", META.payment_statuses)) +
        optField("expense_type", "Expense type", sel("expense_type", META.expense_types)) +
        optField("project_phase", "Phase", '<input id="x-project_phase" list="x-phase-list" maxlength="120" value="' + esc(e.project_phase || "") + '"><datalist id="x-phase-list">' + state.expenseMeta.phases.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist>') +
        optField("receipt_reference", "Receipt / invoice reference", '<input id="x-receipt_reference" maxlength="120" value="' + esc(e.receipt_reference || "") + '">') +
        customHtml +
        (cfg.notes && cfg.notes.enabled ? '<div class="field span-2"><label for="x-notes"' + (cfg.notes.required ? ' class="required"' : "") + '>Notes</label><textarea id="x-notes" maxlength="2000">' + esc(e.notes || "") + '</textarea></div>' : "") +
        (existing ? '<div class="field span-2"><label class="required" for="x-reason">Reason for this change</label><input id="x-reason" maxlength="300" placeholder="e.g. Wrong amount entered"></div>' : "") +
        '</div><p class="form-error" id="x-error" hidden></p><div class="btn-row end"><button type="button" class="btn" id="x-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="x-save">' + (existing ? "Save changes" : "Add expense") + '</button></div></form>', { wide: true });

      // category → subcategory, inline add
      $("#x-cat", body).addEventListener("change", function () { $("#x-sub", body).innerHTML = subOptions(this.value, ""); });
      if ($("#x-cat-add", body)) $("#x-cat-add", body).addEventListener("click", function () { quickAddCategory(null, function (c) { $("#x-cat", body).innerHTML = topOptions(c.id); $("#x-sub", body).innerHTML = subOptions(c.id, ""); }); });
      if ($("#x-sub-add", body)) $("#x-sub-add", body).addEventListener("click", function () {
        var parent = $("#x-cat", body).value;
        if (!parent) { toast("Choose a category first.", "error"); return; }
        quickAddCategory(parent, function (c) { $("#x-sub", body).innerHTML = subOptions(parent, c.id); });
      });

      // split payment: auto-fill the remaining amount into the last empty partner
      var inputs = $$("#split input", body);
      function amount() { return parseFloat($("#x-amount", body).value) || 0; }
      function sumPaid() { return inputs.reduce(function (a, i) { return a + (parseFloat(i.value) || 0); }, 0); }
      function autofill(changed) {
        var total = amount();
        if (!total) return;
        var empties = inputs.filter(function (i) { return i !== changed && i.value === ""; });
        if (empties.length === 1) {
          var rem = Math.round((total - sumPaid()) * 100) / 100;
          if (rem >= 0) empties[0].value = rem ? rem : "";
        }
        showStatus();
      }
      function showStatus() {
        var total = amount(), s = Math.round(sumPaid() * 100) / 100, st = $("#split-status", body);
        if (!total) { st.textContent = "Enter the amount first."; st.className = "split-status"; return; }
        var diff = Math.round((total - s) * 100) / 100;
        if (Math.abs(diff) < 0.01) { st.textContent = "Split matches the amount."; st.className = "split-status ok"; }
        else if (diff > 0) { st.textContent = fmtINR(diff) + " still to be assigned."; st.className = "split-status bad"; }
        else { st.textContent = "Split is " + fmtINR(-diff) + " more than the amount."; st.className = "split-status bad"; }
      }
      inputs.forEach(function (i) { i.addEventListener("input", function () { autofill(i); }); });
      $("#x-amount", body).addEventListener("input", function () {
        var filled = inputs.filter(function (i) { return i.value !== ""; });
        if (filled.length === 1 && inputs.length === 1) filled[0].value = amount() || "";
        autofill(null);
      });
      $$("[data-full]", body).forEach(function (b) { b.addEventListener("click", function () { inputs.forEach(function (i) { i.value = i.getAttribute("data-partner") === b.getAttribute("data-full") ? (amount() || "") : ""; }); showStatus(); }); });
      if (inputs.length === 1 && !existing) inputs[0].value = "";
      showStatus();

      $("#x-cancel", body).addEventListener("click", closeModal);
      var idemKey = uuid();
      $("#exp-form", body).addEventListener("submit", function (ev) {
        ev.preventDefault();
        var err = $("#x-error", body); err.hidden = true;
        var payload = { description: $("#x-desc", body).value.trim(), amount: $("#x-amount", body).value, transaction_date: $("#x-date", body).value,
          category_id: $("#x-cat", body).value, subcategory_id: $("#x-sub", body).value, payments: inputs.map(function (i) { return { partner_id: i.getAttribute("data-partner"), amount: i.value || 0 }; }), custom: {} };
        META.optional_fields.forEach(function (f) { var el = $("#x-" + f[0], body); if (el) payload[f[0]] = el.value.trim(); });
        (proj.custom_fields || []).forEach(function (f) { var el = $("#cf-" + f.key, body); if (el) payload.custom[f.key] = el.value; });
        var problems = [];
        if (payload.description.length < 2) problems.push("Description is required.");
        if (!(parseFloat(payload.amount) > 0)) problems.push("Enter an amount greater than 0.");
        if (!payload.transaction_date) problems.push("Choose a date.");
        if (!payload.category_id) problems.push("Choose a category.");
        if (Math.abs(sumPaid() - amount()) > 0.01) problems.push("Who-paid split must equal the amount.");
        if (existing) { payload.reason = $("#x-reason", body).value.trim(); if (payload.reason.length < 3) problems.push("Give a reason for the change."); payload.expected_revision = e.revision; }
        if (problems.length) { err.textContent = problems.join(" "); err.hidden = false; return; }
        var btn = $("#x-save", body); btn.disabled = true;
        (existing ? api("PUT", "/api/expenses/" + e.id, payload) : api("POST", "/api/expenses", payload, { headers: { "Idempotency-Key": idemKey } }))
          .then(function (d) { closeModal(); toast(existing ? (Object.keys(d.changes || {}).length ? "Expense updated." : "No changes made.") : d.expense.expense_id + " added.", "ok"); render(); })
          .catch(function (er) { btn.disabled = false; err.textContent = er.message; err.hidden = false; });
      });
    }).catch(fail);
  }

  function openExpenseDetail(id) {
    api("GET", "/api/expenses/" + id).then(function (d) {
      var e = d.expense, proj = state.project, cfg = (proj && proj.field_config) || {};
      var fields = [["Expense ID", e.expense_id], ["Date", fmtDate(e.transaction_date)], ["Amount", fmtINR(e.amount)], ["Category", (e.category_path || []).join(" > ")], ["Paid by", paidByText(e)]];
      META.optional_fields.forEach(function (f) { if ((cfg[f[0]] && cfg[f[0]].enabled) || e[f[0]]) fields.push([f[1], e[f[0]]]); });
      ((proj && proj.custom_fields) || []).forEach(function (f) { fields.push([f.label, (e.custom || {})[f.key]]); });
      fields.push(["Created by", e.created_by_name + " · " + fmtDateTime(e.created_at)], ["Last updated", fmtDateTime(e.updated_at) + (e.modified_by_name ? " by " + e.modified_by_name : "")], ["Revision", e.revision]);
      var status = e.status === "deleted" ? '<div class="notice danger">Deleted by ' + esc(e.deleted_by_name) + ' on ' + fmtDateTime(e.deleted_at) + '. Reason: ' + esc(e.deletion_reason) + '</div>' : "";
      var timeline = d.revisions.map(function (r) {
        var diff = Object.keys(r.changes || {}).filter(function (k) { return k !== "category_path"; }).map(function (k) { return '<li><strong>' + esc(fieldLabel(k)) + ':</strong> <span class="from">' + esc(fmtValue(k, r.changes[k].from)) + '</span> → <span class="to">' + esc(fmtValue(k, r.changes[k].to)) + '</span></li>'; }).join("");
        var verb = { create: "Created", edit: "Edited", delete: "Deleted", restore: "Restored" }[r.action] || r.action;
        return '<li class="' + esc(r.action) + '"><div><strong>Rev ' + r.revision + ' · ' + verb + '</strong> by ' + esc(r.user_name) + '</div><div class="when">' + fmtDateTime(r.at) + '</div>' + (r.reason && r.action !== "create" ? '<div class="reason">“' + esc(r.reason) + '”</div>' : "") + (diff ? '<ul class="diff">' + diff + '</ul>' : "") + '</li>';
      }).join("");
      var actions = [];
      if (e.status === "active" && can("expense:edit")) actions.push('<button class="btn" id="d-edit">Edit</button>');
      if (e.status === "active" && can("expense:delete")) actions.push('<button class="btn btn-danger" id="d-delete">Delete</button>');
      if (e.status === "deleted" && can("expense:restore")) actions.push('<button class="btn btn-primary" id="d-restore">Restore</button>');
      if (e.status === "deleted" && can("expense:purge")) actions.push('<button class="btn btn-danger" id="d-purge">Delete permanently</button>');
      var body = openModal(e.description, status + '<dl class="detail-grid">' + fields.map(function (f) { return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1] === 0 ? "0" : (f[1] || "—")) + '</dd></div>'; }).join("") + '</dl>' +
        '<div class="btn-row" style="margin:8px 0 18px">' + actions.join("") + '</div><h3>History</h3><ul class="timeline">' + timeline + '</ul>', { wide: true });
      var b;
      if ((b = $("#d-edit", body))) b.addEventListener("click", function () { openExpenseForm(e); });
      if ((b = $("#d-delete", body))) b.addEventListener("click", function () { askReason("Delete " + e.expense_id, "The record is kept for auditing and can be restored.", "Delete", true).then(function (r) { if (r) api("DELETE", "/api/expenses/" + e.id, { reason: r }).then(function () { toast("Deleted.", "ok"); render(); }).catch(fail); }); });
      if ((b = $("#d-restore", body))) b.addEventListener("click", function () { askReason("Restore " + e.expense_id, "The expense will count again.", "Restore").then(function (r) { if (r) api("POST", "/api/expenses/" + e.id + "/restore", { reason: r }).then(function () { toast("Restored.", "ok"); render(); }).catch(fail); }); });
      if ((b = $("#d-purge", body))) b.addEventListener("click", function () { askReason("Permanently delete " + e.expense_id, "This cannot be undone.", "Delete permanently", true).then(function (r) { if (r) api("DELETE", "/api/expenses/" + e.id, { reason: r, permanent: true }).then(function () { toast("Removed.", "ok"); render(); }).catch(fail); }); });
    }).catch(fail);
  }

  global.EM = { $: $, $$: $$, esc: esc, fmtINR: fmtINR, fmtDate: fmtDate, fmtDateTime: fmtDateTime, can: can, api: api, fail: fail, toast: toast, openModal: openModal, closeModal: closeModal,
    askReason: askReason, navigate: navigate, qs: qs, setTitle: setTitle, render: render, state: state, USER: USER, META: META, views: views, loadCategories: loadCategories,
    topOptions: topOptions, subOptions: subOptions, categoryName: categoryName, openExpenseDetail: openExpenseDetail, openExpenseForm: openExpenseForm, openChangePassword: openChangePassword,
    PERIODS: PERIODS, fileUrl: fileUrl, refreshProject: refreshProject, setProject: setProject, paidByText: paidByText };

  document.addEventListener("DOMContentLoaded", function () {
    setupShell();
    loadProjects().then(render).catch(function (err) { fail(err); render(); });
  });
})(window);
