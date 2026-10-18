const extensionApi = globalThis.browser ?? globalThis.chrome;
const sessionStore = extensionApi.storage.session;
const STORAGE_KEY = "detectedStreamsByTab";
const DOWNLOAD_HISTORY_KEY = "downloadHistory";
const QUEUED_DOWNLOADS_KEY = "queuedDownloads";
const QUEUE_ALARM_NAME = "ldm-queued-transfer-poll";
const MAX_STREAMS_PER_TAB = 100;
const MAX_DOM_SOURCES_PER_BATCH = 32;
const MAX_PENDING_REQUESTS = 1000;
const MAX_HISTORY_ITEMS = 50;
const MAX_CONCURRENT_DOWNLOADS = 2;
const MEDIA_EXTENSION_PATTERN =
  /\.(?:3g2|3gp|aac|ac3|avi|flac|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|oga|ogg|ogv|opus|wav|webm|wma|wmv|m3u8|mpd)(?:$|[?#])/i;
const MEDIA_MIME_PATTERN =
  /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|mpegurl))/i;
const MEDIA_SEGMENT_PATTERN = /\.(?:m4s|ts)(?:$|[?#])/i;
const MEDIA_SEGMENT_MIME_PATTERN = /^(?:video\/mp2t|video\/iso\.segment|audio\/iso\.segment)$/i;

const pendingRequests = new Map();
const tabGenerations = new Map();
const downloadTasks = new Map();
const downloadQueue = [];
const activeTaskIds = new Set();
let recoveredActiveIds = new Set();
let activeDownloadCount = 0;
let downloadHistory = [];
let startupReconciled = false;
let historyWriteQueue = Promise.resolve();
let queuePersistenceQueue = Promise.resolve();
let streamsByTab = {};
let persistenceQueue = Promise.resolve();
let queueAlarmQueue = Promise.resolve();

const historyReady = restoreDownloadHistory();

async function restoreDownloadHistory() {
  try {
    const stored = await extensionApi.storage.local.get(DOWNLOAD_HISTORY_KEY);
    downloadHistory = Array.isArray(stored[DOWNLOAD_HISTORY_KEY])
      ? stored[DOWNLOAD_HISTORY_KEY].filter((record) => record && typeof record.id === "string")
      : [];
    let interrupted = false;
    downloadHistory = downloadHistory.map((record) => {
      if (!["queued", "downloading", "paused", "cancelling"].includes(record.status)) return record;
      interrupted = true;
      return {
        ...record,
        status: "interrupted",
        error: "The extension restarted before this download finished.",
        updatedAt: Date.now()
      };
    }).slice(0, MAX_HISTORY_ITEMS);
    if (interrupted) await persistDownloadHistory();
  } catch (error) {
    console.warn("LDM: unable to restore download history", error);
  }
}

async function reconcileDownloadHistory() {
  try {
    const response = await fetch("http://127.0.0.1:12345/api/downloads", {
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) return;
    const result = await response.json();
    if (!Array.isArray(result.downloads)) return;
    const jobsById = new Map(result.downloads
      .filter((job) => job && typeof job.id === "string")
      .map((job) => [job.id, job]));
    let changed = false;
    downloadHistory = downloadHistory.map((record) => {
      const job = jobsById.get(record.id);
      if (!job || !["downloading", "paused", "cancelling", "completed", "failed", "cancelled"].includes(job.status)) return record;
      const filename = typeof job.filename === "string" ? safeFilename(job.filename) : "";
      const percent = Number(job.percent_complete);
      const next = {
        ...record,
        status: job.status,
        pausedQueued: false,
        ...(filename ? { filename } : {}),
        phase: typeof job.phase === "string" ? job.phase : "http",
        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
        bytesDownloaded: Number(job.bytes_downloaded) || 0,
        bytesProcessed: Number(job.bytes_processed) || 0,
        totalBytes: Number(job.total_bytes) || 0,
        bytesPerSecond: Number(job.bytes_per_second) || 0,
        error: typeof job.error === "string" ? job.error : "",
        updatedAt: Number(job.updated_at) || Date.now()
      };
      if (job.status === "completed") {
        next.percent = 100;
        next.completedAt = next.updatedAt;
      }
      if (Object.keys(next).some((key) => next[key] !== record[key])) changed = true;
      return next;
    });
    let queueChanged = false;
    for (const task of [...downloadTasks.values()]) {
      if (task.accepted) continue;
      const job = jobsById.get(task.id);
      if (!job || !["downloading", "paused", "cancelling", "completed", "failed", "cancelled"].includes(job.status)) continue;
      task.accepted = true;
      queueChanged = true;
      if (!task.running) {
        const queueIndex = downloadQueue.findIndex((queued) => queued.id === task.id);
        if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
        downloadTasks.delete(task.id);
      }
    }
    if (queueChanged) await persistQueuedDownloads();

    recoveredActiveIds = new Set([...jobsById.values()]
      .filter((job) => ["downloading", "paused", "cancelling"].includes(job.status) && !activeTaskIds.has(job.id))
      .map((job) => job.id));
    activeDownloadCount = activeTaskIds.size + recoveredActiveIds.size;
    if (changed) {
      downloadHistory = downloadHistory.slice(0, MAX_HISTORY_ITEMS);
      await persistDownloadHistory();
    }
    if (startupReconciled && activeDownloadCount < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
      void pumpDownloadQueue();
    }
  } catch (error) {
    console.debug("LDM: could not reconcile history with the local engine", error);
  }
}

function persistDownloadHistory() {
  historyWriteQueue = historyWriteQueue
    .then(() => extensionApi.storage.local.set({ [DOWNLOAD_HISTORY_KEY]: downloadHistory }))
    .catch((error) => console.warn("LDM: unable to persist download history", error));
  return historyWriteQueue;
}

function updateDownloadRecord(id, changes, persist = true) {
  const index = downloadHistory.findIndex((record) => record.id === id);
  if (index < 0) return null;
  downloadHistory[index] = { ...downloadHistory[index], ...changes, updatedAt: Date.now() };
  if (persist) void persistDownloadHistory();
  return downloadHistory[index];
}

async function restoreStreams() {
  if (!sessionStore) {
    return;
  }
  try {
    const stored = await sessionStore.get(STORAGE_KEY);
    const restoredStreams = stored[STORAGE_KEY] ?? {};
    streamsByTab = Object.fromEntries(Object.entries(restoredStreams).map(([tabId, streams]) => [
      tabId,
      Array.isArray(streams)
        ? streams.filter((stream) => isSupportedStream(stream?.url, stream?.contentType, stream))
        : []
    ]));
  } catch (error) {
    console.warn("LDM: unable to restore this-session stream data", error);
  }
}

const streamsReady = restoreStreams();

function persistStreams() {
  if (!sessionStore) {
    return;
  }
  persistenceQueue = persistenceQueue
    .then(() => sessionStore.set({ [STORAGE_KEY]: streamsByTab }))
    .catch((error) => console.warn("LDM: unable to persist this-session stream data", error));
}

function persistQueuedDownloads() {
  if (!sessionStore) return Promise.resolve(true);
  const pending = [...downloadTasks.values()]
    .filter((task) => !task.accepted)
    .map((task) => ({
      id: task.id,
      tabId: task.tabId,
      paused: task.paused === true,
      stream: {
        ...selectionFields(task.stream),
        url: task.stream.url,
        filename: task.stream.filename,
        contentType: task.stream.contentType,
        manifestFormat: task.stream.manifestFormat,
        resolution: task.stream.resolution,
        headers: { ...(task.stream.headers ?? {}) }
      }
    }));
  queuePersistenceQueue = queuePersistenceQueue
    .then(() => sessionStore.set({ [QUEUED_DOWNLOADS_KEY]: pending }).then(() => true))
    .catch((error) => {
      console.warn("LDM: unable to persist the temporary download queue", error);
      return false;
    });
  return queuePersistenceQueue;
}

function updateQueueAlarm() {
  if (!extensionApi.alarms) return Promise.resolve();
  queueAlarmQueue = queueAlarmQueue.then(async () => {
    if (downloadQueue.some((task) => !task.paused) && activeDownloadCount >= MAX_CONCURRENT_DOWNLOADS) {
      const existing = await extensionApi.alarms.get(QUEUE_ALARM_NAME);
      if (!existing) {
        await extensionApi.alarms.create(QUEUE_ALARM_NAME, {
          delayInMinutes: 0.5,
          periodInMinutes: 0.5
        });
      }
    } else {
      await extensionApi.alarms.clear(QUEUE_ALARM_NAME);
    }
  }).catch((error) => {
    console.warn("LDM: unable to schedule the background queue check", error);
  });
  return queueAlarmQueue;
}

async function restoreQueuedDownloads() {
  if (!sessionStore) return;
  try {
    await Promise.all([historyReady, streamsReady]);
    const stored = await sessionStore.get(QUEUED_DOWNLOADS_KEY);
    const restored = Array.isArray(stored[QUEUED_DOWNLOADS_KEY])
      ? stored[QUEUED_DOWNLOADS_KEY]
      : [];
    let historyChanged = false;

    for (const savedTask of restored) {
      if (downloadTasks.size >= MAX_HISTORY_ITEMS) break;
      if (!savedTask || typeof savedTask.id !== "string"
        || !/^[\da-f-]{36}$/i.test(savedTask.id)
        || !Number.isInteger(savedTask.tabId) || savedTask.tabId < 0
        || !savedTask.stream || typeof savedTask.stream.url !== "string") continue;
      let parsedUrl;
      try {
        parsedUrl = new URL(savedTask.stream.url);
      } catch {
        continue;
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") continue;
      if (downloadTasks.has(savedTask.id)) continue;

      const existing = downloadHistory.find((record) => record.id === savedTask.id);
      if (existing && ["completed", "failed", "cancelled"].includes(existing.status)) continue;

      const savedHeaders = savedTask.stream.headers && typeof savedTask.stream.headers === "object"
        ? savedTask.stream.headers
        : {};
      const headers = {};
      for (const name of ["user-agent", "cookie", "referer", "origin"]) {
        if (typeof savedHeaders[name] === "string") headers[name] = savedHeaders[name];
      }
      const stream = {
        url: parsedUrl.href,
        filename: safeFilename(typeof savedTask.stream.filename === "string" ? savedTask.stream.filename : "")
          || "download.bin",
        contentType: typeof savedTask.stream.contentType === "string"
          ? savedTask.stream.contentType
          : "media stream",
        manifestFormat: ["hls", "dash"].includes(savedTask.stream.manifestFormat)
          ? savedTask.stream.manifestFormat
          : "",
        resolution: typeof savedTask.stream.resolution === "string"
          ? savedTask.stream.resolution
          : "Unknown quality",
        headers,
        ...selectionFields(savedTask.stream)
      };
      const task = { id: savedTask.id, tabId: savedTask.tabId, stream, accepted: false, running: false, paused: savedTask.paused === true };
      downloadTasks.set(task.id, task);
      downloadQueue.push(task);

      if (existing) {
        Object.assign(existing, {
          filename: stream.filename,
          contentType: stream.contentType,
          resolution: stream.resolution,
          format: stream.manifestFormat || "direct",
          status: task.paused ? "paused" : "queued",
          pausedQueued: task.paused,
          ...selectionFields(stream),
          position: task.paused ? 0 : downloadQueue.length,
          error: "",
          updatedAt: Date.now()
        });
      } else {
        downloadHistory.unshift({
          id: task.id,
          filename: stream.filename,
          contentType: stream.contentType,
          resolution: stream.resolution,
          format: stream.manifestFormat || "direct",
          status: task.paused ? "paused" : "queued",
          pausedQueued: task.paused,
          ...selectionFields(stream),
          position: task.paused ? 0 : downloadQueue.length,
          percent: null,
          bytesDownloaded: 0,
          bytesProcessed: 0,
          totalBytes: 0,
          bytesPerSecond: 0,
          startedAt: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          error: ""
        });
      }
      historyChanged = true;
    }

    downloadHistory = downloadHistory.slice(0, MAX_HISTORY_ITEMS);
    if (historyChanged) await persistDownloadHistory();
    await persistQueuedDownloads();
  } catch (error) {
    console.warn("LDM: unable to restore the temporary download queue", error);
  }
}

const queueReady = restoreQueuedDownloads();
const startupReady = Promise.all([historyReady, streamsReady, queueReady])
  .then(async () => {
    await reconcileDownloadHistory();
    activeDownloadCount = activeTaskIds.size + recoveredActiveIds.size;
    startupReconciled = true;
    await pumpDownloadQueue();
  });

function urlLooksLikeMedia(url) {
  return MEDIA_EXTENSION_PATTERN.test(url);
}

function normalizedMime(contentType = "") {
  return typeof contentType === "string" ? contentType.split(";")[0].trim().toLowerCase() : "";
}

function isHttpUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isGenericMime(contentType) {
  return ["", "unknown", "application/octet-stream", "binary/octet-stream", "application/binary",
    "application/download", "application/x-download", "application/force-download"].includes(contentType);
}

function isSupportedStream(url, contentType = "", evidence = {}) {
  if (!isHttpUrl(url)) return false;
  const mime = normalizedMime(contentType);
  if (MEDIA_SEGMENT_PATTERN.test(url) || MEDIA_SEGMENT_MIME_PATTERN.test(mime)
    || (typeof evidence.filename === "string" && MEDIA_SEGMENT_PATTERN.test(evidence.filename))) return false;
  if (MEDIA_MIME_PATTERN.test(mime)) return true;
  if (mime === "text/plain" && (manifestFormat(url) || manifestFormat(evidence.filename ?? ""))) return true;
  if (!isGenericMime(mime)) return false;
  const mediaFilename = typeof evidence.filename === "string"
    && urlLooksLikeMedia(evidence.filename) && !MEDIA_SEGMENT_PATTERN.test(evidence.filename);
  return urlLooksLikeMedia(url) || mediaFilename || evidence.detectionEvidence === "media-request"
    || (evidence.detectionEvidence === "native-media" && ["video", "audio"].includes(evidence.mediaKind));
}

function manifestFormat(url, contentType = "") {
  contentType = normalizedMime(contentType);
  if (/\.mpd(?:$|[?#])/i.test(url) || /^application\/dash\+xml$/i.test(contentType)) return "dash";
  if (/\.m3u8(?:$|[?#])/i.test(url)
    || /^application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/i.test(contentType)) return "hls";
  return "";
}

function isCandidateRequest(details) {
  return details.tabId >= 0
    && isHttpUrl(details.url)
    && (details.type === "media" || details.type === "xmlhttprequest"
      || details.type === "other" || urlLooksLikeMedia(details.url));
}

function headerMap(headers = []) {
  const captured = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    if (name === "user-agent" || name === "cookie" || name === "referer" || name === "origin") {
      captured[name] = header.value ?? "";
    }
  }
  return captured;
}

function responseValue(headers = [], name) {
  const header = headers.find((entry) => entry.name.toLowerCase() === name);
  return header?.value ?? "";
}

function filenameFromDisposition(value) {
  if (!value) return "";
  const extended = value.match(/(?:^|;)\s*filename\*\s*=\s*([^;]+)/i);
  let filename = "";
  if (extended) {
    const encoded = extended[1].trim().replace(/^"|"$/g, "");
    const separator = encoded.indexOf("''");
    const raw = separator >= 0 ? encoded.slice(separator + 2) : encoded;
    try {
      filename = decodeURIComponent(raw);
    } catch {
      filename = raw;
    }
  } else {
    const basic = value.match(/(?:^|;)\s*filename\s*=\s*(?:"((?:\\.|[^"])*)"|([^;]*))/i);
    filename = basic ? (basic[1] ?? basic[2] ?? "").replace(/\\(.)/g, "$1").trim() : "";
  }
  return safeFilename(filename);
}

function safeFilename(value) {
  const cleaned = value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "";
}

function filenameFromUrl(url) {
  try {
    const filename = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    return safeFilename(filename);
  } catch {
    return "";
  }
}

function resolutionFrom(url, responseHeaders) {
  const text = `${url} ${responseValue(responseHeaders, "x-video-resolution")} `
    + `${responseValue(responseHeaders, "x-video-height")} `
    + `${responseValue(responseHeaders, "content-disposition")}`;
  const heightMatch = text.match(/(?:height[=:/_-]?|[x/_-])?(2160|1440|1080|720|576|480|360|240)p?/i);
  const height = Number(heightMatch?.[1] ?? 0);
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 576) return "576p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  if (height >= 240) return "240p";

  try {
    const parsed = new URL(url);
    const hinted = parsed.searchParams.get("quality")
      ?? parsed.searchParams.get("quality_label")
      ?? parsed.searchParams.get("height");
    if (hinted) {
      const quality = hinted.match(/(2160|1440|1080|720|576|480|360|240)/);
      const value = Number(quality?.[1] ?? 0);
      if (value >= 2160) return "4K";
      if (value >= 1440) return "1440p";
      if (value >= 1080) return "1080p";
      if (value >= 720) return "720p";
      if (value >= 576) return "576p";
      if (value >= 480) return "480p";
      if (value >= 360) return "360p";
      if (value >= 240) return "240p";
    }
  } catch {
    return "Unknown quality";
  }
  return "Unknown quality";
}

function sameDocumentUrl(first, second) {
  try {
    const firstUrl = new URL(first);
    const secondUrl = new URL(second);
    firstUrl.hash = "";
    secondUrl.hash = "";
    return firstUrl.href === secondUrl.href;
  } catch {
    return false;
  }
}

function streamWithCurrentHeaders(stream, tabId) {
  const current = streamsByTab[String(tabId)]?.find((item) => item.url === stream.url);
  // A visible card can predate the network response that supplied cookies.
  return { ...stream, headers: { ...stream.headers, ...current?.headers } };
}

async function prepareStreamRequest(stream, tabId) {
  await streamsReady;
  const selected = streamWithCurrentHeaders(stream, tabId);
  if (!selected.headers.cookie && extensionApi.cookies?.getAll && Number.isInteger(tabId)) {
    try {
      const tab = await extensionApi.tabs.get(tabId);
      let storeId = tab.cookieStoreId;
      if (!storeId && extensionApi.cookies.getAllCookieStores) {
        const stores = await extensionApi.cookies.getAllCookieStores();
        storeId = stores.find((store) => store.tabIds.includes(tabId))?.id;
      }
      // Only query the selected URL and tab's store. Partitioned authentication
      // continues to use observed request headers, never another site's partition.
      if (storeId) {
        const cookies = await extensionApi.cookies.getAll({ url: selected.url, storeId });
        const value = cookies.filter((cookie) => !cookie.partitionKey && !cookie.firstPartyDomain)
          .map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        if (value) selected.headers.cookie = value;
      }
    } catch (error) {
      console.debug("LDM: selected media cookie lookup unavailable", error);
    }
  }
  return selected;
}

function messageTabId(message, sender) {
  const extensionRoot = extensionApi.runtime.getURL?.("");
  if (extensionRoot && sender.url?.startsWith(extensionRoot)) return message.tabId;
  return sender.tab?.id ?? message.tabId;
}

async function notifyStreamsChanged(tabId, generation) {
  if ((tabGenerations.get(tabId) ?? 0) !== generation) return;
  const count = streamsByTab[String(tabId)]?.length ?? 0;
  await extensionApi.action.setBadgeText({ tabId, text: count ? String(count) : "" });
  if (count) await extensionApi.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  if ((tabGenerations.get(tabId) ?? 0) !== generation) return;
  try {
    await extensionApi.tabs.sendMessage(tabId, { type: "ldm:streams-changed", count });
  } catch {
    // Pages without a content script still have their stream list in the popup.
  }
}

function upsertStream(tabId, incoming) {
  const tabKey = String(tabId);
  const streams = Array.isArray(streamsByTab[tabKey]) ? streamsByTab[tabKey] : [];
  const existingIndex = streams.findIndex((item) => item.url === incoming.url);
  const existing = existingIndex >= 0 ? streams[existingIndex] : null;
  let stream = incoming;
  if (existing) {
    const network = incoming.detectionSource === "network" ? incoming
      : existing.detectionSource === "network" ? existing : null;
    stream = { ...existing, ...incoming, headers: { ...existing.headers, ...incoming.headers } };
    if (network) {
      const dom = network === incoming ? existing : incoming;
      stream = { ...dom, ...network, lastSeen: incoming.lastSeen,
        headers: { ...dom.headers, ...network.headers } };
      if (isGenericMime(normalizedMime(network.contentType))
        && MEDIA_MIME_PATTERN.test(normalizedMime(dom.contentType))) stream.contentType = dom.contentType;
      if (!network.manifestFormat && dom.manifestFormat) stream.manifestFormat = dom.manifestFormat;
      if (!network.mediaKind && dom.mediaKind) stream.mediaKind = dom.mediaKind;
    }
    // A native player's loaded dimensions are stronger than a URL's quality hint.
    const dimensions = incoming.height ? incoming : existing.height ? existing : null;
    if (dimensions) {
      stream.width = dimensions.width;
      stream.height = dimensions.height;
      stream.resolution = `${dimensions.height}p`;
    }
    streams[existingIndex] = stream;
  } else {
    streams.unshift(stream);
  }
  streamsByTab[tabKey] = streams.slice(0, MAX_STREAMS_PER_TAB);
  persistStreams();
  const metadata = (value) => value && Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "lastSeen"));
  return JSON.stringify(metadata(existing)) !== JSON.stringify(metadata(stream));
}

async function storeStream(details, responseHeaders = []) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
  // Completion may remove this request while session storage is still loading.
  const request = pendingRequests.get(details.requestId);
  const generation = request?.generation ?? (tabGenerations.get(details.tabId) ?? 0);
  const streamHeaders = { ...(request?.headers ?? {}) };
  const method = details.method ?? request?.method ?? "GET";
  if (method.toUpperCase() !== "GET") return;
  if (typeof details.statusCode === "number"
    && (details.statusCode < 200 || details.statusCode >= 300)) return;
  const contentType = normalizedMime(responseValue(responseHeaders, "content-type"));
  const disposition = responseValue(responseHeaders, "content-disposition");
  const dispositionFilename = filenameFromDisposition(disposition);
  const evidence = {
    filename: dispositionFilename,
    detectionEvidence: (details.type ?? request?.type) === "media" ? "media-request" : "response"
  };
  if (!isSupportedStream(details.url, contentType, evidence)) return;
  const filename = dispositionFilename
    || filenameFromUrl(details.url)
    || "download.bin";
  const stream = {
    url: details.url,
    filename,
    contentType: contentType || "unknown",
    manifestFormat: manifestFormat(details.url, contentType) || manifestFormat(dispositionFilename),
    resolution: resolutionFrom(details.url, responseHeaders),
    headers: streamHeaders,
    detectionSource: "network",
    detectionEvidence: evidence.detectionEvidence,
    ...(/^(video|audio)\//.test(contentType) ? { mediaKind: contentType.split("/")[0] } : {}),
    lastSeen: Date.now()
  };
  await streamsReady;
  if (generation !== (tabGenerations.get(details.tabId) ?? 0)) return;
  if (upsertStream(details.tabId, stream)) await notifyStreamsChanged(details.tabId, generation);
}

async function storeDomSources(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0) return { count: 0 };
  const generation = tabGenerations.get(tabId) ?? 0;
  if ((sender.frameId === 0 || sender.frameId === undefined) && sender.tab.url && sender.url
    && !sameDocumentUrl(sender.tab.url, sender.url)) return { count: 0 };
  const sources = Array.isArray(message.sources) ? message.sources.slice(0, MAX_DOM_SOURCES_PER_BATCH) : [];
  const referer = isHttpUrl(sender.url) ? sender.url : "";
  const accepted = sources.flatMap((source) => {
    if (!source || !["video", "audio"].includes(source.mediaKind)) return [];
    const contentType = normalizedMime(source.contentType);
    const evidence = { detectionEvidence: "native-media", mediaKind: source.mediaKind };
    if (!isSupportedStream(source.url, contentType, evidence)) return [];
    const height = source.mediaKind === "video" && Number.isInteger(source.height)
      && source.height > 0 && source.height <= 32768 ? source.height : 0;
    const width = Number.isInteger(source.width) && source.width > 0 && source.width <= 32768
      ? source.width : 0;
    return [{
      url: source.url,
      filename: filenameFromUrl(source.url) || (source.mediaKind === "audio" ? "audio" : "video"),
      contentType: contentType || "unknown",
      manifestFormat: manifestFormat(source.url, contentType),
      resolution: height ? `${height}p` : resolutionFrom(source.url, []),
      ...(height ? { width, height } : {}),
      headers: referer ? { referer } : {},
      detectionSource: "dom",
      ...evidence,
      lastSeen: Date.now()
    }];
  });
  await streamsReady;
  if (generation !== (tabGenerations.get(tabId) ?? 0)) return { count: streamsByTab[String(tabId)]?.length ?? 0 };
  let changed = false;
  for (const stream of accepted) {
    if (upsertStream(tabId, stream)) changed = true;
  }
  if (changed) await notifyStreamsChanged(tabId, generation);
  return { count: streamsByTab[String(tabId)]?.length ?? 0 };
}

function rememberRequest(details) {
  if (!isCandidateRequest(details)) return;
  if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
    const oldest = pendingRequests.keys().next().value;
    if (oldest !== undefined) pendingRequests.delete(oldest);
  }
  pendingRequests.set(details.requestId, {
    tabId: details.tabId,
    url: details.url,
    type: details.type,
    method: details.method ?? "GET",
    generation: tabGenerations.get(details.tabId) ?? 0,
    headers: {}
  });
}

function clearStreamsForNavigation(details) {
  if (details.tabId < 0) return;
  const generation = (tabGenerations.get(details.tabId) ?? 0) + 1;
  tabGenerations.set(details.tabId, generation);
  void streamsReady.then(async () => {
    if (tabGenerations.get(details.tabId) !== generation) return;
    delete streamsByTab[String(details.tabId)];
    persistStreams();
    await notifyStreamsChanged(details.tabId, generation);
  }).catch((error) => {
    console.warn("LDM: unable to clear streams after navigation", error);
  });
}

extensionApi.webRequest.onBeforeRequest.addListener(
  clearStreamsForNavigation,
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

extensionApi.webRequest.onBeforeRequest.addListener(
  rememberRequest,
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

function addHeaderListener(event, listener, filter, headerOption) {
  try {
    event.addListener(listener, filter, [headerOption, "extraHeaders"]);
  } catch {
    // Firefox exposes the normal header options without Chrome's extraHeaders option.
    event.addListener(listener, filter, [headerOption]);
  }
}

addHeaderListener(
  extensionApi.webRequest.onBeforeSendHeaders,
  (details) => {
    const request = pendingRequests.get(details.requestId);
    if (request) request.headers = headerMap(details.requestHeaders);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  "requestHeaders"
);

addHeaderListener(
  extensionApi.webRequest.onHeadersReceived,
  (details) => {
    void storeStream(details, details.responseHeaders).catch((error) => {
      console.warn("LDM: unable to store detected stream", error);
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  "responseHeaders"
);

function forgetRequest(details) {
  pendingRequests.delete(details.requestId);
}

extensionApi.webRequest.onCompleted.addListener(forgetRequest, { urls: ["<all_urls>"] });
extensionApi.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ["<all_urls>"] });

extensionApi.tabs.onRemoved.addListener((tabId) => {
  tabGenerations.delete(tabId);
  void streamsReady.then(() => {
    delete streamsByTab[String(tabId)];
    persistStreams();
  });
});

if (extensionApi.alarms?.onAlarm) {
  extensionApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== QUEUE_ALARM_NAME) return;
    void startupReady.then(async () => {
      await reconcileDownloadHistory();
      await pumpDownloadQueue();
    }).catch((error) => {
      console.warn("LDM: background queue check failed", error);
    });
  });
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ldm:media-sources") {
    void storeDomSources(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ error: error.message, count: 0 });
    });
    return true;
  }
  if (message?.type === "ldm:get-streams") {
    const tabId = messageTabId(message, sender);
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ error: "Could not identify the current browser tab.", streams: [] });
      return false;
    }
    void streamsReady.then(() => {
      sendResponse({ streams: streamsByTab[String(tabId)] ?? [] });
    }).catch((error) => {
      sendResponse({ error: error.message, streams: [] });
    });
    return true;
  }
  if (message?.type === "ldm:get-download-history") {
    void startupReady.then(() => sendResponse({ records: downloadHistory }));
    return true;
  }
  if (message?.type === "ldm:sync-download-history") {
    void startupReady.then(reconcileDownloadHistory)
      .then(() => sendResponse({ records: downloadHistory }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "ldm:clear-download-history") {
    void startupReady.then(async () => {
      const before = downloadHistory.length;
      downloadHistory = downloadHistory.filter((record) =>
        ["queued", "downloading", "paused", "cancelling"].includes(record.status));
      await persistDownloadHistory();
      sendResponse({ cleared: before - downloadHistory.length });
    }).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "ldm:inspect-stream") {
    const stream = message.stream;
    if (!stream || !isHttpUrl(stream.url) || !["hls", "dash"].includes(stream.manifestFormat)) {
      sendResponse({ error: "Select a valid HLS or DASH playlist." });
      return false;
    }
    const tabId = messageTabId(message, sender);
    void prepareStreamRequest(stream, tabId).then(inspectStream)
      .then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (["ldm:pause-download", "ldm:resume-download"].includes(message?.type)) {
    if (typeof message.id !== "string" || !message.id.length || message.id.length > 128) {
      sendResponse({ error: "Invalid download id." });
      return false;
    }
    void controlDownloadTask(message.id, message.type === "ldm:pause-download" ? "pause" : "resume")
      .then(sendResponse).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message?.type === "ldm:cancel-download") {
    const id = message.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) {
      sendResponse({ error: "Invalid download id." });
      return false;
    }
    void cancelDownloadTask(id).then(sendResponse).catch((error) => {
      sendResponse({ error: error.message || "Could not cancel this download." });
    });
    return true;
  }
  if (message?.type !== "ldm:download-stream") return false;

  const tabId = messageTabId(message, sender);
  const stream = message.stream;
  if (!Number.isInteger(tabId) || tabId < 0 || !stream || typeof stream.url !== "string") {
    sendResponse({ error: "Invalid download request." });
    return false;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(stream.url);
  } catch {
    sendResponse({ error: "The selected media URL is invalid." });
    return false;
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    sendResponse({ error: "Only HTTP and HTTPS media URLs can be sent to LDM." });
    return false;
  }

  const requestedId = message.id;
  const downloadId = typeof requestedId === "string" && /^[\da-f-]{36}$/i.test(requestedId)
    ? requestedId
    : globalThis.crypto.randomUUID();
  void startupReady.then(async () => {
    const selected = await prepareStreamRequest(stream, tabId);
    if (downloadTasks.size >= MAX_HISTORY_ITEMS) {
      sendResponse({ error: "The download queue is full. Wait for a transfer to finish, then try again." });
      return;
    }
    if (downloadTasks.has(downloadId)) {
      sendResponse({ error: "This download request is already queued." });
      return;
    }
    const position = activeDownloadCount + downloadQueue.length + 1;
    const task = { id: downloadId, tabId,
      stream: { ...selected, ...selectionFields(stream) }, accepted: false, running: false };
    downloadTasks.set(downloadId, task);
    downloadQueue.push(task);
    downloadHistory.unshift({
      id: downloadId,
      filename: typeof stream.filename === "string" ? stream.filename : "download.bin",
      contentType: typeof stream.contentType === "string" ? stream.contentType : "media stream",
      resolution: typeof stream.resolution === "string" ? stream.resolution : "Unknown quality",
      format: typeof stream.manifestFormat === "string" ? stream.manifestFormat : "direct",
      status: "queued",
      ...selectionFields(stream),
      position,
      percent: null,
      bytesDownloaded: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      startedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: ""
    });
    downloadHistory = downloadHistory.slice(0, MAX_HISTORY_ITEMS);
    await persistDownloadHistory();
    const queueSaved = await persistQueuedDownloads();
    if (!queueSaved) {
      downloadTasks.delete(downloadId);
      const queueIndex = downloadQueue.findIndex((queued) => queued.id === downloadId);
      if (queueIndex >= 0) downloadQueue.splice(queueIndex, 1);
      downloadHistory = downloadHistory.filter((record) => record.id !== downloadId);
      await persistDownloadHistory();
      sendResponse({ error: "Browser session storage could not save the queued download." });
      return;
    }
    sendResponse({ accepted: true, id: downloadId, position });
    void pumpDownloadQueue();
  }).catch((error) => sendResponse({ error: error.message || "Could not queue download." }));
  return true;
});

