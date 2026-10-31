// Applies the admin theme before the page draws, so a dark choice doesn't flash
// white first. An external file because the admin CSP allows no inline script.
// Versioned name: /_admin/assets/*.js is cached as immutable (public/_headers);
// a change needs a new file name and the reference in _admin/index.html updated.
(function () {
  try {
    var t = localStorage.getItem("theme");
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    var a = localStorage.getItem("accent");
    if (a && /^#[0-9a-f]{6}$/i.test(a)) document.documentElement.style.setProperty("--accent-base", a);
  } catch (e) {
    // Storage blocked: the system theme and default accent apply.
  }
})();
