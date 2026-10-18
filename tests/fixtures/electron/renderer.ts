document.querySelector("#confirm")!.addEventListener("click", () => {
  const status = document.querySelector("#status")!;
  status.id = "complete";
  status.textContent = "The scoped application action completed.";
});
