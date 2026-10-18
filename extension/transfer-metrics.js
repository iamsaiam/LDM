(() => {
  const nonnegative = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  };

  function formatBytes(value) {
    const bytes = nonnegative(value);
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    const index = bytes > 0 ? Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))) : 0;
    const scaled = bytes / (1024 ** index);
    const digits = index === 0 ? 0 : (scaled < 10 ? 2 : (scaled < 100 ? 1 : 0));
    return `${scaled.toFixed(digits)} ${units[index]}`;
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value < 0) return "Unknown";
    const seconds = Math.ceil(value);
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // The same presentation is used by the desktop dashboard, popup and overlay.
  function describe(record) {
    const manifest = [record.phase, record.format].some((phase) => phase === "hls" || phase === "dash" || phase === "media");
    const downloaded = nonnegative(record.bytesDownloaded);
    const total = nonnegative(record.totalBytes);
    const rate = nonnegative(record.bytesPerSecond);
    const running = record.status === "downloading";
    const completed = record.status === "completed";
    const rawPercent = record.percent === null || record.percent === undefined || record.percent === ""
      ? NaN : Number(record.percent);
    const percent = completed ? 100 : (manifest
      ? (Number.isFinite(rawPercent) && rawPercent > 0 ? Math.min(100, rawPercent) : null)
      : (total > 0 ? Math.min(100, downloaded / total * 100) : null));
    const estimate = running && !manifest && total > downloaded && rate > 0
      ? (total - downloaded) / rate : null;
    const remainingSeconds = Number.isFinite(estimate) ? estimate : null;
    const size = manifest
      ? `${formatBytes(record.bytesProcessed)} muxed`
      : (total > 0 ? `${formatBytes(downloaded)} / ${formatBytes(total)}` : `${formatBytes(downloaded)} downloaded`);
    const speed = running && !manifest ? (rate > 0 ? `${formatBytes(rate)}/s` : "Calculating…") : "—";
    let eta = "—";
    if (record.status === "paused") eta = "Paused";
    else if (record.status === "cancelling") eta = "Stopping…";
    else if (running && manifest) eta = "Unavailable";
    else if (running && total === 0) eta = "Unknown";
    else if (running && downloaded >= total) eta = "Finishing…";
    else if (remainingSeconds !== null) eta = `${formatDuration(remainingSeconds)} left`;
    else if (running) eta = "Estimating…";
    return { manifest, percent, size, speed, eta, remainingSeconds, downloaded, total };
  }

  function fromEvent(event) {
    return {
      status: "downloading",
      phase: event.phase || "http",
      percent: event.percent_complete,
      bytesDownloaded: nonnegative(event.bytes_downloaded),
      bytesProcessed: nonnegative(event.bytes_processed),
      totalBytes: nonnegative(event.total_bytes),
      bytesPerSecond: nonnegative(event.bytes_per_second)
    };
  }

  globalThis.LdmTransferMetrics = Object.freeze({ describe, fromEvent, formatBytes, formatDuration });
})();
