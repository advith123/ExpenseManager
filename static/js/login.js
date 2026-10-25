(function () {
  "use strict";
  var form = document.getElementById("login-form");
  var errorBox = document.getElementById("login-error");
  var submit = document.getElementById("login-submit");
  var csrf = document.querySelector('meta[name="csrf-token"]').getAttribute("content");
  var password = document.getElementById("password");

  document.getElementById("toggle-password").addEventListener("click", function () {
    var show = password.type === "password";
    password.type = show ? "text" : "password";
    this.textContent = show ? "Hide" : "Show";
    this.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    var username = form.username.value.trim();
    var pwd = form.password.value;
    if (!username || !pwd) {
      showError("Enter your username and password.");
      return;
    }
    submit.disabled = true;
    submit.textContent = "Signing in…";
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ username: username, password: pwd }),
      credentials: "same-origin"
    }).then(function (r) {
      return r.json().then(function (data) { return { ok: r.ok, data: data }; });
    }).then(function (res) {
      if (!res.ok) {
        showError(res.data.error || "Sign in failed.");
        submit.disabled = false;
        submit.textContent = "Sign in";
        form.password.value = "";
        form.password.focus();
        return;
      }
      var next = new URLSearchParams(location.search).get("next");
      location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    }).catch(function () {
      showError("Could not reach the server. Check your connection.");
      submit.disabled = false;
      submit.textContent = "Sign in";
    });
  });
})();
