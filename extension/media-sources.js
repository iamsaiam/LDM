(() => {
  const MAX_SOURCES = 32;
  const SEGMENT_PATH = /\.(?:ts|m4s)$/i;
  const SEGMENT_TYPE = /^(?:video|audio|application)\/(?:mp2t|iso\.segment)$/;
  const PLAYLIST_TYPES = new Set([
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "application/mpegurl",
    "application/dash+xml"
  ]);

  function mediaUrl(value, base) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), base);
      if (!["http:", "https:"].includes(url.protocol) || SEGMENT_PATH.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function mediaType(value) {
    const type = typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
    if (SEGMENT_TYPE.test(type)) return null;
    if (!type || type === "application/octet-stream" || /^(?:video|audio)\/[\w.+-]+$/.test(type)
        || PLAYLIST_TYPES.has(type)) return type;
    return null;
  }

  function dimension(value) {
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  }

  function collect(root = globalThis.document) {
    if (typeof root?.querySelectorAll !== "function") return [];
    const selected = [];
    const alternatives = [];
    for (const media of root.querySelectorAll("video, audio")) {
      const mediaKind = String(media.localName || media.tagName || "").toLowerCase();
      if (mediaKind !== "video" && mediaKind !== "audio") continue;
      const base = media.baseURI || root.baseURI;
      const src = mediaUrl(media.src || media.getAttribute?.("src"), base);
      const currentSrc = typeof media.currentSrc === "string" ? media.currentSrc.trim() : "";
      const selectedUrl = currentSrc ? mediaUrl(currentSrc, base) : src;
      const sources = Array.from(media.querySelectorAll?.("source[src]") || [], (source) => ({
        url: mediaUrl(source.getAttribute?.("src") || source.src, base),
        contentType: mediaType(source.type || source.getAttribute?.("type"))
      }));
      const defaultType = mediaType(media.type || media.getAttribute?.("type"));
      const selectedSource = sources.find((source) => source.url === selectedUrl);
      const record = (url, contentType, isSelected = false) => ({
        url,
        contentType,
        mediaKind,
        width: isSelected && mediaKind === "video" ? dimension(media.videoWidth) : 0,
        height: isSelected && mediaKind === "video" ? dimension(media.videoHeight) : 0
      });
      if (selectedUrl) selected.push(record(selectedUrl,
        selectedSource ? selectedSource.contentType : defaultType, true));
      if (src && src !== selectedUrl) alternatives.push(record(src, defaultType));
      for (const source of sources) {
        if (source.url) alternatives.push(record(source.url, source.contentType));
      }
    }

    const records = new Map();
    for (const candidate of [...selected, ...alternatives]) {
      if (!candidate.url || candidate.contentType === null) continue;
      const existing = records.get(candidate.url);
      if (existing) {
        if (!existing.contentType && candidate.contentType) existing.contentType = candidate.contentType;
        if (existing.mediaKind === candidate.mediaKind && !existing.width && !existing.height) {
          existing.width = candidate.width;
          existing.height = candidate.height;
        }
        continue;
      }
      if (records.size < MAX_SOURCES) records.set(candidate.url, candidate);
    }
    return Array.from(records.values());
  }

  globalThis.LdmMediaSources = Object.freeze({ collect });
})();
