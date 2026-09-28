// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
const message = document.getElementById("action-message");
async function refresh() {
  const response = await fetch(location.pathname, { cache: "no-store" });
  if (!response.ok) return;
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  document.getElementById("main").replaceWith(next.getElementById("main"));
  document.querySelector("footer").replaceWith(next.querySelector("footer"));
  if (location.pathname === "/jobs" && document.querySelector("[data-poll='1']")) schedulePoll();
}
async function post(route, data) {
  try {
    const response = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json", "X-Weaver-Studio": "1" }, body: JSON.stringify(data) });
    const result = await response.json();
    message.textContent = result.error || result.message || "The action finished.";
    if (response.ok) await refresh();
  } catch { message.textContent = "The local studio did not respond. Reload the page and try again."; }
  message.scrollIntoView({ block: "nearest" });
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "confirm-undo") { document.getElementById("undo-confirm").hidden = false; button.hidden = true; return; }
  if (action === "cancel-undo") { document.getElementById("undo-confirm").hidden = true; document.getElementById("undo-start").hidden = false; return; }
  if (action === "ruling") post("/api/rulings", { id: button.dataset.id, decision: button.dataset.decision });
  if (action === "approve") post("/api/approve", { chapter: Number(button.dataset.chapter), note: document.getElementById(button.dataset.note).value });
  if (action === "reject") post("/api/reject", { chapter: Number(button.dataset.chapter) });
  if (action === "undo") post("/api/undo", {});
  if (action === "accept-state") post("/api/state/accept", {});
  if (action === "review-job") post("/api/jobs", { kind: "review", chapter: Number(document.getElementById("review-chapter").value) });
  if (action === "bootstrap-job") post("/api/jobs", { kind: "bootstrap" });
});
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const response = await fetch("/api/jobs/current", { cache: "no-store" });
      if (response.ok) await refresh();
    } catch { message.textContent = "Job status is unavailable. Reload the page to reconnect."; }
  }, 2000);
}
if (location.pathname === "/jobs" && document.querySelector("[data-poll='1']")) schedulePoll();
