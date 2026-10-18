const counter = document.getElementById("counter");
document.getElementById("increment").addEventListener("click", async () => {
  try { counter.textContent = String(await window.__TAURI__.core.invoke("fixture_increment")); }
  catch { document.getElementById("status").textContent = "Cooperating action unavailable"; }
});
void window.__TAURI__.event.listen("fixture-state", event => { counter.textContent = String(event.payload); });
