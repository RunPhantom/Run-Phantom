/* global window, document */
(function () {
  var preference = null;
  try { preference = window.localStorage.getItem("runphantom:theme"); } catch { preference = null; }
  var dark = preference === "dark" || (preference === "system" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (!dark) return;
  var root = document.documentElement;
  root.setAttribute("data-theme", "dark");
  root.style.backgroundColor = "#0B0D12";
  root.style.color = "#E8EBF2";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", "#0B0D12");
})();
