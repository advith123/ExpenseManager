/* Restaurant Expense Manager — frontend core (vanilla JS, no frameworks) */
(function (global) {
  "use strict";

  var USER = JSON.parse(document.getElementById("bootstrap-user").textContent);
  var META = JSON.parse(document.getElementById("bootstrap-meta").textContent);
  var CSRF = document.querySelector('meta[name="csrf-token"]').getAttribute("content");

  var state = {
    categories: { flat: [], tree: [] },
    prefs: null,
    savedFilters: [],
    expenseMeta: { vendors: [], phases: [], years: [] },
    lastExpenseQuery: {}
  };

  // ------------------------------------------------------------------ utils
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtINR(n, decimals) {
    if (n === null || n === undefined || isNaN(n)) return "—";
    var d = decimals === undefined ? 2 : decimals;
    return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function todayISO() { return isoDate(new Date()); }
  function can(perm) { return USER.permissions.indexOf("*") >= 0 || USER.permissions.indexOf(perm) >= 0; }
  function fieldLabel(key) {
    return ({
      description: "Description", amount: "Amount", transaction_date: "Date", category_id: "Category", subcategory_id: "Subcategory",
      category_path: "Category path", vendor: "Vendor", payment_method: "Payment method", payment_reference: "Payment reference",
      payment_status: "Payment status", notes: "Notes", receipt_reference: "Receipt / invoice", expense_type: "Expense type",
      project_phase: "Project / phase", status: "Status"
    })[key] || key;
  }
  function fmtValue(key, v) {
    if (v === null || v === undefined || v === "") return "(empty)";
    if (key === "amount") return fmtINR(v);
    if (key === "transaction_date") return fmtDate(v);
    if (key === "category_path" && Array.isArray(v)) return v.join(" > ");
    if (key === "category_id" || key === "subcategory_id") return categoryName(v);
    return String(v);
  }
  function categoryName(id) {
    var c = state.categories.flat.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : id;
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, ctx = this; clearTimeout(t); t = setTimeout(function () { fn.apply(ctx, a); }, ms); };
  }
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "k-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) return;
      (Array.isArray(v) ? v : [v]).forEach(function (x) { parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(x)); });
    });
    return parts.length ? "?" + parts.join("&") : "";
  }
  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var i = h.indexOf("?");
    var path = i >= 0 ? h.slice(0, i) : h;
    var params = {};
    if (i >= 0) {
      new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) {
        if (params[k] !== undefined) params[k] = [].concat(params[k], v); else params[k] = v;
      });
    }
    return { path: path || "dashboard", params: params };
  }
  function navigate(path, params) { location.hash = "#/" + path + qs(params || {}); }

  // ------------------------------------------------------------------ toast / modal
  function toast(msg, kind) {
    var root = $("#toast-root");
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === "error" ? 6000 : 3500);
  }

  var modalCloseHandler = null;
  function openModal(title, bodyHtml, opts) {
    opts = opts || {};
    var root = $("#modal-root");
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal").classList.toggle("wide", !!opts.wide);
    root.hidden = false;
    document.body.style.overflow = "hidden";
    modalCloseHandler = opts.onClose || null;
    var first = $("#modal-body input, #modal-body select, #modal-body textarea, #modal-body button");
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
      var body = openModal(title,
        '<p>' + esc(prompt) + '</p>' +
        '<div class="field"><label for="reason-input" class="required">Reason</label>' +
        '<textarea id="reason-input" maxlength="300" placeholder="Explain why (recorded in the audit history)"></textarea></div>' +
        '<p class="form-error" id="reason-error" hidden></p>' +
        '<div class="btn-row end"><button class="btn" id="reason-cancel">Cancel</button>' +
        '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" id="reason-ok">' + esc(confirmLabel) + '</button></div>',
        { onClose: function () { resolve(null); } });
      $("#reason-cancel", body).addEventListener("click", closeModal);
      $("#reason-ok", body).addEventListener("click", function () {
        var r = $("#reason-input", body).value.trim();
        if (r.length < 3) { $("#reason-error", body).textContent = "Enter a reason (at least 3 characters)."; $("#reason-error", body).hidden = false; return; }
        modalCloseHandler = null;
        closeModal();
        resolve(r);
      });
    });
  }

  // ------------------------------------------------------------------ API
  function api(method, url, body, opts) {
    opts = opts || {};
    var headers = { "X-CSRF-Token": CSRF };
    var init = { method: method, headers: headers, credentials: "same-origin" };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
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

  // ------------------------------------------------------------------ shell
  function setupShell() {
    $("#user-name").textContent = USER.full_name || USER.username;
    $("#user-role").textContent = USER.role;
    $("#user-avatar").textContent = (USER.full_name || USER.username).slice(0, 1).toUpperCase();
    $$("[data-perm]").forEach(function (el) { if (!can(el.getAttribute("data-perm"))) el.remove(); });
    $("#logout-btn").addEventListener("click", function () {
      api("POST", "/api/auth/logout").then(function () { location.href = "/login"; }).catch(function () { location.href = "/login"; });
    });
    var sidebar = $("#sidebar"), backdrop = $("#sidebar-backdrop");
    function openNav() { sidebar.classList.add("open"); backdrop.hidden = false; }
    function closeNav() { sidebar.classList.remove("open"); backdrop.hidden = true; }
    $("#menu-btn").addEventListener("click", openNav);
    $("#sidebar-close").addEventListener("click", closeNav);
    backdrop.addEventListener("click", closeNav);
    $("#nav").addEventListener("click", function (e) { if (e.target.closest("a")) closeNav(); });
    var quick = $("#quick-add-btn");
    if (quick) quick.addEventListener("click", function () { openExpenseForm(null); });

    // Idle logout timer mirrors the server session timeout.
    var idleMs = (META.idle_minutes || 30) * 60 * 1000;
    var idleTimer;
    function resetIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { location.href = "/login"; }, idleMs);
    }
    ["click", "keydown", "touchstart", "mousemove"].forEach(function (ev) { document.addEventListener(ev, debounce(resetIdle, 1000), { passive: true }); });
    resetIdle();

    if (USER.must_change_password) {
      setTimeout(function () { openChangePassword(true); }, 200);
    }
  }

  function openChangePassword(forced) {
    var body = openModal(forced ? "Set a new password" : "Change password",
      (forced ? '<div class="notice">You must set a new password before continuing.</div>' : "") +
      '<form id="pw-form" novalidate>' +
      '<div class="field"><label for="pw-current">Current password</label><input id="pw-current" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" autocomplete="new-password"><span class="hint">At least 8 characters with uppercase, lowercase and a number.</span></div>' +
      '<div class="field"><label for="pw-confirm">Confirm new password</label><input id="pw-confirm" type="password" autocomplete="new-password"></div>' +
      '<p class="form-error" id="pw-error" hidden></p>' +
      '<div class="btn-row end">' + (forced ? "" : '<button type="button" class="btn" id="pw-cancel">Cancel</button>') +
      '<button type="submit" class="btn btn-primary">Save new password</button></div></form>',
      { onClose: function () { if (forced) setTimeout(function () { openChangePassword(true); }, 50); } });
    if (!forced) $("#pw-cancel", body).addEventListener("click", closeModal);
    $("#pw-form", body).addEventListener("submit", function (e) {
      e.preventDefault();
      api("POST", "/api/auth/change-password", {
        current_password: $("#pw-current", body).value, new_password: $("#pw-new", body).value, confirm_password: $("#pw-confirm", body).value
      }).then(function () {
        USER.must_change_password = false;
        modalCloseHandler = null;
        closeModal();
        toast("Password updated.", "ok");
      }).catch(function (err) { $("#pw-error", body).textContent = err.message; $("#pw-error", body).hidden = false; });
    });
  }

  // ------------------------------------------------------------------ categories cache
  function loadCategories(includeArchived) {
    return api("GET", "/api/categories" + (includeArchived ? "?include_archived=1" : "")).then(function (d) {
      if (!includeArchived) state.categories = d;
      return d;
    });
  }
  function categoryOptions(selectedId, onlyTop) {
    var out = ['<option value="">Choose…</option>'];
    state.categories.flat.forEach(function (c) {
      if (onlyTop && c.level > 0) return;
      var indent = new Array(c.level + 1).join("\u00a0\u00a0\u00a0");
      out.push('<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + '>' + indent + (c.level ? "↳ " : "") + esc(c.name) + '</option>');
    });
    return out.join("");
  }
  function subcategoryOptions(parentId, selectedId) {
    var out = ['<option value="">All subcategories</option>'];
    state.categories.flat.forEach(function (c) {
      if (c.level === 0 || c.path_ids[0] !== parentId) return;
      var indent = new Array(c.level).join("\u00a0\u00a0\u00a0");
      out.push('<option value="' + esc(c.id) + '"' + (c.id === selectedId ? " selected" : "") + '>' + indent + esc(c.name) + '</option>');
    });
    return out.join("");
  }

  // ------------------------------------------------------------------ router
  var views = {};
  function setTitle(t) { $("#page-title").textContent = t; document.title = t + " · Expense Manager"; }
  function render() {
    var route = parseHash();
    var main = $("#main");
    $$(".nav-link").forEach(function (a) { a.classList.toggle("active", a.getAttribute("data-view") === route.path.split("/")[0]); });
    var view = views[route.path.split("/")[0]] || views.dashboard;
    main.innerHTML = '<div class="empty">Loading…</div>';
    closeModal();
    Promise.resolve(view(main, route)).catch(function (err) {
      fail(err);
      main.innerHTML = '<div class="panel"><p class="form-error">' + esc(err.message || "Could not load this page.") + '</p></div>';
    });
    main.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", render);

  // =================================================================== DASHBOARD
  var PERIODS = [["this_month", "This month"], ["last_month", "Last month"], ["this_quarter", "This quarter"], ["this_year", "This year"],
    ["last_year", "Last year"], ["last_30_days", "Last 30 days"], ["last_90_days", "Last 90 days"], ["all_time", "All time"], ["custom", "Custom range"]];

  views.dashboard = function (main, route) {
    setTitle("Dashboard");
    return Promise.all([api("GET", "/api/dashboard/preferences"), state.categories.flat.length ? null : loadCategories()]).then(function (res) {
      state.prefs = res[0].preferences;
      var p = route.params;
      var period = p.period || state.prefs.default_period || "this_month";
      var dateFrom = p.date_from || (period === "custom" ? state.prefs.custom_range.date_from : "");
      var dateTo = p.date_to || (period === "custom" ? state.prefs.custom_range.date_to : "");
      var gran = p.granularity || (state.prefs.trend_granularity !== "auto" ? state.prefs.trend_granularity : "");
      main.innerHTML =
        '<div class="dash-toolbar">' +
        '<label class="small muted" for="dash-period">Period</label>' +
        '<select id="dash-period">' + PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select>' +
        '<span id="dash-custom" ' + (period === "custom" ? "" : "hidden") + '><input type="date" id="dash-from" value="' + esc(dateFrom || "") + '" aria-label="From date"> <input type="date" id="dash-to" value="' + esc(dateTo || "") + '" aria-label="To date"> <button class="btn btn-sm" id="dash-apply">Apply</button></span>' +
        '<label class="small muted" for="dash-gran">Trend by</label>' +
        '<select id="dash-gran"><option value="">Auto</option><option value="day"' + (gran === "day" ? " selected" : "") + '>Day</option><option value="month"' + (gran === "month" ? " selected" : "") + '>Month</option><option value="quarter"' + (gran === "quarter" ? " selected" : "") + '>Quarter</option><option value="year"' + (gran === "year" ? " selected" : "") + '>Year</option></select>' +
        '<span style="flex:1"></span>' +
        (can("dashboard:customize") ? '<button class="btn btn-sm" id="dash-customize">Customise widgets</button>' : "") +
        '<button class="btn btn-sm no-print" id="dash-print">Print</button>' +
        '</div>' +
        '<div class="print-only"><h2>Expense summary</h2><p id="print-period"></p></div>' +
        '<div class="dash-grid" id="dash-grid"><div class="empty">Loading…</div></div>';

      function go() {
        var sel = $("#dash-period").value;
        var params = { period: sel };
        if (sel === "custom") { params.date_from = $("#dash-from").value; params.date_to = $("#dash-to").value; }
        if ($("#dash-gran").value) params.granularity = $("#dash-gran").value;
        navigate("dashboard", params);
      }
      $("#dash-period").addEventListener("change", function () {
        $("#dash-custom").hidden = this.value !== "custom";
        if (this.value !== "custom") go();
      });
      $("#dash-apply").addEventListener("click", go);
      $("#dash-gran").addEventListener("change", go);
      $("#dash-print").addEventListener("click", function () { window.print(); });
      var cust = $("#dash-customize");
      if (cust) cust.addEventListener("click", openCustomise);

      var query = { period: period === "custom" ? "" : period, date_from: period === "custom" ? dateFrom : "", date_to: period === "custom" ? dateTo : "", granularity: gran };
      return api("GET", "/api/dashboard/summary" + qs(query)).then(function (data) {
        $("#print-period").textContent = data.period.label;
        renderWidgets(data, query);
      });
    });
  };

  function drillParams(data, extra) {
    var base = { status: "active" };
    if (data.period.date_from) base.date_from = data.period.date_from.slice(0, 10);
    if (data.period.date_to) base.date_to = data.period.date_to.slice(0, 10);
    Object.keys(extra || {}).forEach(function (k) { base[k] = extra[k]; });
    return base;
  }

  function renderWidgets(data, query, gridEl) {
    var grid = gridEl || $("#dash-grid");
    if (!grid) return;
    grid.innerHTML = "";
    var layout = state.prefs.layout.filter(function (w) { return w.visible; });
    if (!layout.length) { grid.innerHTML = '<div class="empty" style="grid-column: span 12">No widgets selected. Use “Customise widgets” to add some.</div>'; return; }
    var pending = data.pending.reduce(function (a, b) { return a + b.total; }, 0);
    var pendingCount = data.pending.reduce(function (a, b) { return a + b.count; }, 0);
    var names = {};
    META.widgets.forEach(function (w) { names[w.id] = w.name; });

    layout.forEach(function (w) {
      var el = document.createElement("section");
      el.className = "widget";
      el.setAttribute("data-size", w.size);
      el.setAttribute("data-id", w.id);
      el.draggable = can("dashboard:customize");
      var head = '<div class="widget-head"><h3>' + esc(names[w.id] || w.id) + '</h3><span>' + (el.draggable ? '<span class="widget-drag" title="Drag to reorder">⋮⋮</span>' : "") + '</span></div>';
      var body = "";
      switch (w.id) {
        case "total_expenses":
          body = '<div class="big amount">' + fmtINR(data.totals.total, 0) + '</div><div class="sub">' + esc(data.period.label) + ' · <button class="link-btn" data-drill="all">View transactions</button></div>';
          break;
        case "transaction_count":
          body = '<div class="big">' + data.totals.count + '</div><div class="sub">transactions in ' + esc(data.period.label) + '</div>';
          break;
        case "average_expense":
          body = '<div class="big amount">' + fmtINR(data.totals.average, 0) + '</div><div class="sub">average per transaction</div>';
          break;
        case "largest_expense":
          body = data.largest
            ? '<div class="big amount">' + fmtINR(data.largest.amount, 0) + '</div><div class="sub"><button class="link-btn" data-open="' + esc(data.largest.id) + '">' + esc(data.largest.description) + '</button></div>'
            : '<div class="big">—</div><div class="sub">no transactions</div>';
          break;
        case "monthly_trend":
          body = '<canvas id="c-trend"></canvas><div class="sub">By ' + esc(data.trend.granularity) + '. Click a point to drill down.</div>';
          break;
        case "by_category":
          body = (state.prefs.chart_type_category === "donut" ? '<canvas id="c-cat"></canvas>' : '<canvas id="c-cat"></canvas>') + '<ul class="bar-list" id="l-cat" style="margin-top:10px"></ul>';
          break;
        case "by_subcategory":
          body = data.by_subcategory.length ? '<ul class="bar-list" id="l-sub"></ul>' : '<div class="empty">No subcategory data</div>';
          break;
        case "by_payment_method":
          body = '<canvas id="c-pay" style="height:200px"></canvas><div class="legend" id="lg-pay"></div>';
          break;
        case "top_vendors":
          body = data.top_vendors.length ? '<ul class="bar-list" id="l-vendor"></ul>' : '<div class="empty">No vendor data</div>';
          break;
        case "pending_payments":
          body = '<div class="big amount">' + fmtINR(pending, 0) + '</div><div class="sub">' + pendingCount + ' pending or partially paid · <button class="link-btn" data-drill="pending">View</button></div>';
          break;
        case "recent_transactions":
          body = data.recent.length ? '<div class="table-wrap"><table class="data cards"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="amount">Amount</th></tr></thead><tbody>' +
            data.recent.map(function (e) {
              return '<tr class="row-link" data-open="' + esc(e.id) + '"><td data-label="Date">' + fmtDate(e.transaction_date) + '</td><td data-label="Description">' + esc(e.description) + '</td><td data-label="Category">' + esc((e.category_path || []).join(" > ")) + '</td><td class="amount" data-label="Amount">' + fmtINR(e.amount) + '</td></tr>';
            }).join("") + '</tbody></table></div>' : '<div class="empty">No transactions yet. <button class="link-btn" data-add="1">Add the first one</button></div>';
          break;
      }
      el.innerHTML = head + body;
      grid.appendChild(el);
    });

    // charts
    var trendC = $("#c-trend");
    if (trendC) {
      var labels = data.trend.points.map(function (x) { return x.label; });
      var vals = data.trend.points.map(function (x) { return x.total; });
      var draw = data.trend.points.length > 1 ? Charts.line : Charts.bar;
      draw(trendC, labels, vals, { onClick: function (i) { drillTrend(data.trend.granularity, data.trend.points[i].label, data); } });
    }
    var catC = $("#c-cat");
    if (catC) {
      var cl = data.by_category.map(function (x) { return x.name; });
      var cv = data.by_category.map(function (x) { return x.total; });
      var onClick = function (i) { navigate("expenses", drillParams(data, { category_id: data.by_category[i].category_id })); };
      if (state.prefs.chart_type_category === "donut") Charts.donut(catC, cl, cv, { onClick: onClick }); else Charts.bar(catC, cl, cv, { multicolor: true, onClick: onClick });
      renderBarList($("#l-cat"), data.by_category, function (x) { return x.name; }, function (x) { navigate("expenses", drillParams(data, { category_id: x.category_id })); });
    }
    if ($("#l-sub")) renderBarList($("#l-sub"), data.by_subcategory, function (x) { return x.name; }, function (x) { navigate("expenses", drillParams(data, { category_id: x.category_id, subcategory_id: x.subcategory_id })); });
    if ($("#l-vendor")) renderBarList($("#l-vendor"), data.top_vendors, function (x) { return x.vendor; }, function (x) { navigate("expenses", drillParams(data, { vendor: x.vendor })); });
    var payC = $("#c-pay");
    if (payC) {
      var pl = data.by_payment_method.map(function (x) { return x.name; });
      var pv = data.by_payment_method.map(function (x) { return x.total; });
      Charts.donut(payC, pl, pv, { onClick: function (i) { var m = data.by_payment_method[i].name; navigate("expenses", drillParams(data, m === "Not specified" ? {} : { payment_method: m })); } });
      $("#lg-pay").innerHTML = pl.map(function (l, i) { return '<span style="--c: var(--chart-' + ((i % 8) + 1) + ')">' + esc(l) + " " + fmtINR(pv[i], 0) + '</span>'; }).join("");
    }

    grid.__data = data;
    if (!grid.__bound) {
      grid.__bound = true;
      grid.addEventListener("click", function (e) {
        var t = e.target.closest("[data-drill], [data-open], [data-add]");
        if (!t) return;
        var d = grid.__data;
        if (t.hasAttribute("data-open")) openExpenseDetail(t.getAttribute("data-open"));
        else if (t.hasAttribute("data-add")) openExpenseForm(null);
        else if (t.getAttribute("data-drill") === "pending") navigate("expenses", drillParams(d, { payment_status: ["Pending", "Partially Paid"] }));
        else navigate("expenses", drillParams(d));
      });
      setupWidgetDrag(grid);
      var lastW = grid.getBoundingClientRect().width;
      var redraw = debounce(function () {
        if (!document.contains(grid)) return;
        var w = grid.getBoundingClientRect().width;
        if (Math.abs(w - lastW) < 2) return;
        lastW = w;
        renderWidgets(grid.__data, query, grid);
      }, 200);
      if (global.ResizeObserver) { grid.__ro = new ResizeObserver(function () { if (document.contains(grid)) redraw(); else grid.__ro.disconnect(); }); grid.__ro.observe(grid); }
    }
  }

  function drillTrend(granularity, label, data) {
    var params = {};
    if (granularity === "year") { params.period = "custom"; params.date_from = label + "-01-01"; params.date_to = label + "-12-31"; params.granularity = "month"; navigate("dashboard", params); }
    else if (granularity === "quarter") {
      var y = label.slice(0, 4), q = parseInt(label.slice(6), 10);
      var m0 = (q - 1) * 3 + 1, m1 = m0 + 2;
      params.period = "custom"; params.date_from = y + "-" + String(m0).padStart(2, "0") + "-01";
      params.date_to = isoDate(new Date(Date.UTC(parseInt(y, 10), m1, 0))); params.granularity = "month"; navigate("dashboard", params);
    }
    else if (granularity === "month") {
      var yy = parseInt(label.slice(0, 4), 10), mm = parseInt(label.slice(5, 7), 10);
      params.period = "custom"; params.date_from = label + "-01"; params.date_to = isoDate(new Date(Date.UTC(yy, mm, 0))); params.granularity = "day"; navigate("dashboard", params);
    }
    else navigate("expenses", { status: "active", date_from: label, date_to: label });
  }

  function renderBarList(ul, rows, labelFn, onClick) {
    if (!ul) return;
    var max = Math.max.apply(null, rows.map(function (r) { return r.total; }).concat([1]));
    ul.innerHTML = rows.slice(0, 10).map(function (r, i) {
      return '<li data-i="' + i + '" tabindex="0"><span class="label">' + esc(labelFn(r)) + '</span><span class="amount">' + fmtINR(r.total, 0) + ' <span class="muted small">(' + r.count + ')</span></span><span class="track"><span class="fill" style="width:' + (r.total / max * 100) + '%"></span></span></li>';
    }).join("");
    ul.addEventListener("click", function (e) { var li = e.target.closest("li"); if (li) onClick(rows[+li.getAttribute("data-i")]); });
    ul.addEventListener("keydown", function (e) { var li = e.target.closest("li"); if (li && e.key === "Enter") onClick(rows[+li.getAttribute("data-i")]); });
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
      e.preventDefault();
      t.classList.remove("drop-target");
      var items = $$(".widget", grid);
      if (items.indexOf(dragging) < items.indexOf(t)) t.after(dragging); else t.before(dragging);
      var order = $$(".widget", grid).map(function (w) { return w.getAttribute("data-id"); });
      var visible = order.map(function (id) { return state.prefs.layout.filter(function (l) { return l.id === id; })[0]; });
      var hidden = state.prefs.layout.filter(function (l) { return !l.visible; });
      state.prefs.layout = visible.concat(hidden);
      api("PUT", "/api/dashboard/preferences", state.prefs).then(function (d) { state.prefs = d.preferences; toast("Layout saved.", "ok"); }).catch(fail);
    });
    grid.addEventListener("dragend", function () { if (dragging) dragging.classList.remove("is-dragging"); $$(".drop-target", grid).forEach(function (x) { x.classList.remove("drop-target"); }); dragging = null; });
  }

  function openCustomise() {
    var prefs = JSON.parse(JSON.stringify(state.prefs));
    var all = META.widgets.map(function (w) { return w.id; });
    all.forEach(function (id) { if (!prefs.layout.some(function (l) { return l.id === id; })) prefs.layout.push({ id: id, visible: false, size: META.widgets.filter(function (w) { return w.id === id; })[0].size }); });
    var names = {}; META.widgets.forEach(function (w) { names[w.id] = w.name; });
    var body = openModal("Customise dashboard",
      '<p class="muted small">Tick the widgets you want, drag to reorder, and pick a size. Your layout is saved to your account.</p>' +
      '<ul class="widget-pick" id="wp"></ul>' +
      '<div class="form-grid" style="margin-top:16px">' +
      '<div class="field"><label for="pref-period">Default period</label><select id="pref-period">' + PERIODS.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === prefs.default_period ? " selected" : "") + '>' + x[1] + '</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label for="pref-cat-chart">Category chart</label><select id="pref-cat-chart"><option value="bar"' + (prefs.chart_type_category === "bar" ? " selected" : "") + '>Bars</option><option value="donut"' + (prefs.chart_type_category === "donut" ? " selected" : "") + '>Donut</option></select></div>' +
      '<div class="field"><label for="pref-from">Custom range from</label><input type="date" id="pref-from" value="' + esc(prefs.custom_range.date_from || "") + '"></div>' +
      '<div class="field"><label for="pref-to">Custom range to</label><input type="date" id="pref-to" value="' + esc(prefs.custom_range.date_to || "") + '"></div>' +
      '<div class="field"><label for="pref-gran">Trend granularity</label><select id="pref-gran">' + ["auto", "day", "month", "quarter", "year"].map(function (g) { return '<option value="' + g + '"' + (g === prefs.trend_granularity ? " selected" : "") + '>' + g.charAt(0).toUpperCase() + g.slice(1) + '</option>'; }).join("") + '</select></div>' +
      '</div>' +
      '<div class="btn-row end"><button class="btn" id="pref-reset">Reset to role default</button><button class="btn" id="pref-cancel">Cancel</button><button class="btn btn-primary" id="pref-save">Save layout</button></div>');
    var ul = $("#wp", body);
    function draw() {
      ul.innerHTML = prefs.layout.map(function (l, i) {
        return '<li draggable="true" data-i="' + i + '"><span class="widget-drag">⋮⋮</span><label><input type="checkbox" data-vis="' + i + '"' + (l.visible ? " checked" : "") + '> ' + esc(names[l.id]) + '</label>' +
          '<select data-size="' + i + '" aria-label="Size">' + ["small", "medium", "large"].map(function (s) { return '<option value="' + s + '"' + (s === l.size ? " selected" : "") + '>' + s + '</option>'; }).join("") + '</select>' +
          '<span><button class="link-btn" data-up="' + i + '" aria-label="Move up">↑</button><button class="link-btn" data-down="' + i + '" aria-label="Move down">↓</button></span></li>';
      }).join("");
    }
    draw();
    var dragIdx = null;
    ul.addEventListener("dragstart", function (e) { var li = e.target.closest("li"); if (li) { dragIdx = +li.getAttribute("data-i"); li.classList.add("is-dragging"); } });
    ul.addEventListener("dragover", function (e) { if (e.target.closest("li")) e.preventDefault(); });
    ul.addEventListener("drop", function (e) {
      var li = e.target.closest("li"); if (!li || dragIdx === null) return;
      var to = +li.getAttribute("data-i");
      var item = prefs.layout.splice(dragIdx, 1)[0];
      prefs.layout.splice(to, 0, item);
      dragIdx = null; draw();
    });
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
    $("#pref-reset", body).addEventListener("click", function () {
      api("DELETE", "/api/dashboard/preferences").then(function () { closeModal(); toast("Dashboard reset.", "ok"); render(); }).catch(fail);
    });
    $("#pref-save", body).addEventListener("click", function () {
      prefs.default_period = $("#pref-period", body).value;
      prefs.chart_type_category = $("#pref-cat-chart", body).value;
      prefs.trend_granularity = $("#pref-gran", body).value;
      prefs.custom_range = { date_from: $("#pref-from", body).value, date_to: $("#pref-to", body).value };
      api("PUT", "/api/dashboard/preferences", prefs).then(function () { closeModal(); toast("Dashboard saved.", "ok"); render(); }).catch(fail);
    });
  }

  // =================================================================== EXPENSES
  views.expenses = function (main, route) {
    setTitle("Expenses");
    var p = route.params;
    return Promise.all([
      state.categories.flat.length ? null : loadCategories(),
      api("GET", "/api/expenses/meta"), api("GET", "/api/filters")
    ]).then(function (res) {
      state.expenseMeta = res[1];
      state.savedFilters = res[2].filters;
      var canDeleted = can("expense:view_deleted");
      var vendors = state.expenseMeta.vendors;
      var topCat = p.category_id && !Array.isArray(p.category_id) ? p.category_id : "";
      main.innerHTML =
        '<div class="panel">' +
        '<div class="filters">' +
        '<div class="f span-2"><label for="f-q">Search</label><input id="f-q" type="search" placeholder="Expense ID, description, vendor, notes…" value="' + esc(p.q || "") + '"></div>' +
        '<div class="f"><label for="f-cat">Category</label><select id="f-cat">' + ['<option value="">All categories</option>'].concat(state.categories.flat.filter(function (c) { return c.level === 0; }).map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === topCat ? " selected" : "") + '>' + esc(c.name) + '</option>'; })).join("") + '</select></div>' +
        '<div class="f"><label for="f-sub">Subcategory</label><select id="f-sub">' + subcategoryOptions(topCat, p.subcategory_id) + '</select></div>' +
        '<div class="f"><label for="f-from">From</label><input id="f-from" type="date" value="' + esc(p.date_from || "") + '"></div>' +
        '<div class="f"><label for="f-to">To</label><input id="f-to" type="date" value="' + esc(p.date_to || "") + '"></div>' +
        '<div class="f"><label for="f-min">Min amount</label><input id="f-min" type="number" min="0" step="0.01" value="' + esc(p.min_amount || "") + '"></div>' +
        '<div class="f"><label for="f-max">Max amount</label><input id="f-max" type="number" min="0" step="0.01" value="' + esc(p.max_amount || "") + '"></div>' +
        '</div>' +
        '<details class="adv"' + ((p.vendor || p.payment_method || p.payment_status || p.expense_type || p.status) ? " open" : "") + '><summary>More filters</summary>' +
        '<div class="filters">' +
        '<div class="f"><label for="f-vendor">Vendor</label><input id="f-vendor" list="vendor-list" value="' + esc(p.vendor || "") + '"><datalist id="vendor-list">' + vendors.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist></div>' +
        '<div class="f"><label for="f-pm">Payment method</label><select id="f-pm"><option value="">Any</option>' + META.payment_methods.map(function (m) { return '<option' + (m === p.payment_method ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="f-ps">Payment status</label><select id="f-ps"><option value="">Any</option>' + META.payment_statuses.map(function (m) { return '<option' + (m === p.payment_status ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="f-type">Expense type</label><select id="f-type"><option value="">Any</option>' + META.expense_types.map(function (m) { return '<option' + (m === p.expense_type ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="f"><label for="f-status">Record status</label><select id="f-status"><option value="active">Active</option><option value="edited"' + (p.status === "edited" ? " selected" : "") + '>Edited only</option>' + (canDeleted ? '<option value="deleted"' + (p.status === "deleted" ? " selected" : "") + '>Deleted</option><option value="all"' + (p.status === "all" ? " selected" : "") + '>All (incl. deleted)</option>' : "") + '</select></div>' +
        '<div class="f"><label for="f-logic">Category match</label><select id="f-logic"><option value="all">Match category AND subcategory</option><option value="any"' + (p.logic === "any" ? " selected" : "") + '>Match either (OR)</option></select></div>' +
        '</div></details>' +
        '<div class="filters-foot">' +
        '<button class="btn btn-primary btn-sm" id="f-apply">Apply filters</button>' +
        '<button class="btn btn-sm" id="f-clear">Clear</button>' +
        '<select id="f-saved" aria-label="Saved filters"><option value="">Saved filters…</option>' + state.savedFilters.map(function (f) { return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>'; }).join("") + '</select>' +
        '<button class="btn btn-sm" id="f-save">Save current</button>' +
        '<span class="spacer"></span>' +
        (can("export") ? '<button class="btn btn-sm" id="f-csv">Export CSV</button>' : "") +
        '</div></div>' +
        '<div class="panel"><div id="chips" class="chips"></div><div class="result-bar"><span id="result-count"></span><span id="result-total" class="amount"></span></div>' +
        '<div class="table-wrap" id="exp-table"></div><div class="pager" id="pager"></div></div>';

      $("#f-cat").addEventListener("change", function () { $("#f-sub").innerHTML = subcategoryOptions(this.value, ""); });
      function collect() {
        return {
          q: $("#f-q").value.trim(), category_id: $("#f-cat").value, subcategory_id: $("#f-sub").value, date_from: $("#f-from").value, date_to: $("#f-to").value,
          min_amount: $("#f-min").value, max_amount: $("#f-max").value, vendor: $("#f-vendor").value.trim(), payment_method: $("#f-pm").value,
          payment_status: $("#f-ps").value, expense_type: $("#f-type").value, status: $("#f-status").value, logic: $("#f-logic").value,
          sort: p.sort, order: p.order, per_page: p.per_page
        };
      }
      $("#f-apply").addEventListener("click", function () { navigate("expenses", collect()); });
      $("#f-q").addEventListener("keydown", function (e) { if (e.key === "Enter") navigate("expenses", collect()); });
      $("#f-clear").addEventListener("click", function () { navigate("expenses", {}); });
      $("#f-saved").addEventListener("change", function () {
        var f = state.savedFilters.filter(function (x) { return x.id === $("#f-saved").value; })[0];
        if (f) navigate("expenses", f.params);
      });
      $("#f-save").addEventListener("click", function () {
        var name = prompt("Name this filter");
        if (!name) return;
        api("POST", "/api/filters", { name: name.trim(), params: collect() }).then(function () { toast("Filter saved.", "ok"); render(); }).catch(fail);
      });
      var csvBtn = $("#f-csv");
      if (csvBtn) csvBtn.addEventListener("click", function () { location.href = "/api/export/csv" + qs(p); });

      // chips for active filters
      var chipKeys = { q: "Search", category_id: "Category", subcategory_id: "Subcategory", date_from: "From", date_to: "To", min_amount: "Min", max_amount: "Max", vendor: "Vendor", payment_method: "Method", payment_status: "Status", expense_type: "Type", status: "Records" };
      $("#chips").innerHTML = Object.keys(chipKeys).filter(function (k) { return p[k] && !(k === "status" && p[k] === "active"); }).map(function (k) {
        var v = p[k];
        if (k === "category_id" || k === "subcategory_id") v = [].concat(v).map(categoryName).join(", ");
        else v = [].concat(v).join(", ");
        return '<button class="chip" data-chip="' + esc(k) + '">' + esc(chipKeys[k]) + ': ' + esc(v) + ' <span class="x">×</span></button>';
      }).join("");
      $("#chips").addEventListener("click", function (e) {
        var c = e.target.closest("[data-chip]"); if (!c) return;
        var np = {}; Object.keys(p).forEach(function (k) { if (k !== c.getAttribute("data-chip") && k !== "page") np[k] = p[k]; });
        if (c.getAttribute("data-chip") === "category_id") delete np.subcategory_id;
        navigate("expenses", np);
      });

      state.lastExpenseQuery = p;
      return loadExpenseTable(p);
    });
  };

  function loadExpenseTable(p) {
    return api("GET", "/api/expenses" + qs(p)).then(function (d) {
      $("#result-count").textContent = d.total_count + " record" + (d.total_count === 1 ? "" : "s");
      $("#result-total").textContent = "Total " + fmtINR(d.total_amount);
      var sort = p.sort || "transaction_date", order = p.order || "desc";
      function th(key, label, cls) {
        return '<th class="sortable ' + (cls || "") + (sort === key ? " sorted-" + order : "") + '" data-sort="' + key + '">' + label + '</th>';
      }
      var wrap = $("#exp-table");
      if (!d.items.length) {
        wrap.innerHTML = '<div class="empty">No expenses match these filters.' + (can("expense:create") ? ' <button class="link-btn" id="empty-add">Add an expense</button>' : "") + '</div>';
        var ea = $("#empty-add"); if (ea) ea.addEventListener("click", function () { openExpenseForm(null); });
      } else {
        wrap.innerHTML = '<table class="data cards"><thead><tr>' + th("expense_id", "ID") + th("transaction_date", "Date") + th("description", "Description") + th("category_path", "Category") +
          th("vendor", "Vendor") + th("payment_method", "Method") + '<th>Status</th>' + th("amount", "Amount", "amount") + '</tr></thead><tbody>' +
          d.items.map(function (e) {
            var status = e.status === "deleted" ? '<span class="tag bad">Deleted</span>' : (e.revision > 1 ? '<span class="tag warn">Edited ×' + (e.revision - 1) + '</span>' : '<span class="tag ok">Active</span>');
            if (e.payment_status === "Pending" || e.payment_status === "Partially Paid") status += ' <span class="tag">' + esc(e.payment_status) + '</span>';
            return '<tr class="row-link' + (e.status === "deleted" ? " deleted" : "") + '" data-open="' + esc(e.id) + '">' +
              '<td data-label="ID" class="nowrap">' + esc(e.expense_id) + '</td><td data-label="Date" class="nowrap">' + fmtDate(e.transaction_date) + '</td>' +
              '<td data-label="Description" class="desc">' + esc(e.description) + '</td><td data-label="Category">' + esc((e.category_path || []).join(" > ")) + '</td>' +
              '<td data-label="Vendor">' + esc(e.vendor || "—") + '</td><td data-label="Method">' + esc(e.payment_method || "—") + '</td>' +
              '<td data-label="Status">' + status + '</td><td data-label="Amount" class="amount">' + fmtINR(e.amount) + '</td></tr>';
          }).join("") + '</tbody></table>';
        wrap.addEventListener("click", function (e) {
          var sortTh = e.target.closest("[data-sort]");
          if (sortTh) { var k = sortTh.getAttribute("data-sort"); var np = Object.assign({}, p, { sort: k, order: sort === k && order === "desc" ? "asc" : "desc", page: 1 }); navigate("expenses", np); return; }
          var row = e.target.closest("[data-open]");
          if (row) openExpenseDetail(row.getAttribute("data-open"));
        });
      }
      var pager = $("#pager");
      pager.innerHTML = '<label class="small muted">Per page <select id="per-page">' + [10, 25, 50, 100].map(function (n) { return '<option' + (n === d.per_page ? " selected" : "") + '>' + n + '</option>'; }).join("") + '</select></label>' +
        '<button class="btn btn-sm" id="pg-prev"' + (d.page <= 1 ? " disabled" : "") + '>‹ Prev</button><span class="small">Page ' + d.page + ' of ' + d.pages + '</span><button class="btn btn-sm" id="pg-next"' + (d.page >= d.pages ? " disabled" : "") + '>Next ›</button>';
      $("#per-page").addEventListener("change", function () { navigate("expenses", Object.assign({}, p, { per_page: this.value, page: 1 })); });
      $("#pg-prev").addEventListener("click", function () { navigate("expenses", Object.assign({}, p, { page: d.page - 1 })); });
      $("#pg-next").addEventListener("click", function () { navigate("expenses", Object.assign({}, p, { page: d.page + 1 })); });
    });
  }

  // ---------------- expense form (create / edit)
  function openExpenseForm(existing) {
    var ready = state.categories.flat.length ? Promise.resolve() : loadCategories();
    ready.then(function () {
      var e = existing || {};
      var selectedCat = e.subcategory_id || e.category_id || "";
      var body = openModal(existing ? "Edit " + e.expense_id : "Add expense",
        '<form id="exp-form" novalidate><div class="form-grid">' +
        '<div class="field span-2"><label class="required" for="x-desc">Description</label><input id="x-desc" maxlength="300" required value="' + esc(e.description || "") + '"></div>' +
        '<div class="field"><label class="required" for="x-amount">Amount (₹)</label><input id="x-amount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="' + esc(e.amount || "") + '"></div>' +
        '<div class="field"><label class="required" for="x-date">Transaction date</label><input id="x-date" type="date" required max="' + todayISO() + '" value="' + esc(e.transaction_date ? e.transaction_date.slice(0, 10) : todayISO()) + '"></div>' +
        '<div class="field span-2"><label class="required" for="x-cat">Category / subcategory</label><select id="x-cat" required>' + categoryOptions(selectedCat) + '</select><span class="hint">Pick the most specific level that applies.</span></div>' +
        '<div class="field"><label for="x-vendor">Vendor / payee</label><input id="x-vendor" list="x-vendor-list" maxlength="120" value="' + esc(e.vendor || "") + '"><datalist id="x-vendor-list">' + state.expenseMeta.vendors.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist></div>' +
        '<div class="field"><label for="x-pm">Payment method</label><select id="x-pm"><option value="">Not specified</option>' + META.payment_methods.map(function (m) { return '<option' + (m === e.payment_method ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="field"><label for="x-pref">Payment reference</label><input id="x-pref" maxlength="120" placeholder="UPI ref, cheque no., UTR…" value="' + esc(e.payment_reference || "") + '"></div>' +
        '<div class="field"><label for="x-ps">Payment status</label><select id="x-ps"><option value="">Not specified</option>' + META.payment_statuses.map(function (m) { return '<option' + (m === e.payment_status ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="field"><label for="x-type">Expense type</label><select id="x-type"><option value="">Not specified</option>' + META.expense_types.map(function (m) { return '<option' + (m === e.expense_type ? " selected" : "") + '>' + esc(m) + '</option>'; }).join("") + '</select></div>' +
        '<div class="field"><label for="x-phase">Project / setup phase</label><input id="x-phase" list="x-phase-list" maxlength="120" value="' + esc(e.project_phase || "") + '"><datalist id="x-phase-list">' + state.expenseMeta.phases.map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + '</datalist></div>' +
        '<div class="field span-2"><label for="x-receipt">Receipt / invoice reference</label><input id="x-receipt" maxlength="120" value="' + esc(e.receipt_reference || "") + '"></div>' +
        '<div class="field span-2"><label for="x-notes">Notes</label><textarea id="x-notes" maxlength="2000">' + esc(e.notes || "") + '</textarea></div>' +
        (existing ? '<div class="field span-2"><label class="required" for="x-reason">Reason for this change</label><input id="x-reason" maxlength="300" placeholder="e.g. Vendor sent corrected invoice"></div>' : "") +
        '</div><p class="form-error" id="x-error" hidden></p>' +
        '<div class="btn-row end"><button type="button" class="btn" id="x-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="x-save">' + (existing ? "Save changes" : "Add expense") + '</button></div></form>', { wide: true });
      $("#x-cancel", body).addEventListener("click", closeModal);
      var idemKey = uuid();
      $("#exp-form", body).addEventListener("submit", function (ev) {
        ev.preventDefault();
        var err = $("#x-error", body);
        err.hidden = true;
        var payload = {
          description: $("#x-desc", body).value.trim(), amount: $("#x-amount", body).value, transaction_date: $("#x-date", body).value,
          category_id: $("#x-cat", body).value, vendor: $("#x-vendor", body).value.trim(), payment_method: $("#x-pm", body).value,
          payment_reference: $("#x-pref", body).value.trim(), payment_status: $("#x-ps", body).value, expense_type: $("#x-type", body).value,
          project_phase: $("#x-phase", body).value.trim(), receipt_reference: $("#x-receipt", body).value.trim(), notes: $("#x-notes", body).value.trim()
        };
        var problems = [];
        if (payload.description.length < 2) problems.push("Description is required.");
        if (!(parseFloat(payload.amount) > 0)) problems.push("Enter an amount greater than 0.");
        if (!payload.transaction_date) problems.push("Choose a transaction date.");
        if (!payload.category_id) problems.push("Choose a category.");
        if (existing) { payload.reason = $("#x-reason", body).value.trim(); if (payload.reason.length < 3) problems.push("Give a reason for the change."); payload.expected_revision = e.revision; }
        if (problems.length) { err.textContent = problems.join(" "); err.hidden = false; return; }
        var btn = $("#x-save", body); btn.disabled = true;
        var req = existing ? api("PUT", "/api/expenses/" + e.id, payload) : api("POST", "/api/expenses", payload, { headers: { "Idempotency-Key": idemKey } });
        req.then(function (d) {
          closeModal();
          toast(existing ? (Object.keys(d.changes || {}).length ? "Expense updated." : "No changes made.") : "Expense " + d.expense.expense_id + " added.", "ok");
          render();
        }).catch(function (er) { btn.disabled = false; err.textContent = er.message; err.hidden = false; });
      });
    }).catch(fail);
  }

  // ---------------- expense detail with revision history
  function openExpenseDetail(id) {
    api("GET", "/api/expenses/" + id).then(function (d) {
      var e = d.expense;
      var fields = [["Expense ID", e.expense_id], ["Date", fmtDate(e.transaction_date)], ["Amount", fmtINR(e.amount)], ["Category", (e.category_path || []).join(" > ")],
        ["Vendor", e.vendor], ["Payment method", e.payment_method], ["Payment reference", e.payment_reference], ["Payment status", e.payment_status],
        ["Expense type", e.expense_type], ["Project / phase", e.project_phase], ["Receipt / invoice", e.receipt_reference], ["Created by", e.created_by_name + " · " + fmtDateTime(e.created_at)],
        ["Last updated", fmtDateTime(e.updated_at) + (e.modified_by_name ? " by " + e.modified_by_name : "")], ["Revision", e.revision]];
      var status = e.status === "deleted" ? '<div class="notice danger">Deleted by ' + esc(e.deleted_by_name) + ' on ' + fmtDateTime(e.deleted_at) + '. Reason: ' + esc(e.deletion_reason) + '</div>' : "";
      var timeline = d.revisions.map(function (r) {
        var diff = Object.keys(r.changes || {}).filter(function (k) { return k !== "category_path"; }).map(function (k) {
          return '<li><strong>' + esc(fieldLabel(k)) + ':</strong> <span class="from">' + esc(fmtValue(k, r.changes[k].from)) + '</span> → <span class="to">' + esc(fmtValue(k, r.changes[k].to)) + '</span></li>';
        }).join("");
        var verb = { create: "Created", edit: "Edited", delete: "Deleted", restore: "Restored" }[r.action] || r.action;
        return '<li class="' + esc(r.action) + '"><div><strong>Rev ' + r.revision + ' · ' + verb + '</strong> by ' + esc(r.user_name) + '</div><div class="when">' + fmtDateTime(r.at) + '</div>' +
          (r.reason && r.action !== "create" ? '<div class="reason">“' + esc(r.reason) + '”</div>' : "") + (diff ? '<ul class="diff">' + diff + '</ul>' : "") + '</li>';
      }).join("");
      var actions = [];
      if (e.status === "active" && can("expense:edit")) actions.push('<button class="btn" id="d-edit">Edit</button>');
      if (e.status === "active" && can("expense:delete")) actions.push('<button class="btn btn-danger" id="d-delete">Delete</button>');
      if (e.status === "deleted" && can("expense:restore")) actions.push('<button class="btn btn-primary" id="d-restore">Restore</button>');
      if (e.status === "deleted" && can("expense:purge")) actions.push('<button class="btn btn-danger" id="d-purge">Delete permanently</button>');
      var body = openModal(e.description, status +
        '<dl class="detail-grid">' + fields.map(function (f) { return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1] || "—") + '</dd></div>'; }).join("") + '</dl>' +
        (e.notes ? '<p><strong>Notes</strong><br>' + esc(e.notes).replace(/\n/g, "<br>") + '</p>' : "") +
        '<div class="btn-row" style="margin:8px 0 18px">' + actions.join("") + '</div>' +
        '<h3>History</h3><ul class="timeline">' + timeline + '</ul>', { wide: true });
      var b;
      if ((b = $("#d-edit", body))) b.addEventListener("click", function () { openExpenseForm(e); });
      if ((b = $("#d-delete", body))) b.addEventListener("click", function () {
        askReason("Delete " + e.expense_id, "The record will be kept for auditing and can be restored later.", "Delete expense", true).then(function (reason) {
          if (!reason) return;
          api("DELETE", "/api/expenses/" + e.id, { reason: reason }).then(function () { toast("Expense deleted.", "ok"); render(); }).catch(fail);
        });
      });
      if ((b = $("#d-restore", body))) b.addEventListener("click", function () {
        askReason("Restore " + e.expense_id, "The expense will be active again and counted in totals.", "Restore expense").then(function (reason) {
          if (!reason) return;
          api("POST", "/api/expenses/" + e.id + "/restore", { reason: reason }).then(function () { toast("Expense restored.", "ok"); render(); }).catch(fail);
        });
      });
      if ((b = $("#d-purge", body))) b.addEventListener("click", function () {
        askReason("Permanently delete " + e.expense_id, "This cannot be undone. Only the audit log entry will remain.", "Delete permanently", true).then(function (reason) {
          if (!reason) return;
          api("DELETE", "/api/expenses/" + e.id, { reason: reason, permanent: true }).then(function () { toast("Record permanently removed.", "ok"); render(); }).catch(fail);
        });
      });
    }).catch(fail);
  }

  // ------------------------------------------------------------------ exports for views.js
  global.EM = {
    $: $, $$: $$, esc: esc, fmtINR: fmtINR, fmtDate: fmtDate, fmtDateTime: fmtDateTime, can: can, api: api, fail: fail, toast: toast,
    openModal: openModal, closeModal: closeModal, askReason: askReason, navigate: navigate, qs: qs, setTitle: setTitle, render: render,
    state: state, USER: USER, META: META, views: views, loadCategories: loadCategories, categoryOptions: categoryOptions,
    openExpenseDetail: openExpenseDetail, openExpenseForm: openExpenseForm, openChangePassword: openChangePassword, PERIODS: PERIODS,
    categoryName: categoryName, todayISO: todayISO
  };

  document.addEventListener("DOMContentLoaded", function () {
    setupShell();
    render();
  });
})(window);
