const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
    listener() {
      return listeners[0];
    }
  };
}

function createStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      if (typeof key === "string") return { [key]: values[key] };
      if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, values[name]]));
      return { ...values };
    },
    async set(changes) {
      Object.assign(values, changes);
    }
  };
}

function dispatchMessage(listener, message, sender = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const keepChannelOpen = listener(message, sender, sendResponse);
      if (keepChannelOpen !== true && !settled) sendResponse(undefined);
    } catch (error) {
      reject(error);
    }
  });
}

test("both browser manifests enable the generic player overlay", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", name), "utf8"));
    assert.ok(manifest.host_permissions.includes("<all_urls>"), `${name} must detect media on all sites`);
    assert.ok(manifest.permissions.includes("alarms"), `${name} must resume queued work after a worker restart`);
    assert.deepEqual(manifest.content_scripts[0].matches, ["<all_urls>"]);
    assert.equal(manifest.content_scripts[0].all_frames, true);
    assert.deepEqual(manifest.web_accessible_resources[0].matches, ["<all_urls>"]);
    assert.ok(manifest.host_permissions.includes("http://127.0.0.1:12345/*"));
  }
});

test("detects a media response and records a user-selected local download", async () => {
  const sessionStorage = createStorage({
    queuedDownloads: [{
      id: "recovered-id",
      tabId: 8,
      stream: {
        url: "https://media.example.test/recover.mp4",
        filename: "recover.mp4",
        contentType: "video/mp4",
        manifestFormat: "",
        resolution: "1080p",
        headers: {}
      }
    }]
  });
  const localStorage = createStorage({
    downloadHistory: [{
      id: "recovered-id",
      filename: "recover.mp4",
      contentType: "video/mp4",
      format: "direct",
      status: "interrupted",
      percent: null,
      bytesDownloaded: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      error: "The extension restarted before this download finished."
    }]
  });
  const webRequest = {
    onBeforeRequest: createEvent(),
    onBeforeSendHeaders: createEvent(),
    onHeadersReceived: createEvent(),
    onCompleted: createEvent(),
    onErrorOccurred: createEvent()
  };
  const runtimeMessages = createEvent();
  const tabMessages = [];
  const badgeUpdates = [];
  const api = {
    storage: {
      session: sessionStorage,
      local: localStorage
    },
    webRequest,
    runtime: {
      onMessage: runtimeMessages,
      getURL(path) { return `chrome-extension://ldm-fixture/${path}`; },
      async sendMessage(message) {
        runtimeMessages.emit(message, {}, () => {});
      }
    },
    tabs: {
      onRemoved: createEvent(),
      async sendMessage(tabId, message) {
        tabMessages.push({ tabId, message });
      }
    },
    action: {
      async setBadgeText(update) { badgeUpdates.push(update); },
      async setBadgeBackgroundColor() {}
    }
  };

  let fetchCalls = 0;
  let forwardedPayload;
  const progressLines = [
    JSON.stringify({
      event: "progress",
      percent_complete: 48,
      bytes_downloaded: 480,
      total_bytes: 1000,
      output_filename: "sample (1).mp4"
    }),
    JSON.stringify({ event: "completed" })
  ];
  const context = {
    chrome: api,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000002" },
    fetch: async (url, options = {}) => {
      if (url === "http://127.0.0.1:12345/api/downloads") {
        return new Response(JSON.stringify({
          downloads: [{
            id: "recovered-id",
            status: "completed",
            filename: "recover (1).mp4",
            phase: "http",
            error: "",
            bytes_downloaded: 123,
            bytes_processed: 0,
            total_bytes: 123,
            percent_complete: 100,
            bytes_per_second: 0,
            updated_at: Date.now()
          }]
        }), { status: 200 });
      }
      fetchCalls += 1;
      assert.equal(url, "http://127.0.0.1:12345/download");
      forwardedPayload = JSON.parse(options.body);
      return new Response(`${progressLines.join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" }
      });
    },
    URL,
    TextDecoder,
    Uint8Array,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });

  webRequest.onBeforeRequest.emit({
    requestId: "request-1",
    tabId: 7,
    type: "media",
    url: "https://media.example.test/movie.mp4"
  });
  webRequest.onBeforeSendHeaders.emit({
    requestId: "request-1",
    requestHeaders: [
      { name: "User-Agent", value: "LDM test browser" },
      { name: "Cookie", value: "session=private" },
      { name: "Referer", value: "https://media.example.test/watch" },
      { name: "Accept", value: "video/*" }
    ]
  });
  webRequest.onHeadersReceived.emit({
    requestId: "request-1",
    tabId: 7,
    url: "https://media.example.test/movie.mp4",
    responseHeaders: [
      { name: "Content-Type", value: "video/mp4" },
      { name: "Content-Disposition", value: 'attachment; filename="sample.mp4"' }
    ]
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls, 0, "detection alone must not start a transfer");

  const listener = runtimeMessages.listener();
  const restored = await dispatchMessage(listener, { type: "ldm:sync-download-history" });
  const recovered = restored.records.find((record) => record.id === "recovered-id");
  assert.equal(recovered.status, "completed", "an engine-reported completion should recover after extension restart");
  assert.equal(recovered.filename, "recover (1).mp4");
  assert.equal(sessionStorage.values.queuedDownloads.length, 0,
    "a restored task already known to the engine must not be requeued");

  const detected = await dispatchMessage(listener, { type: "ldm:get-streams", tabId: 7 });
  assert.equal(detected.streams.length, 1);
  assert.equal(detected.streams[0].filename, "sample.mp4");
  assert.deepEqual({ ...detected.streams[0].headers }, {
    "user-agent": "LDM test browser",
    cookie: "session=private",
    referer: "https://media.example.test/watch"
  });

  const contentResult = await dispatchMessage(listener, { type: "ldm:get-streams", tabId: 99 },
    { tab: { id: 7 }, url: "https://media.example.test/watch" });
  assert.equal(contentResult.streams.length, 1, "content scripts must use their own tab");

  const queued = await dispatchMessage(listener, {
    type: "ldm:download-stream",
    id: "00000000-0000-4000-8000-000000000001",
    tabId: 7,
    stream: { ...detected.streams[0], headers: { referer: "https://media.example.test/stale-card" } }
  }, { tab: { id: 99 }, url: "chrome-extension://ldm-fixture/popup.html" });
  assert.equal(queued.accepted, true);

  const deadline = Date.now() + 2000;
  let record;
  while (Date.now() < deadline) {
    const history = await dispatchMessage(listener, { type: "ldm:get-download-history" });
    record = history.records.find((item) => item.id === queued.id);
    if (record?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(fetchCalls, 1);
  assert.equal(forwardedPayload.url, "https://media.example.test/movie.mp4");
  assert.equal(forwardedPayload.output_path, "sample.mp4");
  assert.deepEqual(forwardedPayload.headers, {
    "user-agent": "LDM test browser",
    cookie: "session=private",
    referer: "https://media.example.test/watch"
  });
  assert.equal(record?.status, "completed");
  assert.equal(record?.filename, "sample (1).mp4");
  assert.ok(tabMessages.some(({ message }) => message.event?.event === "progress"));
  assert.ok(tabMessages.some(({ message }) => message.event?.event === "completed"));

  webRequest.onBeforeRequest.emit({
    requestId: "navigation-1",
    tabId: 7,
    type: "main_frame",
    url: "https://another.example.test/"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterNavigation = await dispatchMessage(listener, { type: "ldm:get-streams", tabId: 7 });
  assert.equal(afterNavigation.streams.length, 0, "a new page must not see streams from the previous page");
  assert.ok(badgeUpdates.some((update) => update.tabId === 7 && update.text === ""));

  webRequest.onHeadersReceived.emit({
    requestId: "request-1",
    tabId: 7,
    url: "https://media.example.test/movie.mp4",
    responseHeaders: [{ name: "Content-Type", value: "video/mp4" }]
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterLateResponse = await dispatchMessage(listener, { type: "ldm:get-streams", tabId: 7 });
  assert.equal(afterLateResponse.streams.length, 0, "a late old-page response must not repopulate the list");
});

test("restores a waiting download after the background service worker restarts", async () => {
  const downloadId = "00000000-0000-4000-8000-000000000009";
  const stream = {
    url: "https://media.example.test/recovered.mp4",
    filename: "recovered.mp4",
    contentType: "video/mp4",
    manifestFormat: "",
    resolution: "1080p",
    headers: { referer: "https://media.example.test/watch" }
  };
  const sessionStorage = createStorage({
    queuedDownloads: [{ id: downloadId, tabId: 9, stream }]
  });
  const localStorage = createStorage({
    downloadHistory: [{
      id: downloadId,
      filename: stream.filename,
      contentType: stream.contentType,
      resolution: stream.resolution,
      format: "direct",
      status: "queued",
      percent: null,
      bytesDownloaded: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      error: ""
    }]
  });
  const runtimeMessages = createEvent();
  const tabMessages = [];
  const api = {
    storage: { session: sessionStorage, local: localStorage },
    webRequest: {
      onBeforeRequest: createEvent(),
      onBeforeSendHeaders: createEvent(),
      onHeadersReceived: createEvent(),
      onCompleted: createEvent(),
      onErrorOccurred: createEvent()
    },
    runtime: {
      onMessage: runtimeMessages,
      async sendMessage(message) { runtimeMessages.emit(message, {}, () => {}); }
    },
    tabs: {
      onRemoved: createEvent(),
      async sendMessage(tabId, message) { tabMessages.push({ tabId, message }); }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };
  let forwardedPayload;
  const progressEvents = [
    JSON.stringify({ event: "progress", percent_complete: 100, bytes_downloaded: 1000, total_bytes: 1000 }),
    JSON.stringify({ event: "completed" })
  ];
  const context = {
    chrome: api,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000010" },
    fetch: async (url, options = {}) => {
      if (url === "http://127.0.0.1:12345/api/downloads") {
        return new Response(JSON.stringify({ downloads: [] }), { status: 200 });
      }
      assert.equal(url, "http://127.0.0.1:12345/download");
      forwardedPayload = JSON.parse(options.body);
      return new Response(`${progressEvents.join("\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" }
      });
    },
    URL,
    TextDecoder,
    Uint8Array,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });

  const listener = runtimeMessages.listener();
  const deadline = Date.now() + 2000;
  let record;
  while (Date.now() < deadline) {
    const response = await dispatchMessage(listener, { type: "ldm:get-download-history" });
    record = response.records.find((item) => item.id === downloadId);
    if (record?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(forwardedPayload?.id, downloadId, "the restored request should be sent to the local engine");
  assert.equal(forwardedPayload?.url, stream.url);
  assert.equal(forwardedPayload?.headers.referer, stream.headers.referer);
  assert.equal(record?.status, "completed");
  assert.ok(tabMessages.some(({ message }) => message.event?.event === "completed"));
  assert.equal(sessionStorage.values.queuedDownloads.length, 0, "accepted work should leave the pending session queue");
  assert.equal(Object.hasOwn(record, "url"), false, "persistent history must not store media URLs");
});

test("alarm resumes queued work after recovered engine jobs release queue slots", async () => {
  const activeIds = [
    "00000000-0000-4000-8000-000000000021",
    "00000000-0000-4000-8000-000000000022"
  ];
  const queuedId = "00000000-0000-4000-8000-000000000023";
  const tasks = [...activeIds, queuedId].map((id, index) => ({
    id,
    tabId: 12,
    stream: {
      url: `https://media.example.test/task-${index}.mp4`,
      filename: `task-${index}.mp4`,
      contentType: "video/mp4",
      manifestFormat: "",
      resolution: "720p",
      headers: {}
    }
  }));
  const sessionStorage = createStorage({ queuedDownloads: tasks });
  const localStorage = createStorage({
    downloadHistory: tasks.map(({ id, stream }) => ({
      id,
      filename: stream.filename,
      contentType: stream.contentType,
      resolution: stream.resolution,
      format: "direct",
      status: "queued",
      percent: null,
      bytesDownloaded: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      error: ""
    }))
  });
  const runtimeMessages = createEvent();
  const alarmEvents = createEvent();
  const scheduledAlarms = new Map();
  const tabMessages = [];
  const api = {
    storage: { session: sessionStorage, local: localStorage },
    webRequest: {
      onBeforeRequest: createEvent(),
      onBeforeSendHeaders: createEvent(),
      onHeadersReceived: createEvent(),
      onCompleted: createEvent(),
      onErrorOccurred: createEvent()
    },
    alarms: {
      onAlarm: alarmEvents,
      async get(name) { return scheduledAlarms.get(name) ?? null; },
      async create(name, options) { scheduledAlarms.set(name, { name, ...options }); },
      async clear(name) { return scheduledAlarms.delete(name); }
    },
    runtime: {
      onMessage: runtimeMessages,
      async sendMessage(message) { runtimeMessages.emit(message, {}, () => {}); }
    },
    tabs: {
      onRemoved: createEvent(),
      async sendMessage(tabId, message) { tabMessages.push({ tabId, message }); }
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    }
  };
  let statusReads = 0;
  let downloadPosts = 0;
  let forwardedPayload;
  const context = {
    chrome: api,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000024" },
    fetch: async (url, options = {}) => {
      if (url === "http://127.0.0.1:12345/api/downloads") {
        statusReads += 1;
        const jobs = activeIds.map((id, index) => ({
          id,
          status: statusReads > 1 && index === 0 ? "completed" : "downloading",
          filename: `task-${index}.mp4`,
          phase: "http",
          error: "",
          bytes_downloaded: statusReads > 1 && index === 0 ? 1000 : 500,
          bytes_processed: 0,
          total_bytes: 1000,
          percent_complete: statusReads > 1 && index === 0 ? 100 : 50,
          bytes_per_second: 100,
          created_at: Date.now() - 5000,
          updated_at: Date.now()
        }));
        return new Response(JSON.stringify({ downloads: jobs }), { status: 200 });
      }
      assert.equal(url, "http://127.0.0.1:12345/download");
      downloadPosts += 1;
      forwardedPayload = JSON.parse(options.body);
      return new Response(`${JSON.stringify({ event: "completed" })}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" }
      });
    },
    URL,
    TextDecoder,
    Uint8Array,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });

  const listener = runtimeMessages.listener();
  const initial = await dispatchMessage(listener, { type: "ldm:get-download-history" });
  assert.equal(initial.records.find((record) => record.id === queuedId)?.status, "queued");
  assert.equal(downloadPosts, 0, "two engine jobs should hold both extension queue slots");
  assert.equal(scheduledAlarms.size, 1, "the background should schedule a queue recheck");

  alarmEvents.emit({ name: "ldm-queued-transfer-poll" });
  const deadline = Date.now() + 2000;
  let recovered;
  while (Date.now() < deadline) {
    const response = await dispatchMessage(listener, { type: "ldm:get-download-history" });
    recovered = response.records.find((record) => record.id === queuedId);
    if (recovered?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(statusReads, 2, "the alarm should reconcile engine progress");
  assert.equal(downloadPosts, 1, "one released engine slot should start one queued task");
  assert.equal(forwardedPayload?.id, queuedId);
  assert.equal(recovered?.status, "completed");
  assert.ok(tabMessages.some(({ message }) => message.event?.event === "completed"));
  assert.equal(scheduledAlarms.size, 0, "the alarm should stop after the queue drains");
});

test("cancels a recovered active engine job from extension history", async () => {
  const id = "00000000-0000-4000-8000-000000000099";
  const localStorage = createStorage({
    downloadHistory: [{
      id,
      filename: "recovered.mp4",
      contentType: "video/mp4",
      format: "direct",
      status: "downloading",
      percent: 25,
      bytesDownloaded: 250,
      bytesProcessed: 0,
      totalBytes: 1000,
      bytesPerSecond: 50,
      error: ""
    }]
  });
  const sessionStorage = createStorage({ queuedDownloads: [] });
  const runtimeMessages = createEvent();
  const api = {
    storage: { session: sessionStorage, local: localStorage },
    webRequest: {
      onBeforeRequest: createEvent(),
      onBeforeSendHeaders: createEvent(),
      onHeadersReceived: createEvent(),
      onCompleted: createEvent(),
      onErrorOccurred: createEvent()
    },
    alarms: {
      onAlarm: createEvent(),
      async get() { return null; },
      async create() {},
      async clear() { return true; }
    },
    runtime: { onMessage: runtimeMessages, async sendMessage() {} },
    tabs: { onRemoved: createEvent(), async sendMessage() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  const cancelRequests = [];
  const context = {
    chrome: api,
    fetch: async (url, options = {}) => {
      if (url === "http://127.0.0.1:12345/api/downloads") {
        return new Response(JSON.stringify({ downloads: [{
          id,
          status: "downloading",
          filename: "recovered.mp4",
          phase: "http",
          error: "",
          bytes_downloaded: 250,
          bytes_processed: 0,
          total_bytes: 1000,
          percent_complete: 25,
          bytes_per_second: 50,
          created_at: Date.now() - 1000,
          updated_at: Date.now()
        }] }), { status: 200 });
      }
      assert.equal(url, "http://127.0.0.1:12345/api/cancel");
      cancelRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ status: "cancelling", id }), { status: 200 });
    },
    URL,
    TextDecoder,
    Uint8Array,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInNewContext(source, context, { filename: "background.js" });

  const response = await dispatchMessage(runtimeMessages.listener(), {
    type: "ldm:cancel-download",
    id
  });
  assert.equal(response.cancelled, true);
  assert.equal(response.status, "cancelling");
  assert.deepEqual(cancelRequests, [{ id }]);
  assert.equal(localStorage.values.downloadHistory[0].status, "cancelling");
});

test("paused engine jobs hold slots and paused manifest selections survive worker recovery", async () => {
  const engineIds = ["00000000-0000-4000-8000-000000000111", "00000000-0000-4000-8000-000000000112"];
  const queuedId = "00000000-0000-4000-8000-000000000113";
  const selected = {
    url: "https://cdn.example.test/master.m3u8?session=private", filename: "lecture.opus",
    manifestFormat: "hls", contentType: "application/vnd.apple.mpegurl", resolution: "Audio only",
    audio_only: true, audio_stream_index: 7, output_format: "opus", headers: { cookie: "session=private" }
  };
  const sessionStorage = createStorage({ queuedDownloads: [{ id: queuedId, tabId: 7, stream: selected, paused: true }] });
  const localStorage = createStorage({ downloadHistory: [
    ...engineIds.slice(0, 1).map((id) => ({ id, filename: "active.mp4", status: "paused", format: "direct" })),
    { id: queuedId, filename: "lecture.opus", status: "paused", format: "hls", pausedQueued: true }
  ] });
  const runtimeMessages = createEvent();
  const api = {
    storage: { session: sessionStorage, local: localStorage },
    webRequest: { onBeforeRequest: createEvent(), onBeforeSendHeaders: createEvent(), onHeadersReceived: createEvent(),
      onCompleted: createEvent(), onErrorOccurred: createEvent() },
    runtime: { onMessage: runtimeMessages, async sendMessage() {} },
    tabs: { onRemoved: createEvent(), async sendMessage() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  const jobs = engineIds.map((id) => ({ id, status: "paused", filename: "active.mp4", percent_complete: 25 }));
  const calls = [];
  const context = {
    chrome: api, URL, TextDecoder, Uint8Array, console, setTimeout,
    fetch: async (url, options = {}) => {
      if (url.endsWith("/api/downloads")) return new Response(JSON.stringify({ downloads: jobs }));
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url.endsWith("/api/inspect")) return new Response(JSON.stringify({ streams: [{ index: 7, kind: "audio", codec: "opus" }] }));
      if (url.endsWith("/api/resume")) { jobs.find((job) => job.id === body.id).status = "downloading"; return new Response(JSON.stringify({ status: "downloading" })); }
      if (url.endsWith("/api/pause")) { jobs.find((job) => job.id === body.id).status = "paused"; return new Response(JSON.stringify({ status: "paused" })); }
      if (url.endsWith("/api/cancel")) return new Response(JSON.stringify({ status: "cancelling" }));
      assert.ok(url.endsWith("/download"));
      return new Response(`${JSON.stringify({ event: "completed" })}\n`);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context);
  const message = (value) => dispatchMessage(runtimeMessages.listener(), value);
  let result = await message({ type: "ldm:get-download-history" });
  assert.equal(result.records.find((record) => record.id === queuedId).status, "paused");
  assert.equal(sessionStorage.values.queuedDownloads[0].paused, true);
  assert.equal(calls.length, 0, "restored paused selections must not start automatically");
  const inspected = await message({ type: "ldm:inspect-stream", stream: selected });
  assert.equal(inspected.streams[0].index, 7);
  assert.deepEqual(calls[0].body, { url: selected.url, manifest_format: "hls", headers: selected.headers });
  assert.equal(calls.filter((call) => call.url.endsWith("/download")).length, 0, "inspection must not download");
  result = await message({ type: "ldm:resume-download", id: queuedId });
  assert.equal(result.status, "queued");
  assert.equal(calls.filter((call) => call.url.endsWith("/download")).length, 0, "paused engine jobs still hold both slots");
  await message({ type: "ldm:pause-download", id: queuedId });
  assert.equal(sessionStorage.values.queuedDownloads[0].paused, true);
  assert.equal(sessionStorage.values.queuedDownloads[0].stream.audio_stream_index, 7);
  assert.equal(sessionStorage.values.queuedDownloads[0].stream.output_format, "opus");
  await message({ type: "ldm:clear-download-history" });
  result = await message({ type: "ldm:get-download-history" });
  assert.equal(result.records.length, 2, "clearing finished history must preserve all tracked paused transfers");
  await message({ type: "ldm:resume-download", id: engineIds[0] });
  await message({ type: "ldm:pause-download", id: engineIds[0] });
  assert.deepEqual(calls.filter((call) => /\/api\/(resume|pause)$/.test(call.url)).map((call) => call.body), [{ id: engineIds[0] }, { id: engineIds[0] }]);
  jobs[0].status = "completed";
  await message({ type: "ldm:sync-download-history" });
  assert.equal(calls.filter((call) => call.url.endsWith("/download")).length, 0, "a local paused item must remain paused after slots release");
  await message({ type: "ldm:resume-download", id: queuedId });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await message({ type: "ldm:get-download-history" });
    if (result.records.find((record) => record.id === queuedId).status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const downloads = calls.filter((call) => call.url.endsWith("/download"));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].body.audio_only, true);
  assert.equal(downloads[0].body.audio_stream_index, 7);
  assert.equal(downloads[0].body.output_format, "opus");
  assert.equal(downloads[0].body.output_path, "lecture.opus");
  assert.equal(downloads[0].body.headers.cookie, "session=private");
  assert.equal(Object.hasOwn(result.records.find((record) => record.id === queuedId), "url"), false);
  assert.equal(Object.hasOwn(result.records.find((record) => record.id === queuedId), "headers"), false);
  assert.equal((await message({ type: "ldm:cancel-download", id: engineIds[1] })).status, "cancelling");
});
