const assert = require("node:assert/strict");
const test = require("node:test");
require("../transfer-metrics.js");
const { describe, fromEvent, formatBytes, formatDuration } = globalThis.LdmTransferMetrics;

test("known file totals show transferred bytes, actual speed and remaining time", () => {
  const metrics = describe(fromEvent({
    bytes_downloaded: 20 * 1048576,
    total_bytes: 100 * 1048576,
    bytes_per_second: 4 * 1048576,
    percent_complete: 20
  }));
  assert.equal(metrics.percent, 20);
  assert.equal(metrics.size, "20.0 MiB / 100 MiB");
  assert.equal(metrics.speed, "4.00 MiB/s");
  assert.equal(metrics.eta, "20s left");
  assert.equal(metrics.remainingSeconds, 20);
});

test("unknown file size stays indeterminate even when the engine emits zero percent", () => {
  const metrics = describe(fromEvent({ bytes_downloaded: 2048, total_bytes: 0, percent_complete: 0, bytes_per_second: 1024 }));
  assert.equal(metrics.percent, null);
  assert.equal(metrics.size, "2.00 KiB downloaded");
  assert.equal(metrics.eta, "Unknown");
  assert.equal(metrics.remainingSeconds, null);
});

test("resumed progress estimates only the bytes still needed at the reported rate", () => {
  const metrics = describe({ status: "downloading", bytesDownloaded: 9000, totalBytes: 10000, bytesPerSecond: 100, percent: null });
  assert.equal(metrics.percent, 90);
  assert.equal(metrics.eta, "10s left");
  assert.equal(describe({ status: "downloading", bytesDownloaded: 10000, totalBytes: 10000, bytesPerSecond: 100 }).eta, "Finishing…");
});

test("manifest output is never presented as a network transfer rate or invented ETA", () => {
  const metrics = describe(fromEvent({ phase: "hls", bytes_processed: 1048576, bytes_per_second: 9000, percent_complete: 0 }));
  assert.equal(metrics.manifest, true);
  assert.equal(metrics.size, "1.00 MiB muxed");
  assert.equal(metrics.percent, null);
  assert.equal(metrics.speed, "—");
  assert.equal(metrics.eta, "Unavailable");
  assert.equal(describe({ status: "downloading", phase: "dash", percent: 40 }).percent, 40);
  const cancelled = describe({ status: "cancelled", phase: "cancelled", format: "hls", bytesProcessed: 2048 });
  assert.equal(cancelled.size, "2.00 KiB muxed");
  assert.equal(cancelled.speed, "—");
});

test("terminal states do not display a stale active rate or ETA", () => {
  for (const status of ["completed", "cancelled", "failed", "interrupted"]) {
    const metrics = describe({ status, totalBytes: 1000, bytesDownloaded: 1000, bytesPerSecond: 100 });
    assert.equal(metrics.speed, "—");
    assert.equal(metrics.eta, "—");
    if (status === "completed") assert.equal(metrics.percent, 100);
  }
  assert.equal(describe({ status: "cancelling" }).eta, "Stopping…");
});

test("invalid and slow rates do not produce NaN or infinite estimates", () => {
  for (const bytesPerSecond of [0, -10, NaN, Infinity]) {
    const metrics = describe({ status: "downloading", bytesDownloaded: 10, totalBytes: 100, bytesPerSecond });
    assert.equal(metrics.speed, "Calculating…");
    assert.equal(metrics.eta, "Estimating…");
    assert.equal(metrics.remainingSeconds, null);
  }
  assert.equal(formatBytes(0.5), "1 B");
  assert.equal(formatBytes(Infinity), "0 B");
  assert.equal(formatDuration(61), "1m 1s");
  assert.equal(formatDuration(3601), "1h 0m");
  const stalled = describe({ status: "downloading", totalBytes: 1000, bytesPerSecond: Number.MIN_VALUE });
  assert.equal(stalled.remainingSeconds, null);
  assert.equal(stalled.eta, "Estimating…");
});

test("paused transfers keep their bytes and processed media does not invent network speed", () => {
  const paused = describe({ status: "paused", bytesDownloaded: 500, totalBytes: 1000, bytesPerSecond: 100 });
  assert.equal(paused.percent, 50);
  assert.equal(paused.speed, "—");
  assert.equal(paused.eta, "Paused");
  const media = describe(fromEvent({ phase: "media", bytes_processed: 1024, bytes_per_second: 500 }));
  assert.equal(media.manifest, true);
  assert.equal(media.size, "1.00 KiB muxed");
  assert.equal(media.speed, "—");
  assert.equal(media.eta, "Unavailable");
});
