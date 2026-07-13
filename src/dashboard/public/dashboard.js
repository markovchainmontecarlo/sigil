const runsElement = document.querySelector("#runs");
const profilesElement = document.querySelector("#profiles");
const summaryElement = document.querySelector("#summary");
const connectionElement = document.querySelector("#connection");
const projectFilter = document.querySelector("#project-filter");
const stateFilter = document.querySelector("#state-filter");
const runsSection = document.querySelector("#runs-section");
const profilesSection = document.querySelector("#profiles-section");
const viewButtons = [...document.querySelectorAll("[data-view]")];
let snapshot = { runs: [], profiles: [] };
let currentSnapshot = snapshot;
let selectedView = "current";
setInterval(updateRelativeTimes, 1_000);

projectFilter.addEventListener("change", render);
stateFilter.addEventListener("change", render);
viewButtons.forEach((button) => button.addEventListener("click", () => void selectView(button.dataset.view)));

const source = new EventSource("/api/events");
source.addEventListener("open", () => { connectionElement.textContent = "Live"; });
source.addEventListener("error", () => { connectionElement.textContent = "Reconnecting"; });
source.addEventListener("snapshot", (event) => {
  snapshot = JSON.parse(event.data);
  if (selectedView !== "history") currentSnapshot = snapshot;
  updateFilters();
  render();
});

function render() {
  const visibleByView = currentSnapshot.runs.filter((run) => {
    if (selectedView === "attention") return run.category === "attention";
    if (selectedView === "archived") return run.archived;
    return true;
  });
  const runs = visibleByView.filter((run) => {
    return (!projectFilter.value || run.project === projectFilter.value)
      && (!stateFilter.value || run.health.state === stateFilter.value);
  });
  const active = snapshot.runs.filter((run) => run.category === "active").length;
  const problems = snapshot.runs.filter((run) => run.category === "attention").length;

  summaryElement.replaceChildren(
    summaryCard("Discovered", snapshot.discoveredRunCount ?? snapshot.runs.length),
    summaryCard("Showing", runs.length),
    summaryCard("Active", active),
    summaryCard("Needs attention", problems),
  );
  runsElement.replaceChildren(...(runs.length ? runs.map(runCard) : [element("p", "empty", "No matching runs.")]));
  profilesElement.replaceChildren(...snapshot.profiles.map(profileCard));
}

async function selectView(view) {
  selectedView = view;
  viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.view === view)));
  runsSection.hidden = view === "profiles";
  profilesSection.hidden = view !== "profiles";
  document.querySelector(".toolbar").hidden = view === "profiles";
  if (["history", "archived"].includes(view) && currentSnapshot.view !== "history") {
    connectionElement.textContent = "Loading history";
    currentSnapshot = await fetch("/api/history").then((response) => response.json());
    connectionElement.textContent = "Live";
  } else if (view !== "history") {
    currentSnapshot = snapshot;
  }
  updateFilters();
  render();
}

function runCard(run) {
  const card = element("article", "run");
  const title = run.project || run.workflow || run.id;
  const heading = element("h3", "", title);
  const state = element("span", `state ${run.health.state}`, run.health.state);
  const actions = element("div", "run-actions");
  actions.append(state);
  if (run.archived || !["running", "waiting", "starting"].includes(run.health.state)) {
    const archive = element("button", "archive", run.archived ? "Restore" : "Archive");
    archive.type = "button";
    archive.addEventListener("click", () => void setArchived(run, !run.archived));
    actions.append(archive);
  }
  const head = element("div", "run-head");
  head.append(heading, actions);
  card.append(head);

  const meta = element("div", "meta");
  [run.workflow, run.operation, run.binding, run.profile]
    .filter(Boolean)
    .forEach((value) => meta.append(element("span", "", value)));
  meta.append(relativeTime(run.lastActivity));
  card.append(meta);
  if (!run.dispatch) card.append(runMetrics(run));
  if (run.activity || run.gates?.length) {
    card.append(latestActivityPanel(run.activity, run.gates ?? [], run.events));
  }
  if (run.failure) card.append(element("p", "failure", run.failure));
  if (run.health.warning) card.append(element("p", "warning", run.health.warning));
  run.warnings.forEach((warning) => card.append(element("p", "warning", warning)));

  if (run.dispatch) {
    card.append(dispatchPanel(run.dispatch));
  } else if (run.backlogWork || run.work) {
    const plans = element("div", "plan-grid");
    if (run.backlogWork) plans.append(workPanel("Delivery plan", run.backlogWork));
    if (run.work) plans.append(workPanel("Current item", run.work));
    card.append(plans);
  }
  return card;
}

