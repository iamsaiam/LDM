const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MockElement {
  constructor() {
    this.children = [];
    this.replaceChildrenCalls = 0;
    this.dataset = {};
    this.style = {};
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; }
    };
    this.listeners = {};
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.replaceChildrenCalls += 1;
    this.children = [...children];
  }

  setAttribute() {}
  removeAttribute() {}
  focus() {}
}

test("restores an active engine job after the dashboard page reloads", async () => {
  const historyKey = "ldm.desktop.downloadHistory";
  const initialHistory = [{
    id: "desktop-job-1",
    filename: "lecture.mp4",
    contentType: "File download",
    format: "direct",
    status: "downloading",
    percent: 12,
    bytesDownloaded: 120,
    bytesProcessed: 0,
    totalBytes: 1000,
    bytesPerSecond: 20,
    phase: "http",
    updatedAt: Date.now() - 10000,
    error: ""
  }];
  let savedHistory = JSON.stringify(initialHistory);
  const elements = new Map();
  const intervals = [];
  let engineAvailable = true;
  let downloadedBytes = 550;
  let transferSpeed = 110;
  let engineFilename = "lecture (1).mp4";
  let engineStatus = "downloading";
  const controlRequests = [];
  const cancelRequests = [];
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new MockElement());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement() { return new MockElement(); }
  };
  const window = {
    addEventListener() {},
    setInterval(callback) {
      intervals.push(callback);
      return intervals.length;
    }
  };
  const navigator = {};
  const context = {
    document,
    window,
    navigator,
    localStorage: {
      getItem(key) { return key === historyKey ? savedHistory : null; },
      setItem(key, value) { if (key === historyKey) savedHistory = value; }
    },
    fetch: async (url, options = {}) => {
      if (url === "/api/health") return { ok: engineAvailable };
      if (url === "/api/pause" || url === "/api/resume") {
        controlRequests.push({ url, payload: JSON.parse(options.body) });
        engineStatus = url === "/api/pause" ? "paused" : "downloading";
        return { ok: true };
      }
      if (url === "/api/cancel") {
        cancelRequests.push(JSON.parse(options.body));
        return { ok: true };
      }
      if (url === "/api/downloads") {
        if (!engineAvailable) return { ok: false };
        return {
          ok: true,
          async json() {
            return {
              downloads: [{
                id: "desktop-job-1",
                status: engineStatus,
                filename: engineFilename,
                phase: "http",
                error: "",
                bytes_downloaded: downloadedBytes,
                bytes_processed: 0,
                total_bytes: 1000,
                percent_complete: downloadedBytes / 10,
                bytes_per_second: transferSpeed,
                created_at: Date.now() - 20000,
                updated_at: Date.now()
              }]
            };
          }
        };
      }
      throw new Error(`Unexpected dashboard request: ${url}`);
    },
    console,
    Date,
    Math,
    URL,
    TextDecoder,
    Uint8Array
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const metricsSource = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "transfer-metrics.js"), "utf8");
  vm.runInNewContext(metricsSource, context, { filename: "transfer-metrics.js" });
  vm.runInNewContext(source, context, { filename: "app.js" });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const recovered = JSON.parse(savedHistory).find((record) => record.id === "desktop-job-1");
  assert.equal(recovered.status, "downloading");
  assert.equal(recovered.filename, "lecture (1).mp4");
  assert.equal(recovered.percent, 55);
  assert.equal(recovered.bytesDownloaded, 550);
  assert.equal(elements.get("#overview-active").textContent, "1");
  assert.equal(intervals.length, 1, "the page should keep syncing status while open");
  assert.equal(elements.get("#local-badge").dataset.state, "connected");
  assert.equal(elements.get("#local-badge-label").textContent, "ONLINE");
  const textOf = (element) => [element.textContent || "", ...element.children.map(textOf)].join(" ");
  const rendered = textOf(elements.get("#download-list"));
  assert.match(rendered, /550 B \/ 1000 B/);
  assert.match(rendered, /110 B\/s/);
  assert.match(rendered, /5s left/);

  const findCancelButton = (element) => {
    if (element.className === "cancel-button") return element;
    for (const child of element.children) {
      const found = findCancelButton(child);
      if (found) return found;
    }
    return null;
  };
  const cancelButton = findCancelButton(elements.get("#download-list"));
  assert.ok(cancelButton, "active dashboard rows should expose a cancel action");
  const activeList = elements.get("#download-list");
  const historyList = elements.get("#history-list");
  const activeCard = activeList.children[0];
  const metrics = activeCard.children.find((child) => child.className === "transfer-metrics");
  const activeMounts = activeList.replaceChildrenCalls;
  const historyMounts = historyList.replaceChildrenCalls;
  downloadedBytes = 800;
  transferSpeed = 100;
  engineFilename = "updated lecture.mp4";
  intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(findCancelButton(activeList), cancelButton, "progress must retain the active Cancel button for focus and clicks");
  assert.equal(activeList.children[0], activeCard, "progress must update the existing transfer card");
  assert.equal(activeCard.children.find((child) => child.className === "transfer-metrics"), metrics);
  assert.equal(activeList.replaceChildrenCalls, activeMounts, "progress must not remount the active list");
  assert.equal(historyList.replaceChildrenCalls, historyMounts, "progress must not remount unchanged history");
  assert.match(textOf(activeList), /updated lecture\.mp4/);
  assert.match(textOf(activeList), /800 B \/ 1000 B/);
  assert.match(textOf(activeList), /100 B\/s/);
  assert.match(textOf(activeList), /2s left/);
  assert.match(textOf(activeList), /80\.0%/);
  const pauseButton = activeCard.children.find((child) => child.className === "card-actions").children.find((child) => child.className === "pause-button");
  assert.ok(pauseButton);
  await pauseButton.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(savedHistory)[0].status, "paused");
  assert.equal(pauseButton.textContent, "Resume");
  assert.equal(activeList.children[0], activeCard, "pausing must preserve the card and button focus");
  intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get("#overview-active").textContent, "1", "an engine-paused transfer still occupies its slot");
  assert.match(textOf(activeList), /Download paused/);
  await pauseButton.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(savedHistory)[0].status, "downloading");
  assert.deepEqual(controlRequests, [
    { url: "/api/pause", payload: { id: "desktop-job-1" } },
    { url: "/api/resume", payload: { id: "desktop-job-1" } }
  ]);
  cancelButton.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelRequests, [{ id: "desktop-job-1" }]);
  assert.equal(JSON.parse(savedHistory)[0].status, "cancelling");

  engineAvailable = false;
  elements.get("#refresh").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get("#local-badge").dataset.state, "offline");
  assert.equal(elements.get("#local-badge-label").textContent, "OFFLINE");
  assert.equal(elements.get("#form-status").dataset.source, "engine");

  engineAvailable = true;
  elements.get("#refresh").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.get("#local-badge").dataset.state, "connected");
  assert.equal(elements.get("#form-status").textContent, "", "reconnect should clear the stale engine error");
});