async function sendDownloadEvent(tabId, id, event) {
  const message = { type: "ldm:download-event", id, event };
  await Promise.allSettled([
    extensionApi.tabs.sendMessage(tabId, message),
    extensionApi.runtime.sendMessage(message)
  ]);
}

function selectionFields(stream = {}) {
  const result = {};
  for (const key of ["video_stream_index", "audio_stream_index"]) {
    if (Number.isInteger(stream[key]) && stream[key] >= 0) result[key] = stream[key];
  }
  if (stream.audio_only === true) result.audio_only = true;
  if (["mp4", "mkv", "m4a", "mp3", "opus"].includes(stream.output_format)) result.output_format = stream.output_format;
  return result;
}

async function engineRequest(path, body) {
  const response = await fetch(`http://127.0.0.1:12345${path}`, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body), cache: "no-store", credentials: "omit"
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `LDM returned HTTP ${response.status}`);
  return result;
}

async function inspectStream(stream) {
  return engineRequest("/api/inspect", {
    url: stream.url, manifest_format: stream.manifestFormat,
    headers: stream.headers && typeof stream.headers === "object" ? stream.headers : {}
  });
}

async function controlDownloadTask(id, action) {
  await startupReady;
  const task = downloadTasks.get(id);
  const record = downloadHistory.find((item) => item.id === id);
  if (!record || !["queued", "downloading", "paused"].includes(record.status)) {
    throw new Error("This download cannot be paused or resumed now.");
  }
  if (task && !task.running && !task.accepted) {
    task.paused = action === "pause";
    updateDownloadRecord(id, { status: task.paused ? "paused" : "queued", pausedQueued: task.paused, position: 0, error: "" });
    await persistQueuedDownloads();
    await persistDownloadHistory();
    await sendDownloadEvent(task.tabId, id, { event: task.paused ? "paused" : "queued" });
    void pumpDownloadQueue();
    return { status: task.paused ? "paused" : "queued", queued: true };
  }
  if (task?.running && !task.accepted) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && downloadTasks.has(id) && !task.accepted) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (!task.accepted) throw new Error("LDM is preparing this transfer. Try again shortly.");
  }
  const result = await engineRequest(`/api/${action}`, { id });
  const latest = downloadHistory.find((item) => item.id === id);
  if (latest && !["queued", "downloading", "paused"].includes(latest.status)) return { ...result, status: latest.status };
  const status = action === "pause" ? "paused" : "downloading";
  updateDownloadRecord(id, { status, pausedQueued: false, error: "" });
  await persistDownloadHistory();
  if (task) await sendDownloadEvent(task.tabId, id, { event: action === "pause" ? "paused" : "resumed" });
  return { ...result, status };
}