function dispatchPanel(dispatch) {
  const panel = element("section", "status-panel dispatch-panel");
  panel.append(element("h4", "", "Dispatch"));
  if (dispatch.goal) panel.append(element("p", "goal", dispatch.goal));
  panel.append(dispatchSummary(dispatch));
  const items = element("div", "dispatch-items");
  dispatch.items.forEach((item, index) => items.append(dispatchItem(item, index)));
  panel.append(dispatchControls(items), items);
  return panel;
}

function dispatchSummary(dispatch) {
  const summary = element("div", "dispatch-summary");
  const delivered = dispatch.items.filter((item) => item.status === "completed").length;
  const active = dispatch.items.filter((item) => item.status === "running").length;
  const upcoming = dispatch.items.length - delivered - active;
  summary.append(element("strong", "", `${delivered} of ${dispatch.items.length} work items delivered`));
  summary.append(element("span", "", `${active} in progress · ${upcoming} upcoming`));
  if (dispatch.estimatedRemainingMs !== undefined) {
    summary.append(element("span", "", `Current planned work: about ${formatDuration(dispatch.estimatedRemainingMs)} remaining`));
  }
  if (dispatch.unplannedItems) {
    summary.append(element("small", "", `${dispatch.unplannedItems} work item${dispatch.unplannedItems === 1 ? " is" : "s are"} not estimated until planned`));
  }
  return summary;
}

function dispatchControls(items) {
  const controls = element("div", "dispatch-controls");
  const completed = [...items.querySelectorAll(".dispatch-item-completed")];
  const toggle = element("button", "", "");
  toggle.type = "button";
  toggle.disabled = completed.length === 0;
  toggle.addEventListener("click", () => toggleCompletedWork(completed, toggle));
  completed.forEach((item) => {
    item.addEventListener("toggle", () => labelCompletedWorkToggle(completed, toggle));
  });
  labelCompletedWorkToggle(completed, toggle);
  controls.append(toggle);
  return controls;
}

function toggleCompletedWork(completed, toggle) {
  const open = !completed.some((item) => item.open);
  completed.forEach((item) => { item.open = open; });
  labelCompletedWorkToggle(completed, toggle);
}

function labelCompletedWorkToggle(completed, toggle) {
  if (!completed.length) {
    toggle.textContent = "No completed work";
    return;
  }
  if (completed.some((item) => item.open)) {
    toggle.textContent = "Collapse completed work";
    return;
  }
  toggle.textContent = "Expand completed work";
}

function dispatchItem(item, index) {
  const details = element("details", `dispatch-item dispatch-item-${item.status}`);
  details.open = true;
  const summary = element("summary", "dispatch-item-summary");
  const heading = element("span", "dispatch-item-heading");
  const title = element("span", "dispatch-item-title");
  title.append(
    element("small", "dispatch-item-label", `Work item ${index + 1}`),
    element("strong", "", item.title),
  );
  heading.append(
    element("span", "task-state", taskStatusSymbol(item.status)),
    title,
  );
  summary.append(heading, dispatchItemMeta(item));
  details.append(summary);
  if (item.work) {
    details.append(element("h5", "dispatch-task-heading", "Tasks"));
    details.append(workTaskList(item.work));
  } else {
    details.append(element("p", "dispatch-unplanned", "Task graph will be created during planning."));
  }
  return details;
}

