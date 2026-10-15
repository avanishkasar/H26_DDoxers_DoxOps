"use strict";

const fileInput = document.querySelector("#capsule-file");
const emptyState = document.querySelector("#empty-state");
const workspace = document.querySelector("#workspace");
const loadError = document.querySelector("#load-error");
const dependencyList = document.querySelector("#dependency-list");
const detailPanel = document.querySelector("#detail-panel");
const searchInput = document.querySelector("#dependency-search");
const statusFilter = document.querySelector("#status-filter");
const noMatches = document.querySelector("#no-matches");
const dependencyHint = document.querySelector("#dependency-hint");
const workflow = document.querySelector("#workflow");

let capsuleData = null;
let selectedDependency = null;
let currentStep = 1;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function labelStatus(value) {
  return String(value || "unknown").replaceAll("-", " ");
}

function provenanceTag(value) {
  const normalized = String(value || "observed").toLowerCase();
  const safe = ["observed", "verified", "ai"].includes(normalized) ? normalized : "observed";
  return `<span class="provenance provenance-${safe}">${safe.toUpperCase()}</span>`;
}

function evidenceDetails(ids = []) {
  const evidenceById = new Map((capsuleData.evidence || []).map((item) => [item.id, item]));
  return ids.map((id) => {
    const item = evidenceById.get(id);
    if (!item) return `<span class="status-label">Evidence ${escapeHtml(id)} unavailable</span>`;
    const command = (item.command || []).join(" ");
    const excerpt = item.excerpt || "No log excerpt recorded.";
    return `<details><summary>${escapeHtml(item.id)}</summary><div class="evidence-content">
      <p><strong>Command</strong> <code>${escapeHtml(command || "Not recorded")}</code></p>
      <p><strong>Exit</strong> ${item.exit_code === null || item.exit_code === undefined ? "not recorded" : escapeHtml(item.exit_code)}
        · <strong>Duration</strong> ${Number(item.duration_s || 0).toFixed(2)}s${item.timed_out ? " · timed out" : ""}</p>
      <p><strong>Log SHA-256</strong> <code>${escapeHtml(item.log_sha256 || "not recorded")}</code></p>
      <pre>${escapeHtml(excerpt)}</pre>
    </div></details>`;
  }).join("");
}

function factMarkup(fact) {
  if (!fact) return "";
  const text = typeof fact === "string" ? fact : fact.text;
  const provenance = typeof fact === "string" ? "observed" : fact.provenance;
  const evidenceIds = typeof fact === "string" ? [] : fact.evidence_ids || [];
  return `<li class="fact">${provenanceTag(provenance)}<div class="fact-body"><p>${escapeHtml(text)}</p>
    ${evidenceIds.length ? `<div class="evidence-refs" aria-label="Supporting evidence">${evidenceDetails(evidenceIds)}</div>` : ""}</div></li>`;
}