async function cancelDownloadTask(id) {
  await startupReady;
  const task = downloadTasks.get(id);
  let record = downloadHistory.find((item) => item.id === id);

  if (task && !task.running) {
    const queueIndex = downloadQueue.findIndex((queued) => queued.id === id);
    if (queueIndex >= 0) {
      downloadQueue.splice(queueIndex, 1);
      downloadTasks.delete(id);
      updateDownloadRecord(id, { status: "cancelled", position: 0, error: "" });
      await persistDownloadHistory();
      await persistQueuedDownloads();
      await sendDownloadEvent(task.tabId, id, { event: "cancelled", id });
      void pumpDownloadQueue();
      return { cancelled: true, queued: true };
    }
  }

  if (task?.cancelRequested) return { cancelled: true, status: "cancelling" };
  if (record && !["queued", "downloading", "paused", "cancelling"].includes(record.status)) {
    return { error: "This download is already finished." };
  }

  const previousStatus = record?.status || "downloading";
  if (record) {
    updateDownloadRecord(id, { status: "cancelling", error: "" });
    await persistDownloadHistory();
  }
  if (task) task.cancelRequested = true;

  try {
    if (task?.running && !task.accepted) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && downloadTasks.has(id) && !task.accepted) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!task.accepted && downloadTasks.has(id)) {
        throw new Error("LDM has not accepted this transfer yet. Try cancelling again shortly.");
      }
    }

    const response = await fetch("http://127.0.0.1:12345/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ id }),
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) {
      let detail = `LDM returned HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail = body.error || detail;
      } catch {
        // Preserve the status for non-JSON error responses.
      }
      await reconcileDownloadHistory();
      throw new Error(detail);
    }
    if (task) await sendDownloadEvent(task.tabId, id, { event: "cancelling", id });
    return { cancelled: true, status: "cancelling" };
  } catch (error) {
    if (task) task.cancelRequested = false;
    record = downloadHistory.find((item) => item.id === id);
    if (record?.status === "cancelling") {
      updateDownloadRecord(id, {
        status: previousStatus,
        error: error.message || "Could not cancel this download."
      });
      await persistDownloadHistory();
    }
    return { error: error.message || "Could not cancel this download." };
  }
}

async function pumpDownloadQueue() {
  while (activeDownloadCount < MAX_CONCURRENT_DOWNLOADS && downloadQueue.some((task) => !task.paused)) {
    const index = downloadQueue.findIndex((task) => !task.paused);
    const [task] = downloadQueue.splice(index, 1);
    if (!downloadTasks.has(task.id)) continue;
    task.running = true;
    activeTaskIds.add(task.id);
    activeDownloadCount = activeTaskIds.size + recoveredActiveIds.size;
    updateDownloadRecord(task.id, {
      status: "downloading",
      position: 0,
      startedAt: Date.now(),
      error: ""
    });
    void sendDownloadEvent(task.tabId, task.id, { event: "started" });
    void runDownloadTask(task);
  }
  let position = activeDownloadCount;
  for (const task of downloadQueue) {
    if (task.paused) continue;
    position += 1;
    updateDownloadRecord(task.id, { position }, false);
    void sendDownloadEvent(task.tabId, task.id, { event: "queued", position });
  }
  if (downloadQueue.length > 0) void persistDownloadHistory();
  await persistQueuedDownloads();
  await updateQueueAlarm();
}

async function runDownloadTask(task) {
  try {
    await proxyDownloadToLdm(task);
  } finally {
    activeTaskIds.delete(task.id);
    activeDownloadCount = activeTaskIds.size + recoveredActiveIds.size;
    downloadTasks.delete(task.id);
    await persistQueuedDownloads();
    void pumpDownloadQueue();
  }
}

function applyDownloadEvent(id, event) {
  if (event.event === "progress") {
    const percent = Number(event.percent_complete);
    const outputFilename = typeof event.output_filename === "string"
      ? safeFilename(event.output_filename)
      : "";
    updateDownloadRecord(id, {
      status: ["paused", "cancelling"].includes(downloadHistory.find((record) => record.id === id)?.status)
        ? downloadHistory.find((record) => record.id === id).status : "downloading",
      ...(outputFilename ? { filename: outputFilename } : {}),
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
      phase: typeof event.phase === "string" ? event.phase : "http",
      bytesDownloaded: Number(event.bytes_downloaded) || 0,
      bytesProcessed: Number(event.bytes_processed) || 0,
      totalBytes: Number(event.total_bytes) || 0,
      bytesPerSecond: Number(event.bytes_per_second) || 0,
      error: ""
    }, false);
    void persistDownloadHistory();
  } else if (event.event === "paused" || event.event === "resumed") {
    updateDownloadRecord(id, { status: event.event === "paused" ? "paused" : "downloading", error: "" });
  } else if (event.event === "completed") {
    updateDownloadRecord(id, {
      status: "completed",
      percent: 100,
      completedAt: Date.now(),
      position: 0,
      error: ""
    });
  } else if (event.event === "cancelling") {
    updateDownloadRecord(id, { status: "cancelling", position: 0, error: "" });
  } else if (event.event === "cancelled") {
    updateDownloadRecord(id, { status: "cancelled", position: 0, error: "" });
  } else if (event.event === "error") {
    updateDownloadRecord(id, {
      status: "failed",
      position: 0,
      error: event.error || "Download failed."
    });
  }
}

async function proxyDownloadToLdm(task) {
  const { tabId, stream } = task;
  const id = task.id;
  const payload = {
    id,
    url: stream.url,
    output_path: typeof stream.filename === "string" ? stream.filename : "download.bin",
    manifest_format: typeof stream.manifestFormat === "string" ? stream.manifestFormat : "",
    max_connections: 8,
    ...selectionFields(stream),
    headers: stream.headers && typeof stream.headers === "object" ? stream.headers : {}
  };

  try {
    const response = await fetch("http://127.0.0.1:12345/download", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "omit"
    });
    if (!response.ok) {
      let detail = `LDM returned HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail = body.error || detail;
      } catch {
        // Preserve the status text for non-JSON error responses.
      }
      if (response.status === 409 && detail === "A download with this id is already tracked") {
        await reconcileDownloadHistory();
        task.accepted = true;
        await persistQueuedDownloads();
        return;
      }
      throw new Error(detail);
    }
    task.accepted = true;
    await persistQueuedDownloads();
    if (!response.body) throw new Error("LDM response did not include a progress stream.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let completed = false;
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        applyDownloadEvent(id, event);
        await sendDownloadEvent(tabId, id, event);
        if (event.event === "completed") completed = true;
        if (event.event === "error" || event.event === "cancelled") return;
      }
      if (done) break;
    }
    if (pending.trim()) {
      const event = JSON.parse(pending);
      applyDownloadEvent(id, event);
      await sendDownloadEvent(tabId, id, event);
      if (event.event === "completed") completed = true;
      if (event.event === "error" || event.event === "cancelled") return;
    }
    if (!completed) throw new Error("LDM closed the progress stream before completion.");
  } catch (error) {
    const event = {
      event: "error",
      error: error.message || "Could not connect to the local LDM service."
    };
    applyDownloadEvent(id, event);
    await sendDownloadEvent(tabId, id, event);
  }
}
