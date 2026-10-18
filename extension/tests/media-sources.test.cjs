const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "media-sources.js"), "utf8"), context);
const collect = (root) => JSON.parse(JSON.stringify(context.LdmMediaSources.collect(root)));

function source(src, type = "") {
  return { type, getAttribute: (name) => ({ src, type })[name] || null };
}

function media(options = {}) {
  const { kind = "video", sources = [], ...properties } = options;
  return {
    localName: kind,
    src: "",
    currentSrc: "",
    baseURI: "https://media.example.test/watch/",
    videoWidth: 0,
    videoHeight: 0,
    querySelectorAll(selector) {
      assert.equal(selector, "source[src]");
      return sources;
    },
    getAttribute() { return null; },
    ...properties
  };
}

function root(...nodes) {
  return {
    baseURI: "https://page.example.test/player/",
    querySelectorAll(selector) {
      assert.equal(selector, "video, audio");
      return nodes;
    }
  };
}

test("collects opaque and relative native video/audio sources with normalized MIME", () => {
  const result = collect(root(
    media({ currentSrc: "../opaque?id=42", videoWidth: 1920, videoHeight: 1080,
      sources: [source("../opaque?id=42", 'Video/MP4; codecs="avc1"'), source("low.webm", "video/webm")] }),
    media({ kind: "audio", src: "/music/track", type: "Audio/MPEG; charset=binary", videoWidth: 999, videoHeight: 999 }),
    media({ src: "relative", baseURI: "" })
  ));
  assert.deepEqual(result, [
    { url: "https://media.example.test/opaque?id=42", contentType: "video/mp4", mediaKind: "video", width: 1920, height: 1080 },
    { url: "https://media.example.test/music/track", contentType: "audio/mpeg", mediaKind: "audio", width: 0, height: 0 },
    { url: "https://page.example.test/player/relative", contentType: "", mediaKind: "video", width: 0, height: 0 },
    { url: "https://media.example.test/watch/low.webm", contentType: "video/webm", mediaKind: "video", width: 0, height: 0 }
  ]);
});

test("only the selected rendition receives measured video dimensions", () => {
  const result = collect(root(media({
    currentSrc: "high.mp4", src: "fallback.mp4", videoWidth: 3840, videoHeight: 2160,
    sources: [source("low.mp4", "video/mp4"), source("high.mp4", "video/mp4")]
  })));
  assert.deepEqual(result.map(({ url, width, height }) => [url.split("/").at(-1), width, height]), [
    ["high.mp4", 3840, 2160], ["fallback.mp4", 0, 0], ["low.mp4", 0, 0]
  ]);
  const blobSelection = collect(root(media({ currentSrc: "blob:https://media.example.test/id", src: "fallback.mp4", videoWidth: 1280, videoHeight: 720 })));
  assert.equal(blobSelection[0].width, 0);
  assert.equal(blobSelection[0].height, 0);
});

test("deduplicates URLs while preserving selected priority and useful MIME", () => {
  const result = collect(root(
    media({ currentSrc: "shared", sources: [source("shared"), source("other", "video/webm")] }),
    media({ currentSrc: "shared", videoWidth: 640, videoHeight: 360, sources: [source("shared", "video/mp4")] })
  ));
  assert.equal(result.length, 2);
  assert.equal(result[0].url, "https://media.example.test/watch/shared");
  assert.equal(result[0].contentType, "video/mp4");
  assert.equal(result[0].width, 640);
  assert.equal(result[0].height, 360);
});

test("rejects unsupported schemes, segment paths and explicit nonmedia or segment MIME", () => {
  const blocked = ["blob:https://example.test/id", "data:video/mp4;base64,AAAA", "file:///tmp/video.mp4", "javascript:alert(1)", "ftp://example.test/video.mp4", "https://[invalid", "clip.ts?token=1", "clip.M4S#fragment"];
  const result = collect(root(media({ sources: [
    ...blocked.map((url) => source(url, "video/mp4")),
    source("transport", "video/mp2t"), source("fragment", "audio/iso.segment"),
    source("other-fragment", "application/mp2t"), source("page", "text/html"),
    source("app", "application/json"), source("playlist", " Application/Vnd.Apple.MpegURL ; codecs=anything"),
    source("dash", "application/dash+xml"), source("binary", "application/octet-stream")
  ] })));
  assert.deepEqual(result.map(({ contentType }) => contentType), [
    "application/vnd.apple.mpegurl", "application/dash+xml", "application/octet-stream"
  ]);
});

test("caps batches at 32 URLs and prioritizes native selections over alternatives", () => {
  const result = collect(root(
    media({ src: "selected-first", sources: Array.from({ length: 45 }, (_, index) => source(`variant-${index}.mp4`)) }),
    media({ currentSrc: "selected-last" })
  ));
  assert.equal(result.length, 32);
  assert.equal(result[0].url, "https://media.example.test/watch/selected-first");
  assert.equal(result[1].url, "https://media.example.test/watch/selected-last");
  assert.equal(new Set(result.map(({ url }) => url)).size, 32);
});

test("returns only declared metadata without page mutation or unrelated attributes", () => {
  const video = media({ src: "movie.mp4", poster: "https://private.example.test/poster.jpg", title: "Private title", videoWidth: 1280, videoHeight: 720 });
  Object.freeze(video);
  const result = collect(root(video));
  assert.deepEqual(Object.keys(result[0]).sort(), ["contentType", "height", "mediaKind", "url", "width"]);
  assert.equal(result[0].width, 1280);
  assert.deepEqual(collect(undefined), []);
  assert.deepEqual(collect({}), []);
});
