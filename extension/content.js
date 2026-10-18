(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const transferMetrics = globalThis.LdmTransferMetrics;
  const mediaSources = globalThis.LdmMediaSources;
  const PLAYER_SELECTOR = [
    "#movie_player",
    ".html5-video-player",
    ".jwplayer",
    ".vjs-player",
    ".plyr",
    ".video-player",
    "[data-player]",
    ".player"
  ].join(",");
  const MIN_PLAYER_WIDTH = 240;
  const MIN_PLAYER_HEIGHT = 135;
  const activeOverlays = new Map();
  const downloadButtons = new Map();
  let scanQueued = false;
  let detectedStreamCount = 0;
  let lastSourceSignature = "";
  let reportingSources = false;
  let reportAgain = false;

  function updateDetectedCount(count) {
    if (!Number.isInteger(count) || count < 0) return;
    if (count === detectedStreamCount) return;
    detectedStreamCount = count;
    for (const overlay of activeOverlays.values()) {
      overlay.button.textContent = count > 0 ? `Download with LDM · ${count}` : "Download with LDM";
      overlay.button.setAttribute("aria-label", count > 0
        ? `Show ${count} detected media stream${count === 1 ? "" : "s"}` : "Show detected media streams");
    }
  }

  async function reportMediaSources() {
    if (reportingSources) {
      reportAgain = true;
      return;
    }
    const sources = mediaSources.collect(document);
    const documentUrl = location.href;
    const signature = `${documentUrl}\n${JSON.stringify(sources)}`;
    if (signature === lastSourceSignature) return;
    if (sources.length === 0) {
      lastSourceSignature = signature;
      return;
    }
    reportingSources = true;
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ldm:media-sources", sources, documentUrl });
      if (response?.error) throw new Error(response.error);
      if (location.href === documentUrl) {
        lastSourceSignature = signature;
        updateDetectedCount(response?.count);
      }
    } catch (error) {
      console.debug("LDM: native media discovery is unavailable", error);
    } finally {
      reportingSources = false;
      if (reportAgain) {
        reportAgain = false;
        scheduleScan();
      }
    }
  }

  function playerFor(video) {
    const explicitPlayer = video.closest(PLAYER_SELECTOR);
    if (explicitPlayer) return explicitPlayer;

    let candidate = video.parentElement;
    for (let depth = 0; candidate && depth < 5; depth += 1, candidate = candidate.parentElement) {
      const bounds = candidate.getBoundingClientRect();
      if (bounds.width >= MIN_PLAYER_WIDTH && bounds.height >= MIN_PLAYER_HEIGHT) {
        return candidate;
      }
    }
    return video.parentElement;
  }

  function createOverlay(player) {
    const host = document.createElement("div");
    host.className = "ldm-download-overlay-root";
    host.setAttribute("aria-label", "LDM video download controls");
    const previousPosition = {
      value: player.style.getPropertyValue("position"),
      priority: player.style.getPropertyPriority("position")
    };
    const changedPosition = getComputedStyle(player).position === "static";
    if (changedPosition) player.style.setProperty("position", "relative");
    player.append(host);

    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = extensionApi.runtime.getURL("overlay.css");
    shadow.append(stylesheet);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ldm-trigger";
    button.textContent = detectedStreamCount > 0 ? `Download with LDM · ${detectedStreamCount}` : "Download with LDM";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "Show detected media streams");

    const panel = document.createElement("section");
    panel.className = "ldm-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Available media downloads");

    const panelHeader = document.createElement("header");
    panelHeader.className = "ldm-panel-header";
    const heading = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "ldm-eyebrow";
    eyebrow.textContent = "LOCAL DOWNLOAD MANAGER";
    const title = document.createElement("h2");
    title.textContent = "Available streams";
    heading.append(eyebrow, title);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "ldm-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close download panel");
    panelHeader.append(heading, closeButton);

    const status = document.createElement("p");
    status.className = "ldm-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const list = document.createElement("div");
    list.className = "ldm-stream-list";
    panel.append(panelHeader, status, list);
    shadow.append(button, panel);

    const overlay = {
      host,
      player,
      button,
      panel,
      status,
      list,
      previousPosition,
      changedPosition,
      resizeObserver: null
    };
    if (detectedStreamCount > 0) button.setAttribute("aria-label",
      `Show ${detectedStreamCount} detected media stream${detectedStreamCount === 1 ? "" : "s"}`);
    if (typeof ResizeObserver === "function") {
      overlay.resizeObserver = new ResizeObserver(() => {
        host.style.setProperty("--ldm-player-width", `${player.getBoundingClientRect().width}px`);
      });
      overlay.resizeObserver.observe(player);
    }
    host.style.setProperty("--ldm-player-width", `${player.getBoundingClientRect().width}px`);
    button.addEventListener("click", () => {
      const opening = panel.hidden;
      panel.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) void refreshStreams(overlay);
    });
    closeButton.addEventListener("click", () => {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    });
    activeOverlays.set(player, overlay);
    return overlay;
  }

  function setStatus(overlay, message, state = "") {
    overlay.status.textContent = message;
    overlay.status.dataset.state = state;
  }

  async function refreshStreams(overlay) {
    overlay.list.replaceChildren();
    setStatus(overlay, "Looking for detected streams…");
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ldm:get-streams" });
      if (response?.error) throw new Error(response.error);
      const streams = response?.streams ?? [];
      updateDetectedCount(streams.length);
      if (streams.length === 0) {
        setStatus(overlay,
          "No supported complete media file or HLS/DASH playlist detected. Start playback and try again. "
          + "Individual media segments are not listed.");
        return;
      }
      for (const stream of streams) overlay.list.append(createStreamRow(overlay, stream));
      setStatus(overlay, `${streams.length} stream${streams.length === 1 ? "" : "s"} detected.`);
    } catch (error) {
      setStatus(overlay, error.message || "Could not load detected streams.", "error");
    }
  }

  function createStreamRow(overlay, stream) {
    const row = document.createElement("article");
    row.className = "ldm-stream";

    const details = document.createElement("div");
    details.className = "ldm-stream-details";
    const name = document.createElement("p");
    name.className = "ldm-stream-name";
    name.textContent = stream.filename || "Media stream";
    name.title = stream.url;

    const metadata = document.createElement("div");
    metadata.className = "ldm-stream-meta";
    const quality = document.createElement("span");
    quality.className = "ldm-quality";
    quality.textContent = stream.resolution || "Unknown quality";
    const type = document.createElement("span");
    type.className = "ldm-type";
    type.textContent = stream.contentType || "media stream";
    const format = document.createElement("span");
    format.className = "ldm-format";
    format.textContent = (stream.manifestFormat || "direct").toUpperCase();
    metadata.append(quality, format, type);
    details.append(name, metadata);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ldm-download";
    const icon = document.createElement("span");
    icon.className = "ldm-download-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "↓";
    const buttonLabel = document.createElement("span");
    buttonLabel.textContent = stream.manifestFormat ? "Choose" : "Download";
    button.append(icon, buttonLabel);
    const progress = createProgressState();
    const pause = document.createElement("button");
    pause.type = "button";
    pause.className = "ldm-pause";
    pause.textContent = "Pause";
    pause.hidden = true;
    const actions = document.createElement("div");
    actions.className = "ldm-stream-actions";
    actions.append(pause, button);
    const controls = { button, icon, buttonLabel, progress, pause, quality, format, downloadId: "", status: "" };
    pause.addEventListener("click", () => void pauseDownload(overlay, controls));
    button.addEventListener("click", () => {
      if (controls.downloadId) void cancelDownload(overlay, controls);
      else void prepareDownload(overlay, stream, controls, row);
    });
    row.append(details, actions, progress.root);
    return row;
  }

  function createProgressState() {
    const root = document.createElement("div");
    root.className = "ldm-download-state";
    root.hidden = true;

    const label = document.createElement("div");
    label.className = "ldm-progress-label";
    const primary = document.createElement("span");
    const detail = document.createElement("span");
    label.append(primary, detail);

    const track = document.createElement("div");
    track.className = "ldm-progress-track";
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Download progress");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.className = "ldm-progress-fill";
    track.append(fill);
    const metrics = document.createElement("dl");
    metrics.className = "ldm-transfer-metrics";
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
    controls.icon.hidden = !icon;
  }

  async function prepareDownload(overlay, stream, controls, row) {
    if (stream.manifestFormat && !controls.picker) {
      controls.button.disabled = true;
      setButton(controls, "Inspecting…");
      try {
        const response = await extensionApi.runtime.sendMessage({ type: "ldm:inspect-stream", stream });
        if (response?.error) throw new Error(response.error);
        controls.picker = globalThis.LdmMediaOptions.createPicker(document, response, (selection) => {
          const video = response.streams.find((track) => track.index === selection.video_stream_index);
          controls.quality.textContent = selection.audio_only ? "Audio only" : video?.height ? `${video.height}p` : "Best available";
          controls.format.textContent = selection.output_format.toUpperCase();
        });
        row.append(controls.picker.root);
        setButton(controls, "Download", true);
        setStatus(overlay, "Choose a verified quality, audio and format, then Download.");
      } catch (error) {
        setButton(controls, "Choose");
        setStatus(overlay, error.message || "Could not inspect this playlist.", "error");
      }
      controls.button.disabled = false;
      return;
    }
    const selection = controls.picker?.value() ?? {};
    const video = controls.picker?.inspected.streams.find((track) => track.index === selection.video_stream_index);
    const selected = { ...stream, ...selection,
      ...(stream.manifestFormat ? { resolution: selection.audio_only ? "Audio only" : video?.height ? `${video.height}p` : "Best available" } : {}),
      ...(stream.manifestFormat ? { filename: globalThis.LdmMediaOptions.filename(stream.filename, selection) } : {}) };
    await startDownload(overlay, selected, controls);
  }

  async function pauseDownload(overlay, controls) {
    if (!controls.downloadId) return;
    controls.pause.disabled = true;
    try {
      const action = controls.status === "paused" ? "resume" : "pause";
      const response = await extensionApi.runtime.sendMessage({ type: `ldm:${action}-download`, id: controls.downloadId });
      if (response?.error) throw new Error(response.error);
      controls.status = response.status;
      controls.pause.textContent = response.status === "paused" ? "Resume" : "Pause";
    } catch (error) { setStatus(overlay, error.message, "error"); }
    controls.pause.disabled = false;
  }

  async function startDownload(overlay, stream, controls) {
    const { button } = controls;
    const id = globalThis.crypto.randomUUID();
    controls.downloadId = id;
    controls.status = "queued";
    controls.pause.hidden = false;
    downloadButtons.set(id, { overlay, controls, stream });
    button.disabled = false;
    setButton(controls, "Cancel");
    setProgress(controls, { label: "Waiting in queue", detail: "Preparing request", indeterminate: true });
    setStatus(overlay, "Adding download to the local queue…");
    try {
      const response = await extensionApi.runtime.sendMessage({
        type: "ldm:download-stream",
        id,
        stream
      });
      if (!response?.accepted) throw new Error(response?.error || "LDM did not accept the download.");
    } catch (error) {
      downloadButtons.delete(id);
      controls.downloadId = "";
      controls.pause.hidden = true;
      button.disabled = false;
      setButton(controls, "Retry", true);
      setProgress(controls, { label: "Could not start", detail: error.message || "Request failed", state: "error" });
      setStatus(overlay, error.message || "Could not start the download.", "error");
    }
  }

  async function cancelDownload(overlay, controls) {
    const id = controls.downloadId;
    if (!id) return;
    controls.button.disabled = true;
    setButton(controls, "Stopping…");
    setStatus(overlay, "Stopping download…");
    try {
      const response = await extensionApi.runtime.sendMessage({ type: "ldm:cancel-download", id });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      controls.button.disabled = false;
      setButton(controls, "Cancel");
      setStatus(overlay, error.message || "Could not cancel this download.", "error");
    }
  }

  function handleDownloadEvent(message) {
    const record = downloadButtons.get(message.id);
    if (!record) return;
    const { overlay, controls, stream } = record;
    const { button } = controls;
    const event = message.event;
    if (event.event === "queued") {
      controls.status = "queued";
      controls.pause.textContent = "Pause";
      setButton(controls, "Cancel");
      setProgress(controls, {
        label: "Waiting in queue",
        detail: event.position > 0 ? `Position ${event.position}` : "Next available slot",
        indeterminate: true
      });
      setStatus(overlay, event.position > 0 ? `Download queued · position ${event.position}` : "Download queued.");
    } else if (event.event === "started" || event.event === "resumed") {
      controls.status = "downloading";
      controls.pause.textContent = "Pause";
      setButton(controls, "Cancel");
      setProgress(controls, { label: "Download started", detail: "Waiting for progress", indeterminate: true });
      setStatus(overlay, "Download started.");
    } else if (event.event === "paused") {
      controls.status = "paused";
      controls.pause.textContent = "Resume";
      setProgress(controls, { label: "Download paused", detail: "Resume when ready", percent: controls.lastMetrics?.percent ?? null,
        metrics: controls.lastMetrics ? { ...controls.lastMetrics, speed: "—", eta: "Paused" } : null });
    } else if (event.event === "progress") {
      if (["paused", "cancelling"].includes(controls.status)) return;
      const metrics = transferMetrics.describe(transferMetrics.fromEvent(event));
      controls.lastMetrics = metrics;
      const label = metrics.manifest ? `Processing ${(event.phase || "stream").toUpperCase()}` : "Downloading";
      const detail = metrics.percent === null ? "In progress" : `${metrics.percent.toFixed(1)}%`;
      setProgress(controls, {
        label,
        detail,
        percent: metrics.percent,
        indeterminate: metrics.percent === null,
        metrics
      });
      setStatus(overlay, `${label} · ${metrics.size} · ${metrics.eta}`);
    } else if (event.event === "completed") {
      setButton(controls, "Completed");
      button.disabled = true;
      setProgress(controls, { label: "Download complete", detail: "File saved successfully", percent: 100, state: "complete" });
      setStatus(overlay, `Download complete: ${stream.filename || "media file"}`, "success");
      controls.downloadId = "";
      controls.pause.hidden = true;
      downloadButtons.delete(message.id);
    } else if (event.event === "cancelling") {
      controls.status = "cancelling";
      controls.pause.hidden = true;
      button.disabled = true;
      setButton(controls, "Stopping…");
      setProgress(controls, { label: "Stopping download", detail: "Finishing safely…", indeterminate: true });
      setStatus(overlay, "Stopping download…");
    } else if (event.event === "cancelled") {
      button.disabled = false;
      setButton(controls, "Download");
      controls.downloadId = "";
      controls.pause.hidden = true;
      setProgress(controls, { label: "Download cancelled", detail: "Transfer stopped" });
      setStatus(overlay, `Download cancelled: ${stream.filename || "media file"}`, "success");
      downloadButtons.delete(message.id);
    } else if (event.event === "error") {
      button.disabled = false;
      controls.downloadId = "";
      controls.pause.hidden = true;
      setButton(controls, "Retry", true);
      const errorMessage = event.error || "Download failed.";
      setProgress(controls, { label: "Download failed", detail: errorMessage, state: "error" });
      const serviceHint = errorMessage === "Failed to fetch"
        ? " Start the local LDM service with --server and retry."
        : "";
      setStatus(overlay, `${errorMessage}${serviceHint}`, "error");
      downloadButtons.delete(message.id);
    }
  }

  extensionApi.runtime.onMessage.addListener((message) => {
    if (message?.type === "ldm:download-event") handleDownloadEvent(message);
    if (message?.type === "ldm:streams-changed") {
      updateDetectedCount(message.count);
      for (const overlay of activeOverlays.values()) {
        const hasActiveDownload = [...downloadButtons.values()].some((entry) => entry.overlay === overlay);
        if (!overlay.panel.hidden && !hasActiveDownload) void refreshStreams(overlay);
      }
    }
  });

  function removeDisconnectedOverlays() {
    for (const [player, overlay] of activeOverlays) {
      if (player.isConnected) continue;
      overlay.host.remove();
      overlay.resizeObserver?.disconnect();
      if (overlay.changedPosition) {
        if (overlay.previousPosition.value) {
          player.style.setProperty("position", overlay.previousPosition.value,
            overlay.previousPosition.priority);
        } else {
          player.style.removeProperty("position");
        }
      }
      activeOverlays.delete(player);
    }
  }

  function scanPlayers() {
    scanQueued = false;
    removeDisconnectedOverlays();
    void reportMediaSources();
    for (const video of document.querySelectorAll("video")) {
      const player = playerFor(video);
      if (!player || !player.isConnected || activeOverlays.has(player)) continue;
      const bounds = player.getBoundingClientRect();
      if (bounds.width < MIN_PLAYER_WIDTH || bounds.height < MIN_PLAYER_HEIGHT) continue;
      createOverlay(player);
    }
  }

  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scanPlayers);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["src", "type"]
  });
  window.addEventListener("pageshow", () => {
    lastSourceSignature = "";
    scheduleScan();
  });
  window.addEventListener("resize", scheduleScan, { passive: true });
  document.addEventListener("fullscreenchange", scheduleScan);
  for (const event of ["loadstart", "loadedmetadata", "play", "emptied"]) {
    document.addEventListener(event, scheduleScan, true);
  }
  void extensionApi.runtime.sendMessage({ type: "ldm:get-streams" }).then((response) => {
    if (Array.isArray(response?.streams)) updateDetectedCount(response.streams.length);
  }).catch(() => {});
  scheduleScan();
})();