function dispatchItemMeta(item) {
  const meta = element("span", "dispatch-item-meta");
  meta.append(
    element("span", "dispatch-item-status", dispatchItemStatus(item.status)),
    element("span", "", dispatchItemProgress(item)),
  );
  if (item.elapsedMs !== undefined) meta.append(element("span", "", `${formatDuration(item.elapsedMs)} elapsed`));
  if (item.estimatedRemainingMs !== undefined && item.status !== "completed") {
    meta.append(element("span", "", `About ${formatDuration(item.estimatedRemainingMs)} remaining`));
  }
  return meta;
}

function dispatchItemStatus(status) {
  if (status === "completed") return "Complete";
  if (status === "running") return "In progress";
  return "Upcoming";
}

function dispatchItemProgress(item) {
  if (item.progress?.total === undefined) return "Not planned";
  if (item.status === "completed") return `${item.progress.total} tasks completed`;
  return `${item.progress.completed} of ${item.progress.total} tasks complete`;
}

function workTaskList(work) {
  const list = element("ol", "work-tasks dispatch-task-list");
  work.tasks.forEach((task) => {
    const item = element("li", `task-${task.status}`);
    item.append(
      element("span", "task-state", taskStatusSymbol(task.status)),
      element("span", "task-title", task.title),
    );
    if (task.dependencies.length && ["blocked", "pending"].includes(task.status)) {
      item.title = `Depends on: ${task.dependencies.join(", ")}`;
    }
    list.append(item);
  });
  return list;
}

async function setArchived(run, archived) {
  const response = await fetch("/api/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: run.id, archived }),
  });
  if (!response.ok) {
    connectionElement.textContent = "Archive failed";
    return;
  }
  run.archived = archived;
  if (selectedView === "current" || selectedView === "attention" || selectedView === "archived") {
    currentSnapshot.runs = currentSnapshot.runs.filter((candidate) => candidate.id !== run.id);
  }
  render();
}

function profileCard(profile) {
  const card = element("article", "profile");
  card.append(
    element("strong", "", profile.name),
    element("div", "meta", `${profile.enabled ? "enabled" : "disabled"} · ${profile.profileClass}`),
    element("div", "", `${profile.activeAssignments} active · ${profile.capacityClass}`),
  );
  return card;
}

function latestActivityPanel(activity, gates, events) {
  const failed = gates.some((gate) => gate.outcome === "failed");
  const panel = element("section", `latest-status ${failed ? "latest-status-failed" : "latest-status-good"}`);
  panel.append(element("h4", "", "Latest activity"));
  if (activity) {
    panel.append(element("strong", "latest-status-title", activity.label));
    if (activity.detail) panel.append(element("p", "latest-status-detail", activity.detail));
  }
  if (gates.length) panel.append(gateList(gates));
  const history = activityHistory(events);
  if (history.length) panel.append(activityHistoryPanel(history));
  return panel;
}

function activityHistory(events) {
  return events
    .filter((event) => !["agent-started", "agent-completed"].includes(event.stage))
    .slice(-12)
    .map((event) => ({ text: eventLabel(event), tone: eventTone(event) }));
}

function activityHistoryPanel(items) {
  const section = element("section", "activity-history");
  section.append(element("h5", "", "Recent history"));
  const list = element("ol", "activity-history-list");
  items.forEach((item, index) => {
    const latest = index === items.length - 1;
    const row = element("li", `${item.tone}${latest ? " activity-history-latest" : ""}`);
    row.append(element("span", "activity-history-marker", latest ? "NEW" : ""));
    row.append(element("span", "", item.text));
    list.append(row);
  });
  section.append(list);
  queueMicrotask(() => { list.scrollTop = list.scrollHeight; });
  return section;
}

function eventTone(event) {
  if (event.details.outcome === "failed" || event.stage.includes("failed")) return "activity-bad";
  if (event.details.outcome === "passed" || event.stage.includes("completed")) return "activity-good";
  return "activity-neutral";
}

