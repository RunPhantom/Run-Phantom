const counter = document.getElementById("counter");
document.getElementById("increment").addEventListener("click", async () => {
  try { counter.textContent = String(await window.__TAURI__.core.invoke("fixture_increment")); }
  catch { document.getElementById("status").textContent = "Cooperating action unavailable"; }
});
let currentRender;
const frame = () => new Promise(resolve => window.requestAnimationFrame(resolve));
const render = async ticket => {
  if (!ticket || Object.keys(ticket).sort().join() !== "generation,id,sequence,value,version" || ticket.version !== 1
    || typeof ticket.id !== "string" || ticket.id.length !== 36 || !Number.isSafeInteger(ticket.generation) || ticket.generation < 0
    || !Number.isSafeInteger(ticket.value) || !Number.isSafeInteger(ticket.sequence) || ticket.sequence < 0) throw new Error("Invalid fixture render");
  currentRender = ticket;
  counter.textContent = String(ticket.value); counter.dataset.sequence = String(ticket.sequence);
  // A frame acknowledgement gates capture; actual OS pixels remain a separate native oracle.
  await frame(); await frame();
  if (currentRender !== ticket || counter.textContent !== String(ticket.value) || counter.dataset.sequence !== String(ticket.sequence)) throw new Error("Superseded fixture render");
  await window.__TAURI__.core.invoke("fixture_rendered", { ack: ticket });
};
void (async () => {
  await window.__TAURI__.event.listen("fixture-state", event => {
    void render(event.payload).catch(() => { document.getElementById("status").textContent = "Cooperating render unavailable"; });
  });
  await window.__TAURI__.core.invoke("fixture_ready");
})().catch(() => { document.getElementById("status").textContent = "Cooperating readiness unavailable"; });
