const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("content discovery reports new native sources, retries failures and follows player events", async () => {
  const frames = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const messages = [];
  let sources = [{ url: "https://cdn.example.test/play?id=one", contentType: "", mediaKind: "video", width: 0, height: 0 }];
  let mutationCallback;
  let observationOptions;
  let failNextReport = false;
  const context = {
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          messages.push(message);
          if (message.type === "ldm:get-streams") return { streams: [] };
          assert.equal(message.type, "ldm:media-sources", "discovery must not enqueue downloads");
          if (failNextReport) {
            failNextReport = false;
            throw new Error("temporary background restart");
          }
          return { count: message.sources.length };
        }
      }
    },
    LdmMediaSources: { collect() { return sources.map((item) => ({ ...item })); } },
    document: {
      documentElement: {},
      querySelectorAll() { return []; },
      addEventListener(name, callback) { documentListeners.set(name, callback); }
    },
    window: { addEventListener(name, callback) { windowListeners.set(name, callback); } },
    location: { href: "https://watch.example.test/lesson" },
    requestAnimationFrame(callback) { frames.push(callback); },
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe(_target, options) { observationOptions = options; }
    },
    console: { debug() {} }
  };
  const runFrame = async () => {
    const callback = frames.shift();
    assert.ok(callback, "a discovery scan should be scheduled");
    callback();
    await tick();
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  await runFrame();
  const reports = () => messages.filter((message) => message.type === "ldm:media-sources");
  assert.equal(reports().length, 1);
  assert.equal(reports()[0].sources[0].url, sources[0].url);
  assert.equal(reports()[0].documentUrl, context.location.href);
  assert.equal(observationOptions.attributes, true);
  assert.ok(observationOptions.attributeFilter.includes("src"));

  mutationCallback();
  mutationCallback();
  assert.equal(frames.length, 1, "DOM mutations should share one animation-frame scan");
  await runFrame();
  assert.equal(reports().length, 1, "unchanged sources must not flood the background");

  sources[0].width = 1920;
  sources[0].height = 1080;
  documentListeners.get("loadedmetadata")();
  await runFrame();
  assert.equal(reports().length, 2);
  assert.equal(reports()[1].sources[0].height, 1080);

  sources = [{ ...sources[0], url: "https://cdn.example.test/play?id=two" }];
  failNextReport = true;
  documentListeners.get("loadstart")();
  await runFrame();
  documentListeners.get("play")();
  await runFrame();
  assert.equal(reports().length, 4, "a failed source report must be retried on the next player event");
  assert.equal(reports()[3].sources[0].url, sources[0].url);

  windowListeners.get("pageshow")();
  await runFrame();
  assert.equal(reports().length, 5, "returning from page cache must republish native sources");
});

test("both extension manifests load the media collector before the player overlay", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", name), "utf8"));
    const scripts = manifest.content_scripts[0].js;
    assert.ok(scripts.includes("media-sources.js"));
    assert.ok(scripts.indexOf("media-sources.js") < scripts.indexOf("content.js"));
  }
});

test("stream announcements update the player download button without starting a download", async () => {
  class Element {
    constructor() {
      this.children = [];
      this.attributes = new Map();
      this.style = { getPropertyValue() { return ""; }, getPropertyPriority() { return ""; }, setProperty() {} };
    }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener() {}
    attachShadow() { this.shadow = new Element(); return this.shadow; }
    getBoundingClientRect() { return { width: 640, height: 360 }; }
  }
  const player = new Element();
  player.isConnected = true;
  const video = { closest() { return player; } };
  let onMessage;
  const frames = [];
  const requests = [];
  const context = {
    chrome: {
      runtime: {
        getURL: (value) => `moz-extension://ldm-test/${value}`,
        onMessage: { addListener(listener) { onMessage = listener; } },
        async sendMessage(message) {
          requests.push(message);
          assert.equal(message.type, "ldm:get-streams");
          return { streams: [] };
        }
      }
    },
    LdmMediaSources: { collect() { return []; } },
    document: {
      documentElement: {},
      querySelectorAll: () => [video],
      createElement: () => new Element(),
      addEventListener() {}
    },
    window: { addEventListener() {} },
    location: { href: "https://watch.example.test/player" },
    getComputedStyle: () => ({ position: "relative" }),
    requestAnimationFrame(callback) { frames.push(callback); },
    MutationObserver: class { observe() {} },
    console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context);
  frames.shift()();
  await tick();
  const trigger = player.children[0].shadow.children.find((element) => element.className === "ldm-trigger");
  assert.ok(trigger);
  assert.equal(trigger.textContent, "Download with LDM");
  onMessage({ type: "ldm:streams-changed", count: 2 });
  assert.equal(trigger.textContent, "Download with LDM · 2");
  assert.equal(trigger.attributes.get("aria-label"), "Show 2 detected media streams");
  onMessage({ type: "ldm:streams-changed", count: 0 });
  assert.equal(trigger.textContent, "Download with LDM");
  assert.equal(requests.length, 1, "stream announcements must not auto-start downloads or probes");
});
