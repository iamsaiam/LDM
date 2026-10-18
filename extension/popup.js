const extensionApi = globalThis.browser ?? globalThis.chrome;
const transferMetrics = globalThis.LdmTransferMetrics;
const DOWNLOAD_HISTORY_KEY = "downloadHistory";
const streamsElement = document.querySelector("#streams");
const statusElement = document.querySelector("#status");
const titleElement = document.querySelector("#page-title");
const transfersElement = document.querySelector("#transfers");
const transferCountElement = document.querySelector("#transfer-count");
const clearHistoryButton = document.querySelector("#clear-history");
const activeDownloadControls = new Map();
const transferCards = new Map();
let activeTabId = null;
let olderHistoryNotice = null;

function safeFilename(value) {
  const cleaned = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "";
}

function setStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${kind}`.trim();
}

async function notifyDownload(title, message) {
  if (!extensionApi.notifications) return;
  try {
    await extensionApi.notifications.create(`ldm-${Date.now()}`, {
      type: "basic",
      iconUrl: extensionApi.runtime.getURL("notification.svg"),
      title,
      message
    });
  } catch (error) {
    console.error("Could not show LDM notification:", error);
  }
}

function streamCard(stream) {
  const card = document.createElement("article");
  card.className = "stream-card";

  const info = document.createElement("div");
  info.className = "stream-info";
  const filename = document.createElement("p");
  filename.className = "stream-name";
  filename.textContent = stream.filename || "download.bin";
  filename.title = stream.url;

  const meta = document.createElement("div");
  meta.className = "stream-meta";
  const quality = document.createElement("span");
  quality.className = "badge";
  quality.textContent = stream.resolution || "Unknown quality";
  const type = document.createElement("span");
  type.className = "type-label";
  type.textContent = stream.contentType || "media stream";
  const format = document.createElement("span");
  format.className = "format-badge";
  format.textContent = (stream.manifestFormat || "direct").toUpperCase();
  meta.append(quality, format, type);
  info.append(filename, meta);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button";
  const buttonIcon = document.createElement("span");
  buttonIcon.className = "download-button-icon";
  buttonIcon.setAttribute("aria-hidden", "true");
  buttonIcon.textContent = "↓";
  const buttonLabel = document.createElement("span");
  buttonLabel.textContent = stream.manifestFormat ? "Choose" : "Download";
  button.append(buttonIcon, buttonLabel);

  const progress = createProgressState();
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "cancel-transfer";
  pause.textContent = "Pause";
  pause.hidden = true;
  const controls = { button, buttonIcon, buttonLabel, progress, filename, pause, quality, format, downloadId: "", status: "" };
  pause.addEventListener("click", () => void controlLiveDownload(controls));
  button.addEventListener("click", () => {
    if (controls.downloadId) void cancelLiveDownload(controls);
    else void prepareDownload(stream, controls, card);
  });
  const actions = document.createElement("div");
  actions.className = "stream-actions";
  actions.append(pause, button);
  card.append(info, actions, progress.root);
  return card;
}

async function prepareDownload(stream, controls, card) {
  if (stream.manifestFormat && !controls.picker) {
    controls.button.disabled = true;
    setButton(controls, "Inspecting…");
    try {
      const result = await extensionApi.runtime.sendMessage({ type: "ldm:inspect-stream", stream, tabId: activeTabId });
      if (result?.error) throw new Error(result.error);
      controls.picker = globalThis.LdmMediaOptions.createPicker(document, result, (selection) => {
        const video = result.streams.find((track) => track.index === selection.video_stream_index);
        controls.quality.textContent = selection.audio_only ? "Audio only" : video?.height ? `${video.height}p` : "Best available";
        controls.format.textContent = selection.output_format.toUpperCase();
      });
      card.append(controls.picker.root);
      setButton(controls, "Download", true);
      setStatus("Choose a verified quality, audio track and file format, then Download.");
    } catch (error) {
      setButton(controls, "Choose");
      setStatus(error.message || "Could not inspect this playlist.", "error");
    }
    controls.button.disabled = false;
    return;
  }
  const selection = controls.picker?.value() ?? {};
  const video = controls.picker?.inspected.streams.find((track) => track.index === selection.video_stream_index);
  const selected = { ...stream, ...selection,
    ...(stream.manifestFormat ? { resolution: selection.audio_only ? "Audio only" : video?.height ? `${video.height}p` : "Best available" } : {}),
    ...(stream.manifestFormat ? { filename: globalThis.LdmMediaOptions.filename(stream.filename, selection) } : {}) };
  await startDownload(selected, controls);
}

async function controlLiveDownload(controls) {
  controls.pause.disabled = true;
  try {
    const action = controls.status === "paused" ? "resume" : "pause";
    const result = await extensionApi.runtime.sendMessage({ type: `ldm:${action}-download`, id: controls.downloadId });
    if (result?.error) throw new Error(result.error);
    controls.status = result.status;
    controls.pause.textContent = result.status === "paused" ? "Resume" : "Pause";
  } catch (error) { setStatus(error.message, "error"); }
  controls.pause.disabled = false;
}

async function cancelLiveDownload(controls) {
  controls.button.disabled = true;
  try {
    const result = await extensionApi.runtime.sendMessage({ type: "ldm:cancel-download", id: controls.downloadId });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    controls.button.disabled = false;
    setStatus(error.message, "error");
  }
}

function createProgressState() {
  const root = document.createElement("div");
  root.className = "download-state";
  root.hidden = true;

  const label = document.createElement("div");
  label.className = "progress-label";
  const primary = document.createElement("span");
  const detail = document.createElement("span");
  label.append(primary, detail);

  const track = document.createElement("div");
  track.className = "progress-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", "Download progress");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("span");
  fill.className = "progress-fill";
  track.append(fill);
  const metrics = document.createElement("dl");
  metrics.className = "transfer-metrics";
  metrics.hidden = true;
  const values = {};
  for (const [key, title] of [["size", "Transferred"], ["speed", "Speed"], ["eta", "Remaining"]]) {
    const item = document.createElement("div");
    const caption = document.createElement("dt");
    caption.textContent = title;
    const value = document.createElement("dd");
    value.textContent = "—";
    item.append(caption, value);
    metrics.append(item);
    values[key] = { caption, value };
  }
  root.append(label, track, metrics);
  return { root, primary, detail, track, fill, metrics, values };
}

function setProgress(controls, { label, detail = "", percent = null, indeterminate = false, state = "", metrics = null }) {
  const progress = controls.progress;
  progress.root.hidden = false;
  progress.root.classList.toggle("is-complete", state === "complete");
  progress.root.classList.toggle("is-error", state === "error");
  progress.primary.textContent = label;
  progress.detail.textContent = detail;
  progress.metrics.hidden = !metrics;
  if (metrics) {
    progress.values.size.caption.textContent = metrics.manifest ? "Output" : "Transferred";
    for (const key of ["size", "speed", "eta"]) {
      progress.values[key].value.textContent = metrics[key];
      progress.values[key].value.title = metrics[key];
    }
  }
  progress.fill.classList.toggle("is-indeterminate", indeterminate);
  if (percent !== null && Number.isFinite(percent)) {
    const bounded = Math.max(0, Math.min(100, percent));
    progress.fill.style.width = `${bounded}%`;
    progress.track.setAttribute("aria-valuenow", String(Math.round(bounded)));
  } else {
    progress.fill.style.removeProperty("width");
    progress.track.removeAttribute("aria-valuenow");
  }
  progress.track.setAttribute("aria-valuetext", [label, detail,
    ...(metrics ? [metrics.size, metrics.speed, metrics.eta] : [])].filter(Boolean).join(", "));
}

function setButton(controls, label, icon = false) {
  controls.buttonLabel.textContent = label;
  controls.buttonIcon.hidden = !icon;
}

async function getActiveTab() {
  const tabs = await extensionApi.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function loadStreams() {
  streamsElement.replaceChildren();
  setStatus("");
  try {
    const tab = await getActiveTab();
    if (!tab || !Number.isInteger(tab.id)) {
      activeTabId = null;
      titleElement.textContent = "No active tab";
      setStatus("Open a page and play or load media to detect streams.");
      return;
    }
    activeTabId = tab.id;
    titleElement.textContent = tab.title || tab.url || "Current tab";
    const result = await extensionApi.runtime.sendMessage({
      type: "ldm:get-streams",
      tabId: tab.id
    });
    if (result?.error) throw new Error(result.error);
    const streams = result?.streams ?? [];
    if (streams.length === 0) {
      setStatus(
        "No supported complete media file or HLS/DASH playlist detected. Start playback and refresh. "
        + "Individual media segments are not listed."
      );
      return;
    }
    for (const stream of streams) streamsElement.append(streamCard(stream));
    setStatus(`${streams.length} stream${streams.length === 1 ? "" : "s"} detected.`);
  } catch (error) {
    setStatus(error.message || "Could not load detected streams.", "error");
  }
}

async function startDownload(stream, controls) {
  const { button } = controls;
  if (!Number.isInteger(activeTabId)) {
    setStatus("Open a supported page before queueing this download.", "error");
    return;
  }
  const id = globalThis.crypto.randomUUID();
  activeDownloadControls.set(id, { controls, stream });
  controls.downloadId = id;
  controls.status = "queued";
  controls.pause.hidden = false;
  button.disabled = false;
  setButton(controls, "Cancel");
  setProgress(controls, { label: "Waiting in queue", detail: "Preparing request", indeterminate: true });
  setStatus("Adding download to the local queue…");

  try {
    const response = await extensionApi.runtime.sendMessage({
      type: "ldm:download-stream",
      id,
      tabId: activeTabId,
      stream
    });
    if (!response?.accepted) throw new Error(response?.error || "LDM did not accept the download.");
  } catch (error) {
    const message = error.message || "Download request failed.";
    activeDownloadControls.delete(id);
    controls.downloadId = "";
    controls.pause.hidden = true;
    setStatus(message, "error");
    button.disabled = false;
    setButton(controls, "Retry", true);
    setProgress(controls, { label: "Download failed", detail: message, state: "error" });
    await notifyDownload("LDM download failed", message);
  }
}

async function handleDownloadEvent(id, event, controls, stream) {
  const { button } = controls;
  if (typeof event.output_filename === "string" && safeFilename(event.output_filename)) {
    stream.filename = safeFilename(event.output_filename);
    controls.filename.textContent = stream.filename;
    controls.filename.title = stream.filename;
  }
  if (event.event === "queued") {
    controls.status = "queued";
    controls.pause.textContent = "Pause";
    setButton(controls, "Cancel");
    setProgress(controls, {
      label: "Waiting in queue",
      detail: event.position > 0 ? `Position ${event.position}` : "Next available slot",
      indeterminate: true
    });
    setStatus(event.position > 0 ? `Download queued · position ${event.position}` : "Download queued.");
  } else if (event.event === "started" || event.event === "resumed") {
    controls.status = "downloading";
    controls.pause.textContent = "Pause";
    setButton(controls, "Cancel");
    setProgress(controls, { label: "Download started", detail: "Waiting for progress", indeterminate: true });
    setStatus("Download started.");
  } else if (event.event === "paused") {
    controls.status = "paused";
    controls.pause.textContent = "Resume";
    setProgress(controls, { label: "Download paused", detail: "Resume when ready", percent: controls.lastMetrics?.percent ?? null,
      metrics: controls.lastMetrics ? { ...controls.lastMetrics, speed: "—", eta: "Paused" } : null });
  } else if (event.event === "progress") {
    if (["paused", "cancelling"].includes(controls.status)) return;
    const metrics = transferMetrics.describe(transferMetrics.fromEvent(event));
    controls.lastMetrics = metrics;
    const progressLabel = metrics.manifest ? `Processing ${(event.phase || "stream").toUpperCase()}` : "Downloading";
    const detail = metrics.percent === null ? "In progress" : `${metrics.percent.toFixed(1)}%`;
    setProgress(controls, {
      label: progressLabel,
      detail,
      percent: metrics.percent,
      indeterminate: metrics.percent === null,
      metrics
    });
    setStatus(`${progressLabel} · ${metrics.size} · ${metrics.eta}`);
  } else if (event.event === "completed") {
    setStatus("Download completed successfully.", "success");
    setButton(controls, "Completed");
    button.disabled = true;
    setProgress(controls, { label: "Download complete", detail: "File saved successfully", percent: 100, state: "complete" });
    await notifyDownload("LDM download complete", stream.filename || "Your media download is ready.");
    activeDownloadControls.delete(id);
    controls.downloadId = "";
    controls.pause.hidden = true;
  } else if (event.event === "cancelling") {
    controls.status = "cancelling";
    controls.pause.hidden = true;
    setButton(controls, "Stopping…");
    button.disabled = true;
    setProgress(controls, { label: "Stopping download", detail: "Finishing safely…", indeterminate: true });
  } else if (event.event === "cancelled") {
    setButton(controls, "Cancelled");
    button.disabled = true;
    setProgress(controls, { label: "Download cancelled", detail: "Transfer stopped" });
    setStatus(`${stream.filename || "Download"} cancelled.`, "success");
    activeDownloadControls.delete(id);
    controls.downloadId = "";
    controls.pause.hidden = true;
  } else if (event.event === "error") {
    const message = event.error || "Download failed.";
    const serviceHint = message === "Failed to fetch"
      ? " Start the local LDM service with --server and retry."
      : "";
    setStatus(`${message}${serviceHint}`, "error");
    button.disabled = false;
    setButton(controls, "Retry", true);
    setProgress(controls, { label: "Download failed", detail: message, state: "error" });
    await notifyDownload("LDM download failed", message);
    activeDownloadControls.delete(id);
    controls.downloadId = "";
    controls.pause.hidden = true;
  }
}

function transferCard(record) {
  let view = transferCards.get(record.id);
  if (!view) {
    const card = document.createElement("article");
    card.className = "transfer-card";
    const header = document.createElement("div");
    header.className = "transfer-header";
    const name = document.createElement("p");
    name.className = "transfer-name";
    const status = document.createElement("span");
    status.className = "transfer-status";
    const actions = document.createElement("div");
    actions.className = "transfer-actions";
    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "cancel-transfer pause-transfer";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel-transfer";
    actions.append(status, pause, cancel);
    header.append(name, actions);
    const meta = document.createElement("p");
    meta.className = "transfer-meta";
    const progress = createProgressState();
    progress.root.classList.add("transfer-progress");
    const error = document.createElement("p");
    error.className = "transfer-error";
    card.append(header, meta, progress.root, error);
    view = { card, record, name, status, pause, cancel, meta, progress, error };
    transferCards.set(record.id, view);
    for (const [button, action] of [[pause, "pause"], [cancel, "cancel"]]) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        const operation = action === "pause" && view.record.status === "paused" ? "resume" : action;
        try {
          const result = await extensionApi.runtime.sendMessage({ type: `ldm:${operation}-download`, id: view.record.id });
          if (result?.error) throw new Error(result.error);
        } catch (error) { setStatus(error.message || "Could not control this download.", "error"); }
        await syncAndLoadHistory();
        button.disabled = false;
      });
    }
  }
  view.record = record;
  view.card.dataset.status = record.status || "queued";
  view.name.textContent = record.filename || "download.bin";
  view.name.title = view.name.textContent;
  view.status.textContent = record.status || "queued";
  view.pause.textContent = record.status === "paused" ? "Resume" : "Pause";
  view.pause.hidden = !["queued", "downloading", "paused"].includes(record.status);
  view.pause.setAttribute("aria-label", `${view.pause.textContent} ${view.name.textContent}`);
  view.cancel.hidden = !["queued", "downloading", "paused", "cancelling"].includes(record.status);
  view.cancel.disabled = record.status === "cancelling";
  view.cancel.textContent = record.status === "cancelling" ? "Stopping…" : "Cancel";
  view.cancel.setAttribute("aria-label", `Cancel ${view.name.textContent}`);
  view.meta.textContent = [(record.format || "direct").toUpperCase(),
    record.audio_only ? "Audio only" : record.resolution || "Unknown quality",
    record.output_format?.toUpperCase(), record.contentType || "media stream"].filter(Boolean).join(" · ");
  view.error.textContent = record.error || "";
  view.error.hidden = !record.error;
  updateTransferProgress(view, record);
  return view.card;
}

function updateTransferProgress(view, record) {
  const metrics = transferMetrics.describe(record);
  if (record.status === "completed") {
    setProgress(view, { label: "Download complete", detail: "File saved successfully", percent: 100, state: "complete", metrics });
    return;
  }
  if (record.status === "paused") {
    setProgress(view, { label: "Download paused", detail: record.pausedQueued ? "Waiting for Resume" : "Resume when ready", percent: metrics.percent, metrics });
    return;
  }
  if (record.status === "cancelled") {
    setProgress(view, { label: "Download cancelled", detail: "Transfer stopped", percent: metrics.percent, metrics });
    return;
  }
  if (record.status === "cancelling") {
    setProgress(view, { label: "Stopping download", detail: "Finishing safely…", indeterminate: true, metrics });
    return;
  }
  if (record.status === "failed" || record.status === "interrupted") {
    setProgress(view, {
      label: record.status === "interrupted" ? "Download interrupted" : "Download failed",
      detail: record.error || "The download did not finish.",
      percent: metrics.percent,
      state: "error",
      metrics
    });
    return;
  }
  if (record.status === "queued") {
    setProgress(view, {
      label: "Waiting in queue",
      detail: record.position > 0 ? `Position ${record.position}` : "Next available slot",
      indeterminate: true
    });
    return;
  }

  setProgress(view, {
    label: metrics.manifest ? `Processing ${(record.phase || record.format || "stream").toUpperCase()}` : "Downloading",
    detail: metrics.percent === null ? "In progress" : `${metrics.percent.toFixed(1)}%`,
    percent: metrics.percent,
    indeterminate: metrics.percent === null,
    metrics
  });
}

function renderHistory(records = []) {
  const active = records.filter((record) => ["queued", "downloading", "paused", "cancelling"].includes(record.status));
  const finished = records.filter((record) => !active.includes(record));
  const items = [...active, ...finished.slice(0, Math.max(0, 10 - active.length))];
  for (const id of transferCards.keys()) if (!records.some((record) => record.id === id)) transferCards.delete(id);
  transferCountElement.textContent = String(records.length);
  clearHistoryButton.disabled = !records.some((record) =>
    !["queued", "downloading", "paused", "cancelling"].includes(record.status));
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-transfers";
    empty.textContent = "No downloads yet. Detected streams will appear above.";
    transfersElement.replaceChildren(empty);
    return;
  }
  const cards = items.map(transferCard);
  if (records.length > items.length) {
    if (!olderHistoryNotice) { olderHistoryNotice = document.createElement("p"); olderHistoryNotice.className = "empty-transfers"; }
    const older = olderHistoryNotice;
    older.textContent = `${records.length - items.length} older downloads are saved in history.`;
    cards.push(older);
  }
  if (transfersElement.children.length !== cards.length || cards.some((card, index) => transfersElement.children[index] !== card)) {
    transfersElement.replaceChildren(...cards);
  }
}

async function loadHistory() {
  try {
    const result = await extensionApi.runtime.sendMessage({ type: "ldm:get-download-history" });
    if (result?.error) throw new Error(result.error);
    renderHistory(result?.records ?? []);
  } catch (error) {
    renderHistory([]);
    console.warn("LDM: could not load download history", error);
  }
}

async function syncAndLoadHistory() {
  try {
    await extensionApi.runtime.sendMessage({ type: "ldm:sync-download-history" });
  } catch (error) {
    console.debug("LDM: engine history sync is unavailable", error);
  }
  await loadHistory();
}

async function clearFinishedHistory() {
  clearHistoryButton.disabled = true;
  try {
    const result = await extensionApi.runtime.sendMessage({ type: "ldm:clear-download-history" });
    if (result?.error) throw new Error(result.error);
    await loadHistory();
    setStatus(`${result?.cleared ?? 0} finished download${result?.cleared === 1 ? "" : "s"} cleared.`);
  } catch (error) {
    setStatus(error.message || "Could not clear finished downloads.", "error");
    await loadHistory();
  }
}

extensionApi.runtime.onMessage.addListener((message) => {
  if (message?.type !== "ldm:download-event") return;
  const record = activeDownloadControls.get(message.id);
  if (record) void handleDownloadEvent(message.id, message.event, record.controls, record.stream);
});

extensionApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[DOWNLOAD_HISTORY_KEY]) return;
  renderHistory(changes[DOWNLOAD_HISTORY_KEY].newValue ?? []);
});

document.querySelector("#refresh").addEventListener("click", () => {
  void loadStreams();
  void syncAndLoadHistory();
});
clearHistoryButton.addEventListener("click", () => void clearFinishedHistory());
void loadStreams();
void syncAndLoadHistory();
window.setInterval(() => void syncAndLoadHistory(), 2000);
