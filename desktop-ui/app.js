(() => {
  const transferMetrics = globalThis.LdmTransferMetrics;
  const HISTORY_KEY = "ldm.desktop.downloadHistory";
  const MAX_HISTORY_ITEMS = 50;
  const MAX_ACTIVE_DOWNLOADS = 2;
  const streamsElement = document.querySelector("#download-list");
  const historyElement = document.querySelector("#history-list");
  const form = document.querySelector("#download-form");
  const urlInput = document.querySelector("#url-input");
  const filenameInput = document.querySelector("#filename-input");
  const folderInput = document.querySelector("#folder-input");
  const formatInput = document.querySelector("#format-input");
  const formStatus = document.querySelector("#form-status");
  const queueButton = document.querySelector("#queue-button");
  const clearButtons = [document.querySelector("#clear-history"), document.querySelector("#clear-history-secondary")];
  const queue = [];
  const localActiveIds = new Set();
  let engineActiveIds = new Set();
  const manifestOptions = document.querySelector("#manifest-options");
  let inspectedUrl = "";
  let manifestPicker = null;
  let inspectionGeneration = 0;
  const cardsById = new Map();
  const emptyStates = new Map();
  let history = loadHistory();
  let activeCount = 0;
  let activeView = "downloads";

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      let recovered = false;
      const records = saved.filter((record) => record && typeof record.id === "string").map((record) => {
        if (!["queued", "downloading", "paused", "cancelling"].includes(record.status)) return record;
        recovered = true;
        return { ...record, status: "interrupted", error: "This page closed before the transfer could be tracked." };
      }).slice(0, MAX_HISTORY_ITEMS);
      if (recovered) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(records));
      }
      return records;
    } catch (error) {
      console.warn("LDM: unable to restore desktop history", error);
      return [];
    }
  }

  function saveHistory() {
    history = history.slice(0, MAX_HISTORY_ITEMS);
    const safeRecords = history.map(({ url, saveFolder, ...record }) => record);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(safeRecords));
    } catch (error) {
      setFormStatus("Browser storage is full. Clear finished history to continue.", "error");
      console.warn("LDM: unable to save desktop history", error);
    }
  }

  function setFormStatus(message, kind = "", source = "") {
    formStatus.textContent = message;
    formStatus.dataset.kind = kind;
    formStatus.dataset.source = source;
  }

  function randomId() {
    return globalThis.crypto?.randomUUID?.()
      ?? `ldm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function safeFilename(value) {
    const cleaned = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
    if (!cleaned || cleaned === "." || cleaned === "..") return "";
    return cleaned.replace(/[\u0000-\u001f]/g, "");
  }

  function filenameFromUrl(value) {
    try {
      return safeFilename(decodeURIComponent(new URL(value).pathname.split("/").at(-1) ?? ""));
    } catch {
      return "";
    }
  }

  function manifestFormatFor(url) {
    const requested = formatInput.value;
    if (requested === "direct") return "";
    if (["hls", "dash"].includes(requested)) {
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("HLS and DASH inspection requires an HTTP or HTTPS link.");
      return requested;
    }
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return /\.mpd(?:$|[?#])/i.test(url.href) ? "dash" : /\.m3u8(?:$|[?#])/i.test(url.href) ? "hls" : "";
  }

  function addDownload(urlValue, filenameValue, selection = {}, folderValue = "") {
    if (activeCount + queue.length >= MAX_HISTORY_ITEMS) {
      throw new Error("The download queue is full. Wait for a transfer to finish, then try again.");
    }
    const url = new URL(urlValue);
    if (!["http:", "https:", "ftp:", "ftps:"].includes(url.protocol)) {
      throw new Error("Use an HTTP, HTTPS, FTP or FTPS link.");
    }
    if (folderValue && (!folderValue.startsWith("/") || /[\u0000-\u001f]/.test(folderValue))) {
      throw new Error("Enter an absolute save folder path beginning with /, or leave it blank for Downloads.");
    }
    let filename = safeFilename(filenameValue) || filenameFromUrl(url.href) || "download.bin";
    const manifestFormat = manifestFormatFor(url);
    if (manifestFormat) filename = globalThis.LdmMediaOptions.filename(filename, selection);
    const record = {
      ...selection,
      engineOwned: false,
      saveFolder: folderValue,
      id: randomId(),
      filename,
      contentType: manifestFormat ? `${manifestFormat.toUpperCase()} playlist` : "File download",
      format: manifestFormat || "direct",
      status: "queued",
      position: queue.length + activeCount + 1,
      percent: null,
      bytesDownloaded: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      phase: "http",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: "",
      url: url.href
    };
    history.unshift(record);
    history = history.slice(0, MAX_HISTORY_ITEMS);
    queue.push(record);
    saveHistory();
    render();
    pumpQueue();
  }

  function pumpQueue() {
    while (activeCount < MAX_ACTIVE_DOWNLOADS && queue.some((record) => record.status === "queued")) {
      const index = queue.findIndex((record) => record.status === "queued");
      const [record] = queue.splice(index, 1);
      localActiveIds.add(record.id);
      activeCount = new Set([...localActiveIds, ...engineActiveIds]).size;
      record.status = "downloading";
      record.startedAt = Date.now();
      record.position = 0;
      record.updatedAt = Date.now();
      saveHistory();
      render();
      void runDownload(record).finally(() => {
        localActiveIds.delete(record.id);
        engineActiveIds.delete(record.id);
        activeCount = new Set([...localActiveIds, ...engineActiveIds]).size;
        updateQueuePositions();
        pumpQueue();
      });
    }
    updateQueuePositions();
  }

  function updateQueuePositions() {
    let position = activeCount;
    for (const record of queue) {
      if (record.status === "paused") { record.position = 0; continue; }
      position += 1;
      record.position = position;
      record.updatedAt = Date.now();
    }
    saveHistory();
    render();
  }

  async function runDownload(record) {
    const payload = {
      id: record.id,
      url: record.url,
      output_path: record.saveFolder ? `${record.saveFolder.replace(/\/+$/, "")}/${record.filename}` : record.filename,
      manifest_format: record.format === "direct" ? "" : record.format,
      max_connections: 8,
      ...globalThis.LdmMediaOptions.fields(record),
      headers: {}
    };
    try {
      const response = await fetch("/download", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit"
      });
      if (!response.ok) {
        let message = `LDM returned HTTP ${response.status}`;
        try {
          const body = await response.json();
          message = body.error || message;
        } catch {
          // Keep the HTTP status when the server does not send JSON.
        }
        throw new Error(message);
      }
      record.engineOwned = true;
      if (!response.body) throw new Error("LDM did not return a progress stream.");
      await readProgress(response.body, record);
    } catch (error) {
      finishRecord(record, "failed", error.message || "Download failed.");
    }
  }

  async function readProgress(stream, record) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) handleProgressEvent(JSON.parse(line), record);
      }
      if (done) break;
    }
    if (pending.trim()) handleProgressEvent(JSON.parse(pending), record);
    if (["downloading", "paused", "cancelling"].includes(record.status)) finishRecord(record, "failed", "LDM closed before the download finished.");
  }

  function handleProgressEvent(event, record) {
    if (event.event === "progress") {
      if (typeof event.output_filename === "string" && event.output_filename.trim()) {
        record.filename = event.output_filename;
      }
      const percent = Number(event.percent_complete);
      record.percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
      record.bytesDownloaded = Number(event.bytes_downloaded) || 0;
      record.bytesProcessed = Number(event.bytes_processed) || 0;
      record.totalBytes = Number(event.total_bytes) || 0;
      record.bytesPerSecond = Number(event.bytes_per_second) || 0;
      record.phase = typeof event.phase === "string" ? event.phase : "http";
      record.updatedAt = Date.now();
      saveHistory();
      render();
    } else if (event.event === "paused" || event.event === "resumed") {
      record.status = event.event === "paused" ? "paused" : "downloading";
      saveHistory();
      render();
    } else if (event.event === "completed") {
      finishRecord(record, "completed");
    } else if (event.event === "error") {
      finishRecord(record, "failed", event.error || "Download failed.");
    } else if (event.event === "cancelled") {
      finishRecord(record, "cancelled");
    }
  }

  function finishRecord(record, status, message = "") {
    if (["completed", "failed", "cancelled", "interrupted"].includes(record.status)) return;
    record.status = status;
    record.percent = status === "completed" ? 100 : record.percent;
    record.completedAt = status === "completed" ? Date.now() : null;
    record.updatedAt = Date.now();
    record.position = 0;
    record.error = message;
    saveHistory();
    render();
    if (status === "completed") setFormStatus(`${record.filename} downloaded successfully.`, "success");
    else if (status === "cancelled") setFormStatus(`${record.filename} cancelled.`, "success");
    else setFormStatus(message, "error");
  }

  async function cancelRecord(record) {
    if (record.status === "queued" || (record.status === "paused" && queue.includes(record))) {
      const index = queue.indexOf(record);
      if (index >= 0) queue.splice(index, 1);
      finishRecord(record, "cancelled");
      updateQueuePositions();
      return;
    }
    if (!["downloading", "paused"].includes(record.status)) return;
    const previousStatus = record.status;
    record.status = "cancelling";
    record.updatedAt = Date.now();
    saveHistory();
    render();
    try {
      const response = await fetch("/api/cancel", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ id: record.id }),
        cache: "no-store",
        credentials: "omit"
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `LDM returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (record.status === "cancelling") {
        record.status = previousStatus;
        record.error = error.message || "Could not cancel this download.";
        record.updatedAt = Date.now();
        saveHistory();
        render();
      }
      setFormStatus(error.message || "Could not cancel this download.", "error");
    }
  }

  async function pauseRecord(record) {
    if (!["queued", "downloading", "paused"].includes(record.status)) return;
    const action = record.status === "paused" ? "resume" : "pause";
    if (queue.includes(record)) {
      record.status = action === "pause" ? "paused" : "queued";
      updateQueuePositions();
      pumpQueue();
      return;
    }
    try {
      const response = await fetch(`/api/${action}`, {
        method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ id: record.id }), cache: "no-store", credentials: "omit"
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `LDM returned HTTP ${response.status}`);
      }
      if (!["queued", "downloading", "paused"].includes(record.status)) return;
      record.status = action === "pause" ? "paused" : "downloading";
      record.updatedAt = Date.now();
      record.error = "";
      saveHistory();
      render();
    } catch (error) { setFormStatus(error.message || "Could not control this transfer.", "error"); }
  }

  function progressContent(record) {
    if (record.status === "paused") {
      return { label: "Download paused", detail: queue.includes(record) ? "Waiting for Resume" : "Resume when ready", percent: record.percent, indeterminate: false };
    }
    if (record.status === "queued") {
      return { label: "Waiting in queue", detail: `Position ${record.position || 1}`, percent: null, indeterminate: true };
    }
    if (record.status === "completed") {
      return { label: "Download complete", detail: "File saved successfully", percent: 100, indeterminate: false };
    }
    if (record.status === "cancelled") {
      return { label: "Download cancelled", detail: "Transfer stopped", percent: record.percent, indeterminate: false };
    }
    if (record.status === "cancelling") {
      return { label: "Stopping download", detail: "Finishing safely…", percent: record.percent, indeterminate: false };
    }
    if (record.status === "failed" || record.status === "interrupted") {
      return { label: record.status === "interrupted" ? "Session interrupted" : "Download failed", detail: "", percent: record.percent, indeterminate: false };
    }
    const { percent, manifest } = transferMetrics.describe(record);
    const detail = percent === null ? (manifest ? "Muxing media" : "Size unknown") : `${percent.toFixed(1)}%`;
    return { label: manifest ? `Processing ${record.phase.toUpperCase()}` : "Downloading", detail, percent, indeterminate: percent === null };
  }

  function createMetrics() {
    const list = document.createElement("dl");
    list.className = "transfer-metrics";
    list.setAttribute("aria-label", "Transfer details");
    const fields = [];
    for (let index = 0; index < 3; index += 1) {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      item.append(term, description);
      list.append(item);
      fields.push({ term, description });
    }
    return { element: list, fields };
  }

  function createCard(record) {
    const card = document.createElement("article");
    card.className = "download-card";
    card.dataset.status = record.status;

    const main = document.createElement("div");
    main.className = "download-main";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M6.5 3.5h7l4 4v13h-11z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.5 3.5v4h4M9 13h6M9 16.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const copy = document.createElement("div");
    copy.className = "file-copy";
    const name = document.createElement("p");
    name.className = "file-name";
    const meta = document.createElement("p");
    meta.className = "file-meta";
    copy.append(name, meta);
    main.append(icon, copy);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const status = document.createElement("span");
    status.className = "card-status";
    actions.append(status);
    const view = { card, status: record.status, record, name, meta, statusLabel: status, cancel: null };
    const pause = document.createElement("button");
    pause.className = "pause-button";
    pause.type = "button";
    pause.addEventListener("click", async () => {
      pause.disabled = true;
      try { await pauseRecord(view.record); } finally { pause.disabled = false; }
    });
    const cancel = document.createElement("button");
    cancel.className = "cancel-button";
    cancel.type = "button";
    cancel.addEventListener("click", () => void cancelRecord(view.record));
    actions.append(pause, cancel);
    Object.assign(view, { pause, cancel });

    const progress = document.createElement("div");
    progress.className = "card-progress";
    const label = document.createElement("div");
    label.className = "progress-label";
    const primary = document.createElement("span");
    const detail = document.createElement("span");
    label.append(primary, detail);
    const track = document.createElement("div");
    track.className = "progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.className = "progress-fill";
    track.append(fill);
    progress.append(label, track);
    card.append(main, actions, progress);
    Object.assign(view, { primary, detail, track, fill, metrics: null, error: null });
    view.metrics = createMetrics();
    card.append(view.metrics.element);
    const error = document.createElement("p");
    error.className = "card-error";
    card.append(error);
    view.error = error;
    return view;
  }

  function updateCard(view, record) {
    view.record = record;
    view.status = record.status;
    view.card.dataset.status = record.status;
    view.pause.hidden = !["queued", "downloading", "paused"].includes(record.status);
    view.pause.textContent = record.status === "paused" ? "Resume" : "Pause";
    view.pause.setAttribute("aria-label", `${view.pause.textContent} ${record.filename || "download"}`);
    view.cancel.hidden = !["queued", "downloading", "paused", "cancelling"].includes(record.status);
    view.cancel.disabled = record.status === "cancelling";
    view.metrics.element.hidden = record.status === "queued";
    view.name.textContent = record.filename || "download.bin";
    view.name.title = record.filename || "download.bin";
    view.meta.textContent = [String(record.format || "direct").toUpperCase(), record.audio_only ? "Audio only" : "",
      record.output_format?.toUpperCase(), record.contentType || "File download"].filter(Boolean).join(" · ");
    view.statusLabel.textContent = record.status.replaceAll("_", " ");
    if (view.cancel) {
      view.cancel.textContent = record.status === "queued" ? "Remove" : record.status === "cancelling" ? "Stopping…" : "Cancel";
      view.cancel.setAttribute("aria-label", `${view.cancel.textContent} ${record.filename || "download"}`);
    }
    const progressInfo = progressContent(record);
    view.primary.textContent = progressInfo.label;
    view.detail.textContent = progressInfo.detail;
    view.track.setAttribute("aria-label", `${record.filename || "Download"} progress`);
    view.fill.style.width = Number.isFinite(progressInfo.percent)
      ? `${Math.max(0, Math.min(100, progressInfo.percent))}%`
      : "";
    view.fill.classList.toggle("is-indeterminate", progressInfo.indeterminate);
    if (Number.isFinite(progressInfo.percent)) view.track.setAttribute("aria-valuenow", String(Math.round(progressInfo.percent)));
    else view.track.removeAttribute("aria-valuenow");
    view.track.setAttribute("aria-valuetext", `${progressInfo.label}${progressInfo.detail ? `, ${progressInfo.detail}` : ""}`);
    if (view.metrics) {
      const metrics = transferMetrics.describe(record);
      const fields = [
        [metrics.manifest ? "Output" : "Transferred", metrics.size],
        ["Speed", metrics.speed],
        ["Remaining", metrics.eta]
      ];
      fields.forEach(([label, value], index) => {
        view.metrics.fields[index].term.textContent = label;
        view.metrics.fields[index].description.textContent = value;
      });
    }
    if (view.error) {
      view.error.textContent = record.error || "";
      view.error.hidden = !record.error;
    }
  }

  function renderList(container, records, createEmpty) {
    const children = records.map((record) => {
      let view = cardsById.get(record.id);
      if (!view) {
        view = createCard(record);
        cardsById.set(record.id, view);
      }
      updateCard(view, record);
      return view.card;
    });
    if (children.length === 0) {
      if (!emptyStates.has(container)) emptyStates.set(container, createEmpty());
      children.push(emptyStates.get(container));
    }
    // Keeping the same nodes mounted preserves keyboard focus and pointer clicks.
    if (container.children.length !== children.length
      || children.some((child, index) => container.children[index] !== child)) {
      container.replaceChildren(...children);
    }
  }

  function render() {
    const retainedIds = new Set(history.map((record) => record.id));
    for (const id of cardsById.keys()) {
      if (!retainedIds.has(id)) cardsById.delete(id);
    }
    const active = history.filter((record) => ["queued", "downloading", "paused", "cancelling"].includes(record.status));
    const finished = history.filter((record) => !["queued", "downloading", "paused", "cancelling"].includes(record.status));
    const running = active.filter((record) => ["downloading", "paused", "cancelling"].includes(record.status) && !queue.includes(record)).length;
    const queued = active.length - running;
    document.querySelector("#active-count").textContent = String(active.length);
    document.querySelector("#overview-active").textContent = String(running);
    document.querySelector("#overview-queued").textContent = String(queued);
    document.querySelector("#overview-completed").textContent = String(finished.filter((record) => record.status === "completed").length);
    for (const button of clearButtons) {
      button.disabled = finished.length === 0;
    }

    renderList(streamsElement, active, () => {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 17v1.25A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span><h3>Your queue is clear</h3><p>Add a link above to start your first download.</p>';
      return empty;
    });

    renderList(historyElement, finished, () => {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = '<span class="empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3.5 12a8.5 8.5 0 1 0 2.2-5.7L3.5 8.5M3.5 4.5v4h4m4.5-1v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><h3>No download history yet</h3><p>Completed and unsuccessful transfers will appear here.</p>';
      return empty;
    });
  }

  function setView(view) {
    activeView = view;
    const isHistory = activeView === "history";
    document.querySelector("#download-view").hidden = isHistory;
    document.querySelector("#history-view").hidden = !isHistory;
    document.querySelector("#view-title").textContent = isHistory ? "History" : "Downloads";
    document.querySelector("#transfer-heading").textContent = isHistory ? "Active downloads" : "Active downloads";
    for (const item of document.querySelectorAll(".nav-item")) {
      const active = item.dataset.view === view;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
  }

  async function checkEngine() {
    try {
      const response = await fetch("/api/health", { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Local engine is not responding");
      setEngineStatus(true);
    } catch (error) {
      setEngineStatus(false);
      setFormStatus(error.message || "Could not reach the local engine.", "error", "engine");
    }
  }

  function setEngineStatus(connected) {
    const badge = document.querySelector("#local-badge");
    const badgeLabel = document.querySelector("#local-badge-label");
    const dot = document.querySelector("#engine-dot");
    const label = document.querySelector("#engine-label");
    badge.dataset.state = connected ? "connected" : "offline";
    badgeLabel.textContent = connected ? "ONLINE" : "OFFLINE";
    badge.setAttribute("aria-label", connected ? "Local engine connected" : "Local engine offline");
    dot.classList.toggle("is-offline", !connected);
    label.textContent = connected ? "Local engine connected" : "Engine connection lost";
    if (connected && formStatus.dataset.source === "engine") setFormStatus("");
  }

  async function syncEngineDownloads() {
    try {
      const response = await fetch("/api/downloads", { cache: "no-store", credentials: "omit" });
      if (!response.ok) {
        setEngineStatus(false);
        return;
      }
      setEngineStatus(true);
      const result = await response.json();
      if (!Array.isArray(result.downloads)) return;

      const jobsById = new Map(result.downloads
        .filter((job) => job && typeof job.id === "string")
        .map((job) => [job.id, job]));
      const activeJobIds = new Set();
      let changed = false;
      for (const job of jobsById.values()) {
        if (!["downloading", "paused", "cancelling", "completed", "failed", "cancelled"].includes(job.status)) continue;
        let record = history.find((item) => item.id === job.id);
        if (!record) {
          record = {
            id: job.id,
            filename: "download.bin",
            contentType: "File download",
            format: "direct",
            status: job.status,
            createdAt: Number(job.created_at) || Date.now(),
            error: ""
          };
          history.unshift(record);
          changed = true;
        }

        const filename = typeof job.filename === "string" ? safeFilename(job.filename) : "";
        const percent = Number(job.percent_complete);
        const bytesDownloaded = Number(job.bytes_downloaded) || 0;
        const bytesProcessed = Number(job.bytes_processed) || 0;
        const totalBytes = Number(job.total_bytes) || 0;
        const bytesPerSecond = Number(job.bytes_per_second) || 0;
        const phase = typeof job.phase === "string" ? job.phase : "http";
        const error = typeof job.error === "string" ? job.error : "";
        if (["downloading", "paused", "cancelling"].includes(job.status)) activeJobIds.add(job.id);

        if (record.status !== job.status || record.filename !== (filename || record.filename)
          || record.percent !== (Number.isFinite(percent) ? percent : null)
          || record.bytesDownloaded !== bytesDownloaded || record.bytesProcessed !== bytesProcessed
          || record.totalBytes !== totalBytes || record.bytesPerSecond !== bytesPerSecond
          || record.phase !== phase || record.error !== error) {
          changed = true;
        }
        record.status = job.status;
        record.engineOwned = true;
        if (filename) record.filename = filename;
        record.percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
        record.bytesDownloaded = bytesDownloaded;
        record.bytesProcessed = bytesProcessed;
        record.totalBytes = totalBytes;
        record.bytesPerSecond = bytesPerSecond;
        record.phase = phase;
        record.error = error;
        record.position = 0;
        record.updatedAt = Number(job.updated_at) || Date.now();
        if (job.status === "completed") {
          record.percent = 100;
          record.completedAt = record.updatedAt;
        }
      }

      for (const record of history) {
        if (!["downloading", "paused", "cancelling"].includes(record.status) || queue.includes(record) || localActiveIds.has(record.id) || activeJobIds.has(record.id)) continue;
        if (Date.now() - Number(record.updatedAt || 0) < 5000) continue;
        record.status = "interrupted";
        record.error = "The local engine no longer reports this transfer.";
        record.updatedAt = Date.now();
        changed = true;
      }

      engineActiveIds = activeJobIds;
      const nextActiveCount = new Set([...localActiveIds, ...engineActiveIds]).size;
      if (activeCount !== nextActiveCount) changed = true;
      activeCount = nextActiveCount;
      if (!changed) return;
      history = history.slice(0, MAX_HISTORY_ITEMS);
      updateQueuePositions();
      pumpQueue();
    } catch (error) {
      setEngineStatus(false);
      console.debug("LDM: unable to sync active downloads with the local engine", error);
    }
  }

  function clearFinished() {
    history = history.filter((record) => ["queued", "downloading", "paused", "cancelling"].includes(record.status));
    saveHistory();
    render();
    setFormStatus("Finished transfer history cleared.", "success");
  }

  function resetManifestOptions() {
    inspectionGeneration += 1;
    inspectedUrl = "";
    manifestPicker = null;
    manifestOptions.replaceChildren();
    manifestOptions.hidden = true;
    const label = queueButton.querySelector?.("span");
    if (label) label.textContent = "Add to queue";
  }

  urlInput.addEventListener("input", resetManifestOptions);
  formatInput.addEventListener("change", resetManifestOptions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const urlValue = urlInput.value.trim();
    queueButton.disabled = true;
    try {
      const parsed = new URL(urlValue);
      const manifestFormat = manifestFormatFor(parsed);
      if (manifestFormat && inspectedUrl !== parsed.href) {
        const generation = inspectionGeneration;
        setFormStatus("Inspecting available video and audio tracks…");
        const response = await fetch("/api/inspect", {
          method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify({ url: parsed.href, manifest_format: manifestFormat, headers: {} }),
          cache: "no-store", credentials: "omit"
        });
        const result = await response.json();
        if (generation !== inspectionGeneration || urlInput.value.trim() !== urlValue) return;
        if (!response.ok) throw new Error(result.error || `LDM returned HTTP ${response.status}`);
        manifestPicker = globalThis.LdmMediaOptions.createPicker(document, result);
        manifestOptions.replaceChildren(manifestPicker.root);
        manifestOptions.hidden = false;
        inspectedUrl = parsed.href;
        const label = queueButton.querySelector?.("span");
        if (label) label.textContent = "Download selection";
        setFormStatus("Choose a verified quality, audio track and file format, then Download selection.");
        return;
      }
      addDownload(urlValue, filenameInput.value.trim(), manifestFormat && inspectedUrl === parsed.href ? manifestPicker?.value() ?? {} : {}, (folderInput.value || "").trim());
      filenameInput.value = "";
      resetManifestOptions();
      setFormStatus("Added to your download queue.", "success");
    } catch (error) {
      setFormStatus(error.message || "Enter a valid download link.", "error");
      urlInput.focus();
    } finally { queueButton.disabled = false; }
  });

  document.querySelector("#paste-button").addEventListener("click", async () => {
    try {
      urlInput.value = await navigator.clipboard.readText();
      resetManifestOptions();
      urlInput.focus();
      setFormStatus("Link pasted from clipboard.", "success");
    } catch {
      setFormStatus("Clipboard access was not available. Paste the link into the field.", "error");
      urlInput.focus();
    }
  });
  document.querySelector("#refresh").addEventListener("click", () => {
    render();
    void checkEngine();
    void syncEngineDownloads();
  });
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  for (const button of clearButtons) button.addEventListener("click", clearFinished);
  window.addEventListener("storage", (event) => {
    if (event.key !== HISTORY_KEY) return;
    history = loadHistory();
    render();
  });

  render();
  void checkEngine();
  void syncEngineDownloads();
  window.setInterval(() => void syncEngineDownloads(), 1500);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch((error) => {
      console.debug("LDM: offline UI cache was not registered", error);
    });
  }
})();
