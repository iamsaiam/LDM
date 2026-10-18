const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createEvent(rejectExtraHeaders = false) {
  const listeners = [];
  return {
    registrations: listeners,
    addListener(listener, filter, options) {
      if (rejectExtraHeaders && options?.includes("extraHeaders")) throw new Error("Unsupported option: extraHeaders");
      listeners.push({ listener, filter, options });
    },
    emit(details) {
      for (const { listener, filter } of listeners) {
        if (!filter?.types || filter.types.includes(details.type)) listener(details);
      }
    },
    listener() { return listeners[0]?.listener; }
  };
}

function createStorage(initial, deferStreams = false) {
  const values = clone(initial);
  let release;
  const gate = deferStreams ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  return {
    values,
    release() { release?.(); },
    async get(key) {
      if (key === "detectedStreamsByTab") await gate;
      return { [key]: clone(values[key] ?? null) };
    },
    async set(changes) { Object.assign(values, clone(changes)); }
  };
}

function createBackground({ session = {}, deferStreams = false, rejectExtraHeaders = false,
  cookies, tabDetails, inspector } = {}) {
  const sessionStorage = createStorage(session, deferStreams);
  const localStorage = createStorage({});
  const webRequest = Object.fromEntries(["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived",
    "onCompleted", "onErrorOccurred"].map((name) => [name, createEvent(rejectExtraHeaders)]));
  const messages = createEvent();
  const notifications = [];
  const fetches = [];
  const inspectionRequests = [];
  const api = {
    storage: { session: sessionStorage, local: localStorage },
    webRequest,
    runtime: { onMessage: messages, async sendMessage() {} },
    tabs: {
      onRemoved: createEvent(),
      async get(tabId) { return { id: tabId, ...tabDetails }; },
      async sendMessage(tabId, message) { notifications.push({ tabId, ...message }); }
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  if (cookies) api.cookies = cookies;
  vm.runInNewContext(source, {
    chrome: api,
    URL,
    console,
    fetch: async (url, options) => {
      if (url === "http://127.0.0.1:12345/api/inspect" && inspector) {
        inspectionRequests.push(JSON.parse(options.body));
        return { ok: true, async json() { return clone(inspector); } };
      }
      fetches.push(url);
      assert.equal(url, "http://127.0.0.1:12345/api/downloads", "detection must not fetch media or start downloads");
      return { ok: true, async json() { return { downloads: [] }; } };
    }
  }, { filename: "background.js" });

  let requestId = 0;
  function network({ url, type = "media", mime, filename, method = "GET", statusCode = 200,
    requestHeaders = [], finish = false, tabId = 7 }) {
    const details = { requestId: `request-${++requestId}`, tabId, url, type, method, statusCode };
    webRequest.onBeforeRequest.emit(details);
    webRequest.onBeforeSendHeaders.emit({ ...details, requestHeaders });
    const responseHeaders = [];
    if (mime !== undefined) responseHeaders.push({ name: "Content-Type", value: mime });
    if (filename !== undefined) responseHeaders.push({ name: "Content-Disposition", value: filename });
    webRequest.onHeadersReceived.emit({ ...details, responseHeaders });
    if (finish) webRequest.onCompleted.emit(details);
    return details;
  }
  function message(value, sender = {}) {
    return new Promise((resolve, reject) => {
      try {
        const asyncResponse = messages.listener()(value, sender, (response) => resolve(clone(response)));
        if (asyncResponse !== true) resolve(undefined);
      } catch (error) { reject(error); }
    });
  }
  return {
    network, message, sessionStorage, localStorage, notifications, fetches, webRequest, inspectionRequests,
    navigate(tabId = 7) {
      webRequest.onBeforeRequest.emit({ tabId, type: "main_frame", url: "https://site.test/new-page" });
    },
    streams(tabId = 7) { return message({ type: "ldm:get-streams", tabId }).then((result) => result.streams); }
  };
}

const sender = { tab: { id: 7, url: "https://site.test/watch" }, url: "https://site.test/watch", frameId: 0 };

test("detects opaque native media and media disposition filenames with normalized response MIME", async () => {
  const background = createBackground();
  background.network({ url: "https://cdn.test/native", mime: "Application/Octet-Stream; charset=binary" });
  background.network({ url: "https://cdn.test/no-mime" });
  background.network({ url: "https://cdn.test/attachment", type: "other", mime: "application/octet-stream",
    filename: "attachment; filename*=UTF-8''my%20movie.mp4" });
  background.network({ url: "https://cdn.test/mime", type: "xmlhttprequest", mime: 'Video/MP4; codecs="avc1.640028"' });
  background.network({ url: "https://cdn.test/playlist", type: "xmlhttprequest",
    mime: "Application/Vnd.Apple.Mpegurl; charset=UTF-8" });
  background.network({ url: "https://cdn.test/unproven", type: "xmlhttprequest", mime: "application/octet-stream" });
  await tick();
  const streams = await background.streams();
  assert.equal(streams.length, 5);
  assert.equal(streams.find((stream) => stream.url.endsWith("attachment")).filename, "my movie.mp4");
  assert.equal(streams.find((stream) => stream.url.endsWith("mime")).contentType, "video/mp4");
  assert.equal(streams.find((stream) => stream.url.endsWith("playlist")).manifestFormat, "hls");
  assert.ok(background.notifications.some((message) => message.type === "ldm:streams-changed" && message.count === 5));
  assert.ok(background.fetches.every((url) => url === "http://127.0.0.1:12345/api/downloads"),
    "discovery must not start a transfer or probe the remote media URL");
});

test("selected DOM playlists use URL-scoped cookies from their tab store while preserving observed authentication", async () => {
  const lookups = [];
  const url = "https://cdn.test/master.m3u8";
  const background = createBackground({ tabDetails: { cookieStoreId: "firefox-container-2" },
    inspector: { streams: [] }, cookies: {
      async getAll(details) {
        lookups.push(clone(details));
        return [{ name: "session", value: "authorized", path: "/", httpOnly: true },
          { name: "partition", value: "another-site", partitionKey: { topLevelSite: "https://other.test" } },
          { name: "isolated", value: "other-first-party", firstPartyDomain: "other.test" }];
      }
    } });
  await background.message({ type: "ldm:media-sources", sources: [{ url, mediaKind: "video" }] }, sender);
  await background.message({ type: "ldm:inspect-stream", stream: { url, manifestFormat: "hls", headers: {} } }, sender);
  assert.deepEqual(lookups, [{ url, storeId: "firefox-container-2" }]);
  assert.deepEqual(background.inspectionRequests[0].headers,
    { referer: "https://site.test/watch", cookie: "session=authorized" });
  assert.ok(!JSON.stringify(background.localStorage.values).includes("authorized"));

  background.network({ url, type: "xmlhttprequest", mime: "application/vnd.apple.mpegurl",
    requestHeaders: [{ name: "Cookie", value: "observed=correct-partition" }] });
  await tick();
  await background.message({ type: "ldm:inspect-stream", stream: { url, manifestFormat: "hls", headers: {} } }, sender);
  assert.equal(lookups.length, 1, "captured request authentication must take precedence");
  assert.equal(background.inspectionRequests[1].headers.cookie, "observed=correct-partition");
});

test("rejects error pages, redirects, POST, nonmedia MIME and individual media fragments", async () => {
  const background = createBackground();
  const excluded = [
    { url: "https://cdn.test/login.mp4", mime: "Text/HTML; charset=UTF-8" },
    { url: "https://cdn.test/json", mime: "application/json" },
    { url: "https://cdn.test/text", mime: "text/plain" },
    { url: "https://cdn.test/pdf", mime: "application/pdf" },
    { url: "https://cdn.test/posted.mp4", mime: "video/mp4", method: "POST" },
    { url: "https://cdn.test/redirect.mp4", mime: "video/mp4", statusCode: 302 },
    { url: "https://cdn.test/missing.mp4", mime: "video/mp4", statusCode: 404 },
    { url: "https://cdn.test/chunk.ts?token=secret", mime: "video/mp4" },
    { url: "https://cdn.test/chunk.m4s", mime: "application/octet-stream" },
    { url: "https://cdn.test/chunk", mime: "Video/MP2T; codecs=avc1" },
    { url: "https://cdn.test/audio-chunk", mime: "audio/iso.segment; codecs=mp4a" },
    { url: "https://cdn.test/disposition", mime: "application/octet-stream", filename: 'attachment; filename="part.ts"' },
    { url: "blob:https://site.test/native", mime: "video/mp4" },
    { url: "data:video/mp4;base64,AAAA", mime: "video/mp4" }
  ];
  for (const entry of excluded) background.network(entry);
  await tick();
  assert.deepEqual(await background.streams(), []);
  assert.deepEqual(background.notifications, []);
});

test("keeps request headers and generation when completion happens before session restore", async () => {
  const background = createBackground({ deferStreams: true });
  background.network({ url: "https://cdn.test/private", mime: "application/octet-stream", finish: true,
    requestHeaders: [
      { name: "Cookie", value: "session=private" },
      { name: "Referer", value: "https://site.test/player" },
      { name: "Origin", value: "https://site.test" },
      { name: "User-Agent", value: "Native browser" },
      { name: "Authorization", value: "Bearer private" }
    ] });
  background.sessionStorage.release();
  await tick();
  const [stream] = await background.streams();
  assert.deepEqual(stream.headers, { cookie: "session=private", referer: "https://site.test/player",
    origin: "https://site.test", "user-agent": "Native browser" });
  assert.equal(stream.detectionEvidence, "media-request");
  assert.ok(!JSON.stringify(background.localStorage.values).includes("session=private"));
});

test("does not restore network or DOM discoveries from a previous navigation", async () => {
  const background = createBackground({ deferStreams: true });
  background.network({ url: "https://cdn.test/previous", mime: "video/mp4", finish: true });
  const domResult = background.message({ type: "ldm:media-sources", sources: [
    { url: "https://cdn.test/previous-dom", mediaKind: "video", height: 1080 }
  ] }, sender);
  background.navigate();
  background.sessionStorage.release();
  await domResult;
  await tick();
  assert.deepEqual(await background.streams(), []);
  assert.ok(background.notifications.every((message) => message.count === 0));
});

test("validates native DOM media, sender tab ownership, navigation and the per-message limit", async () => {
  const background = createBackground();
  const sources = [
    { url: "https://cdn.test/native", mediaKind: "video", width: 1920, height: 1080 },
    { url: "https://cdn.test/sound", mediaKind: "audio", contentType: "Audio/MPEG; codecs=mp3" },
    { url: "blob:https://site.test/blob", mediaKind: "video" },
    { url: "data:audio/mpeg;base64,AAAA", mediaKind: "audio" },
    { url: "https://cdn.test/fragment.ts", mediaKind: "video" },
    { url: "https://cdn.test/page.mp4", mediaKind: "video", contentType: "text/html" },
    { url: "https://cdn.test/image", mediaKind: "image", contentType: "video/mp4" }
  ];
  const result = await background.message({ type: "ldm:media-sources", tabId: 99, sources }, sender);
  assert.equal(result.count, 2);
  assert.deepEqual(await background.streams(99), []);
  const streams = await background.streams();
  assert.equal(streams.find((stream) => stream.url.endsWith("native")).resolution, "1080p");
  assert.equal(streams[0].headers.referer, sender.url);
  await background.message({ type: "ldm:media-sources", tabId: 7, sources }, {});
  await background.message({ type: "ldm:media-sources", sources: [{ url: "https://cdn.test/stale", mediaKind: "video" }] },
    { ...sender, url: "https://site.test/old-page" });
  assert.equal((await background.streams()).length, 2);
  await background.message({ type: "ldm:media-sources", sources: [{ url: "https://cdn.test/hash", mediaKind: "audio" }] },
    { ...sender, url: `${sender.url}#player` });
  assert.equal((await background.streams()).length, 3, "fragment-only navigation retains valid native media");
  const batch = Array.from({ length: 45 }, (_, index) => ({ url: `https://cdn.test/batch-${index}`, mediaKind: "video" }));
  const limited = await background.message({ type: "ldm:media-sources", sources: batch }, sender);
  assert.equal(limited.count, 35);
  assert.ok(background.fetches.every((url) => url === "http://127.0.0.1:12345/api/downloads"),
    "DOM media reports must not start a transfer or probe their URLs");
});

test("DOM observations preserve network filename and private headers while adding actual dimensions", async () => {
  const background = createBackground();
  const url = "https://cdn.test/opaque";
  background.network({ url, type: "xmlhttprequest", mime: "application/octet-stream",
    filename: 'attachment; filename="movie.mp4"', requestHeaders: [
      { name: "Cookie", value: "token=secret" }, { name: "Referer", value: "https://site.test/embedded-player" },
      { name: "Origin", value: "https://site.test" }
    ] });
  await tick();
  const report = { type: "ldm:media-sources", sources: [{ url, mediaKind: "video", width: 1920, height: 1080 }] };
  await background.message(report, sender);
  const [stream] = await background.streams();
  assert.equal(stream.filename, "movie.mp4");
  assert.equal(stream.detectionSource, "network");
  assert.equal(stream.resolution, "1080p");
  assert.deepEqual(stream.headers, { referer: "https://site.test/embedded-player", cookie: "token=secret", origin: "https://site.test" });
  const count = background.notifications.length;
  await background.message(report, sender);
  assert.equal(background.notifications.length, count, "unchanged metadata must not repeatedly refresh overlays");
  background.network({ url, type: "xmlhttprequest", mime: "video/mp4", filename: 'attachment; filename="movie.mp4"' });
  await tick();
  assert.equal((await background.streams())[0].resolution, "1080p");
  assert.equal((await background.streams())[0].headers.cookie, "token=secret");
});

test("new native media evidence survives a worker restart without persistent private history", async () => {
  const background = createBackground();
  background.network({ url: "https://cdn.test/native-network", mime: "application/octet-stream" });
  background.network({ url: "https://cdn.test/filename", type: "other", mime: "application/octet-stream",
    filename: 'attachment; filename="audio.flac"' });
  await background.message({ type: "ldm:media-sources", sources: [
    { url: "https://cdn.test/native-dom", mediaKind: "audio" }
  ] }, sender);
  await tick();
  const restored = createBackground({ session: background.sessionStorage.values });
  assert.equal((await restored.streams()).length, 3);
  assert.ok(!JSON.stringify(background.localStorage.values).includes("https://cdn.test"));
  assert.ok(!JSON.stringify(restored.localStorage.values).includes("https://cdn.test"));
});

test("Firefox-shaped header events fall back from extraHeaders without duplicating listeners", async () => {
  const background = createBackground({ rejectExtraHeaders: true });
  for (const [name, option] of [["onBeforeSendHeaders", "requestHeaders"], ["onHeadersReceived", "responseHeaders"]]) {
    const registrations = background.webRequest[name].registrations;
    assert.equal(registrations.length, 1);
    assert.deepEqual([...registrations[0].options], [option]);
  }
  background.network({ url: "https://cdn.test/firefox-native", requestHeaders: [
    { name: "Origin", value: "https://site.test" }
  ] });
  await tick();
  assert.equal((await background.streams())[0].headers.origin, "https://site.test");
});

test("uses playlist filename hints and accepts known playlists mislabeled as plain text", async () => {
  const background = createBackground();
  background.network({ url: "https://cdn.test/master.m3u8?key=secret", type: "xmlhttprequest", mime: "text/plain" });
  background.network({ url: "https://cdn.test/manifest.mpd", type: "xmlhttprequest", mime: "Text/Plain; charset=UTF-8" });
  background.network({ url: "https://cdn.test/opaque-hls", type: "other", mime: "application/octet-stream",
    filename: 'attachment; filename="master.m3u8"' });
  background.network({ url: "https://cdn.test/opaque-dash", type: "other", mime: "application/octet-stream",
    filename: 'attachment; filename="manifest.mpd"' });
  background.network({ url: "https://cdn.test/plain-filename", type: "xmlhttprequest", mime: "text/plain",
    filename: 'attachment; filename="master.m3u8"' });
  background.network({ url: "https://cdn.test/login.m3u8", mime: "text/html" });
  background.network({ url: "https://cdn.test/error.mpd", mime: "application/json" });
  await tick();
  const streams = await background.streams();
  assert.equal(streams.length, 5);
  for (const stream of streams) {
    assert.equal(stream.manifestFormat, /(?:dash|mpd)/.test(stream.url) ? "dash" : "hls");
  }
  const restarted = createBackground({ session: background.sessionStorage.values });
  assert.equal((await restarted.streams()).length, 5);
});
