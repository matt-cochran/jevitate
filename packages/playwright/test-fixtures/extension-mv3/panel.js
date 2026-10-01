// #256 fixture: the button writes to chrome.storage, then shows what was stored.
document.getElementById("consent").addEventListener("click", async () => {
  await chrome.storage.local.set({ consent: "given" });
  const { consent } = await chrome.storage.local.get("consent");
  document.getElementById("status").textContent = `consent ${consent}`;
});