function sectionCard(title, body, className = "") {
  if (!body) return "";
  const id = title === "Verification results" ? ' id="verification-results"' : "";
  return `<section${id} class="detail-card ${className}"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function factSection(title, facts) {
  const items = (facts || []).filter(Boolean);
  if (!items.length) return "";
  return sectionCard(title, `<ul class="plain-list fact-list">${items.map(factMarkup).join("")}</ul>`);
}

function usageMarkup(sites = [], runtime = []) {
  const staticRows = sites.map((site) => `<li class="usage-row">
    <span>${provenanceTag(site.provenance)}</span><code>${escapeHtml(site.file)}:${escapeHtml(site.line)}</code>
    <p>${escapeHtml(site.kind)}${site.module ? ` · ${escapeHtml(site.module)}` : ""}${site.symbol ? ` · ${escapeHtml(site.symbol)}` : ""}</p>
    ${site.snippet ? `<p class="mono">${escapeHtml(site.snippet)}</p>` : ""}
  </li>`);
  const runtimeRows = runtime.map((call) => `<li class="usage-row"><span class="status-label">VERIFIED RUNTIME</span>
    <code>${escapeHtml(call.caller_file)}:${escapeHtml(call.caller_line)}</code>
    <p>${escapeHtml(call.module)}.${escapeHtml(call.function)} · ${escapeHtml(call.count)} calls</p></li>`);
  if (!staticRows.length && !runtimeRows.length) return "<p class='muted'>No usage sites were recorded.</p>";
  return `<ul class="plain-list">${staticRows.concat(runtimeRows).join("")}</ul>`;
}

function comparisonMarkup(comparisons = []) {
  if (!comparisons.length) return "<p class='muted'>No migration comparisons were recorded.</p>";
  return `<div class="comparison-table-wrap"><table class="comparison-table"><thead><tr><th>Python</th><th>Fixed</th><th>Regressed</th><th>Still failing</th><th>Warnings</th></tr></thead><tbody>
    ${comparisons.map((item) => `<tr><td>${escapeHtml(item.python)}</td><td>${escapeHtml(item.fixed)}</td><td>${escapeHtml(item.regressed)}</td>
      <td>${escapeHtml(item.still_failing)}</td><td>${escapeHtml(item.warnings_before)} → ${escapeHtml(item.warnings_after)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

function attemptMarkup(attempts = []) {
  if (!attempts.length) return "<p class='muted'>No migration attempts recorded.</p>";
  return attempts.map((attempt) => {
    const plan = attempt.plan;
    const replacement = plan?.replacement;
    const replacementText = replacement ? `${replacement.strategy}${replacement.package ? ` · ${replacement.package}` : ""}${replacement.version_spec ? ` ${replacement.version_spec}` : ""}` : "No plan returned.";
    return `<article class="attempt-card"><div class="attempt-heading"><strong>Attempt ${escapeHtml(attempt.attempt)}</strong>
      <span>${attempt.accepted ? "Accepted" : "Not accepted"}${attempt.verdict ? ` · ${escapeHtml(attempt.verdict)}` : ""}</span></div>
      <p>${provenanceTag("ai")} ${escapeHtml(replacementText)}</p>
      ${plan?.rationale ? `<p>${escapeHtml(plan.rationale)}</p>` : ""}
      ${attempt.comparisons?.length ? comparisonMarkup(attempt.comparisons) : ""}</article>`;
  }).join("");
}

function renderSummary() {
  const target = capsuleData.target || {};
  const risks = capsuleData.risks || [];
  const capsules = capsuleData.capsules || [];
  const atRisk = risks.filter((risk) => risk.at_risk).length;
  const verified = capsules.filter((item) => item.status === "verified").length;
  const model = capsuleData.model ? `${capsuleData.model.model} · ${capsuleData.model.provider}` : "No model recorded";
  const meta = [
    ["Target", target.source || "Not recorded"],
    ["Commit", target.commit || "Not recorded"],
    ["Python", (target.pythons || []).join(", ") || "Not recorded"],
    ["Generated", capsuleData.generated_at || "Not recorded"],
    ["Model", model],
  ];
  document.querySelector("#run-meta").innerHTML = meta.map(([label, value]) =>
    `<span class="meta-item"><strong>${escapeHtml(label)}:</strong> <span class="mono">${escapeHtml(value)}</span></span>`).join("");
  document.querySelector("#run-stats").innerHTML = [
    ["Dependencies", risks.length], ["At risk", atRisk], ["Verified migrations", `${verified} / ${capsules.length}`], ["Evidence records", (capsuleData.evidence || []).length],
  ].map(([label, value]) => `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value">${escapeHtml(value)}</strong></div>`).join("");
  document.querySelector("#dependency-count").textContent = String(capsules.length);
}

function renderWorkflow() {
  workflow.querySelectorAll("[data-step]").forEach((button) => {
    const step = Number(button.dataset.step);
    button.dataset.state = step < currentStep ? "complete" : step === currentStep ? "current" : "upcoming";
    if (step === currentStep) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
    button.disabled = step > currentStep;
  });
  dependencyHint.textContent = selectedDependency
    ? `Selected: ${selectedDependency}. Choose another finding to compare.`
    : "Select a dependency to inspect its capsule.";
}

function renderDependencyList() {
  const search = searchInput.value.trim().toLowerCase();
  const status = statusFilter.value;
  const capsules = capsuleData.capsules || [];
  const risks = new Map((capsuleData.risks || []).map((risk) => [risk.name.toLowerCase(), risk]));
  const filtered = capsules.filter((item) => {
    const risk = risks.get(item.dependency.toLowerCase()) || item.risk || {};
    const searchText = [item.dependency, risk.severity, ...(risk.indicators || []).map((indicator) => indicator.title)].join(" ").toLowerCase();
    return (status === "all" || item.status === status) && (!search || searchText.includes(search));
  }).sort((a, b) => (b.risk?.score || 0) - (a.risk?.score || 0) || a.dependency.localeCompare(b.dependency));
  dependencyList.innerHTML = filtered.map((item) => {
    const selected = selectedDependency === item.dependency;
    const severity = item.risk?.severity || "none";
    return `<button class="dependency-option" type="button" aria-pressed="${selected}" data-dependency="${escapeHtml(item.dependency)}">
      <span class="dependency-name">${escapeHtml(item.dependency)}</span><span class="dependency-score">${escapeHtml(item.risk?.score ?? 0)}</span>
      <span class="dependency-sub"><span class="severity-${escapeHtml(severity)}">${escapeHtml(severity)}</span><span>·</span><span>${escapeHtml(labelStatus(item.status))}</span></span>
    </button>`;
  }).join("");
  noMatches.hidden = filtered.length !== 0;
  if (selectedDependency && !filtered.some((item) => item.dependency === selectedDependency)) {
    selectedDependency = null;
    currentStep = 2;
    renderWorkflow();
  }
  dependencyList.querySelectorAll("[data-dependency]").forEach((button) => button.addEventListener("click", () => {
    selectedDependency = button.dataset.dependency;
    currentStep = 3;
    renderDependencyList();
    renderWorkflow();
    renderSelectedDependency();
  }));
  dependencyList.querySelectorAll("[data-dependency]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.dependency === selectedDependency));
  });
  if (selectedDependency) {
    renderSelectedDependency();
  } else if (filtered.length === 0) {
    detailPanel.innerHTML = `<section class="detail-card detail-empty"><span class="detail-empty-icon" aria-hidden="true">—</span><h2>No dependency matches</h2><p>Change the search or status filter to see capsule details.</p></section>`;
  } else {
    detailPanel.innerHTML = `<section class="detail-card detail-empty"><span class="detail-empty-icon" aria-hidden="true">02</span><h2>Choose a dependency to begin</h2><p>Start with a high-risk item, then follow its usage and verification evidence.</p></section>`;
  }
}

function renderSelectedDependency() {
  const item = (capsuleData.capsules || []).find((entry) => entry.dependency === selectedDependency);
  if (!item) return;
  const risk = item.risk || {};
  const score = Number(risk.score || 0);
  const plan = item.attempts?.find((attempt) => attempt.plan)?.plan;
  const proposed = item.proposed_replacement;
  const riskIndicators = (risk.indicators || []).map((indicator) => `<li class="fact">
    ${provenanceTag(indicator.provenance)}<div class="fact-body"><p><strong>${escapeHtml(indicator.title)}</strong> · +${escapeHtml(indicator.weight)}</p>
      <p>${escapeHtml(indicator.detail)}</p>${indicator.evidence_ids?.length ? `<div class="evidence-refs">${evidenceDetails(indicator.evidence_ids)}</div>` : ""}</div></li>`).join("");
  const attemptBody = `<div>${attemptMarkup(item.attempts)}</div>`;
  const declarations = (item.declarations || []).map((declaration) => `${declaration.raw || declaration.name} (${declaration.source_file}${declaration.line ? `:${declaration.line}` : ""})`).join(" · ");
  const metadata = item.metadata ? `<p class="muted">Pinned ${escapeHtml(item.metadata.pinned_version || "unknown")} · Latest ${escapeHtml(item.metadata.latest_version || "unknown")}${item.metadata.project_status ? ` · ${escapeHtml(item.metadata.project_status)}` : ""}</p>` : "";
  detailPanel.innerHTML = `
    <section class="detail-card">
      <div class="detail-heading"><div><p class="eyebrow">DEPENDENCY CAPSULE</p><h2>${escapeHtml(item.dependency)}</h2></div>
        <span class="status-chip" data-status="${escapeHtml(item.status)}">${escapeHtml(labelStatus(item.status))}</span></div>
      <div class="risk-row"><strong class="severity-${escapeHtml(risk.severity || "none")}">${escapeHtml(risk.severity || "No risk rating")}</strong>
        <span>${escapeHtml(score)} / 100 risk score</span><span class="risk-meter" aria-label="Risk score ${escapeHtml(score)} out of 100"><span data-severity="${escapeHtml(risk.severity || "none")}" style="width:${Math.max(0, Math.min(100, score))}%"></span></span></div>
      ${declarations ? `<p class="muted subhead">Declared as</p><p class="mono">${escapeHtml(declarations)}</p>` : ""}${metadata}
    </section>
    ${proposed ? sectionCard("Proposed replacement", `<ul class="plain-list fact-list">${factMarkup(proposed)}</ul>`) : ""}
    ${factSection("Analysis", item.analysis ? [item.analysis] : [])}
    ${factSection("Rationale", item.rationale ? [item.rationale] : [])}
    ${factSection("Migration steps", item.migration_steps)}
    ${factSection("Suggested tests", item.suggested_tests)}
    ${riskIndicators ? sectionCard("Risk signals", `<ul class="plain-list fact-list">${riskIndicators}</ul>`) : ""}
    ${sectionCard("Where it is used", usageMarkup(item.usage, item.runtime_usage))}
    ${sectionCard("Verification results", comparisonMarkup(item.executed_results))}
    ${sectionCard("Migration attempts", attemptBody)}
    ${factSection("Compatibility gaps", item.compatibility_gaps)}
    ${factSection("Open concerns", item.open_concerns)}
  `;
}

function validateCapsule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The file must contain a JSON object.");
  if (value.schema_version !== "1.0") throw new Error("This viewer supports capsule schema version 1.0.");
  if (!Array.isArray(value.capsules) || !Array.isArray(value.evidence)) throw new Error("The JSON is missing the capsules or evidence list. Open a DoxOps capsule.json.");
  for (const [index, item] of value.capsules.entries()) {
    if (!item || typeof item.dependency !== "string" || !item.risk || typeof item.status !== "string") {
      throw new Error(`Capsule entry ${index + 1} is missing its dependency, risk, or status fields.`);
    }
  }
  return value;
}

async function loadFile(file) {
  loadError.hidden = true;
  try {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) throw new Error("This file is over 20 MB. Choose a smaller capsule.json.");
    const parsed = validateCapsule(JSON.parse(await file.text()));
    capsuleData = parsed;
    selectedDependency = null;
    currentStep = 2;
    emptyState.hidden = true;
    workspace.hidden = false;
    renderSummary();
    renderDependencyList();
    renderWorkflow();
  } catch (error) {
    workspace.hidden = true;
    emptyState.hidden = false;
    loadError.textContent = `${error.message} Choose a valid DoxOps capsule.json to try again.`;
    loadError.hidden = false;
  } finally {
    fileInput.value = "";
  }
}

fileInput.addEventListener("change", () => loadFile(fileInput.files?.[0]));
document.querySelector("#change-file").addEventListener("click", () => fileInput.click());
workflow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-step]");
  if (!button || button.disabled) return;
  const step = Number(button.dataset.step);
  if (step === 1) fileInput.click();
  if (step === 2) document.querySelector("#dependency-search").focus({ preventScroll: true });
  if (step === 3) document.querySelector("#verification-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
searchInput.addEventListener("input", renderDependencyList);
statusFilter.addEventListener("change", renderDependencyList);
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