test("dashboard inspects actual manifest tracks before download and accepts raw FTP links", async () => {
  let saved = "[]";
  const elements = new Map();
  const payloads = [];
  const inspectPayloads = [];
  const context = {
    document: {
      querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new MockElement()); return elements.get(selector); },
      querySelectorAll: () => [], createElement: () => new MockElement()
    },
    window: { addEventListener() {}, setInterval() {} }, navigator: {}, URL, TextDecoder, Uint8Array, console,
    localStorage: { getItem: () => saved, setItem(_key, value) { saved = value; } },
    fetch: async (url, options = {}) => {
      if (url === "/api/health") return { ok: true };
      if (url === "/api/downloads") return { ok: true, async json() { return { downloads: [] }; } };
      if (url === "/api/inspect") {
        inspectPayloads.push(JSON.parse(options.body));
        return { ok: true, async json() { return { duration_seconds: 90, streams: [
          { index: 1, kind: "video", height: 1080, codec: "h264" },
          { index: 2, kind: "audio", language: "ben", codec: "aac" }
        ] }; } };
      }
      assert.equal(url, "/download");
      payloads.push(JSON.parse(options.body));
      return new Response(`${JSON.stringify({ event: "completed" })}\n`);
    }
  };
  for (const file of ["extension/transfer-metrics.js", "extension/media-options.js", "desktop-ui/app.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8"), context);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  const input = elements.get("#url-input");
  const filename = elements.get("#filename-input");
  const form = elements.get("#download-form");
  input.value = "https://cdn.example.test/lecture.m3u8?key=private";
  filename.value = "lecture";
  elements.get("#folder-input").value = "/tmp/ldm-browser-fixture/";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(payloads.length, 0, "inspection must never start a transfer");
  assert.deepEqual(inspectPayloads, [{ url: input.value, manifest_format: "hls", headers: {} }]);
  const pickerRoot = elements.get("#manifest-options").children[0];
  assert.ok(pickerRoot);
  const fields = pickerRoot.children[1].children;
  fields[1].children[1].value = "1";
  fields[2].children[1].value = "2";
  fields[3].children[1].value = "mkv";
  await form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].video_stream_index, 1);
  assert.equal(payloads[0].audio_stream_index, 2);
  assert.equal(payloads[0].output_format, "mkv");
  assert.equal(payloads[0].output_path, "/tmp/ldm-browser-fixture/lecture.mkv");
  assert.equal(Object.hasOwn(JSON.parse(saved)[0], "saveFolder"), false, "persistent history excludes the optional folder path");
  assert.equal(JSON.parse(saved)[0].status, "completed");
  assert.equal(Object.hasOwn(JSON.parse(saved)[0], "url"), false, "persistent history excludes signed media URLs");
  elements.get("#folder-input").value = "";
  input.value = "ftps://files.example.test/archive.tar";
  filename.value = "";
  input.listeners.input();
  await form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].url, input.value);
  assert.equal(payloads[1].manifest_format, "");
  assert.equal(payloads[1].output_path, "archive.tar");
  assert.equal(Object.hasOwn(payloads[1], "video_stream_index"), false);
  assert.equal(Object.hasOwn(payloads[1], "output_format"), false);
  elements.get("#folder-input").value = "relative/folder";
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(payloads.length, 2, "invalid relative folders must not start a download");
  assert.match(elements.get("#form-status").textContent, /absolute save folder/);
  elements.get("#folder-input").value = "";
  input.value = "https://cdn.example.test/stream?token=opaque";
  input.listeners.input();
  elements.get("#format-input").value = "hls";
  elements.get("#format-input").listeners.change();
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(inspectPayloads.length, 2, "an explicitly identified opaque playlist must be inspected");
  assert.equal(inspectPayloads[1].manifest_format, "hls");
  assert.equal(payloads.length, 2);
  elements.get("#format-input").value = "direct";
  elements.get("#format-input").listeners.change();
  await form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(payloads.length, 3);
  assert.equal(payloads[2].manifest_format, "");
  assert.equal(Object.hasOwn(payloads[2], "output_format"), false, "switching to a direct file must clear the inspected media selection");
});