function eventLabel(event) {
  const time = formatTime(event.at);
  if (event.stage === "gate-started") return `${time} · ${gateLabel(event.details.gate)} started`;
  if (event.stage === "gate-completed") return `${time} · ${gateLabel(event.details.gate)} ${event.details.outcome || "completed"}`;
  if (event.stage === "task-started") return `${time} · Started ${event.details.task || "task"}`;
  if (event.stage === "task-completed") return `${time} · Completed ${event.details.task || "task"}`;
  if (event.stage === "task-failed") return `${time} · Failed ${event.details.task || "task"}`;
  if (event.stage === "final-verification") return `${time} · Final verification ${event.details.outcome || "started"}`;
  return `${time} · ${event.stage.replaceAll("-", " ")}`;
}

function gateLabel(gate) {
  if (gate === "build") return "Build";
  if (gate === "test") return "Unit tests";
  if (gate === "e2e") return "End-to-end tests";
  if (gate === "verify") return "Final verification";
  return gate || "Verification";
}

function runMetrics(run) {
  const metrics = element("section", "run-metrics");
  const activeDelivery = run.backlogWork?.tasks.findIndex((task) => task.status === "running") ?? -1;
  const deliveryValue = run.backlog?.total
    ? `${activeDelivery >= 0 ? activeDelivery + 1 : run.backlog.completed} of ${run.backlog.total}`
    : `${run.backlog?.completed ?? 0}`;
  metrics.append(metric("Delivery item", deliveryValue));
  if (run.tasks?.total !== undefined) metrics.append(metric("Implementation", `${run.tasks.completed} of ${run.tasks.total}`));
  if (run.gates?.length) metrics.append(metric("Checks passed", `${run.gates.filter((gate) => gate.outcome === "passed").length} of ${run.gates.length}`));
  metrics.append(metric("Last activity", relativeText(run.lastActivity), run.lastActivity));
  return metrics;
}

function metric(label, value, timestamp) {
  const card = element("div", "metric");
  card.append(element("span", "", label));
  const strong = element("strong", timestamp ? "relative-time" : "", value);
  if (timestamp) strong.dataset.timestamp = timestamp;
  card.append(strong);
  return card;
}

function workPanel(title, work) {
  const panel = element("section", "status-panel work-panel");
  panel.append(element("h4", "", title));
  if (work.goal) panel.append(element("p", "goal", work.goal));
  panel.append(workTaskList(work));
  return panel;
}

function gateList(gates) {
  const list = element("ul", "gates");
  gates.forEach((gate) => {
    const suffix = gate.exitCode === undefined ? "" : ` · exit ${gate.exitCode}`;
    const item = element("li", `gate-${gate.outcome}`, `${gate.name}: ${gate.outcome}${suffix}`);
    if (gate.command) item.title = gate.command;
    list.append(item);
  });
  return list;
}

function taskStatusSymbol(status) {
  if (status === "completed") return "✓";
  if (status === "running") return "●";
  if (status === "failed") return "✗";
  return "○";
}

function summaryCard(label, value) {
  const card = document.createElement("article");
  card.append(element("span", "meta", label), element("strong", "", String(value)));
  return card;
}

function updateFilters() {
  syncOptions(projectFilter, currentSnapshot.runs.map((run) => run.project).filter(Boolean));
  syncOptions(stateFilter, currentSnapshot.runs.map((run) => run.health.state));
}

function syncOptions(select, values) {
  const current = select.value;
  const unique = [...new Set(values)].sort();
  select.replaceChildren(new Option("All", ""), ...unique.map((value) => new Option(value, value)));
  select.value = unique.includes(current) ? current : "";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function relativeTime(value) {
  const node = element("span", "relative-time", `Updated ${relativeText(value)}`);
  node.dataset.timestamp = value;
  node.dataset.prefix = "Updated ";
  return node;
}

function updateRelativeTimes() {
  document.querySelectorAll(".relative-time").forEach((node) => {
    node.textContent = `${node.dataset.prefix || ""}${relativeText(node.dataset.timestamp)}`;
  });
}

function relativeText(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 5_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function formatTime(value) {
  if (!value) return "Unknown time";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value) {
  const minutes = Math.max(1, Math.round(value / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
