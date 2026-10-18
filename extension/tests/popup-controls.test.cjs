const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
class Element {
  constructor() {
    this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.value = "";
    this.style = { removeProperty() {} };
    this.classList = { add() {}, toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const find = (root, className) => root.className === className ? root : root.children.map((child) => find(child, className)).find(Boolean);

test("popup inspects real tracks before user download and retains pause controls while history updates", async () => {
  const elements = new Map();
  let onMessage;
  let onStorage;
  let records = [];
  const requests = [];
  const id = "00000000-0000-4000-8000-000000000141";
  const stream = { url: "https://cdn.example.test/master.m3u8", filename: "lesson.m3u8", manifestFormat: "hls", headers: {} };
  const publish = () => onStorage({ downloadHistory: { newValue: records } }, "local");
  const context = {
    document: {
      querySelector(selector) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); },
      createElement: () => new Element()
    },
    window: { setInterval() {} }, crypto: { randomUUID: () => id }, console,
    chrome: {
      tabs: { async query() { return [{ id: 5, title: "Lesson" }]; } },
      storage: { onChanged: { addListener(listener) { onStorage = listener; } } },
      runtime: {
        onMessage: { addListener(listener) { onMessage = listener; } },
        async sendMessage(message) {
          requests.push(message);
          if (message.type === "ldm:get-streams") return { streams: [stream] };
          if (message.type === "ldm:sync-download-history") return { records };
          if (message.type === "ldm:get-download-history") return { records };
          if (message.type === "ldm:inspect-stream") return { streams: [
            { index: 0, kind: "video", codec: "h264", height: 720 },
            { index: 2, kind: "audio", codec: "aac", language: "ben" }
          ] };
          if (message.type === "ldm:download-stream") {
            records = [{ id, filename: message.stream.filename, status: "downloading", format: "hls", percent: 10 }];
            publish();
            return { accepted: true, id };
          }
          if (["ldm:pause-download", "ldm:resume-download", "ldm:cancel-download"].includes(message.type)) {
            const status = message.type === "ldm:pause-download" ? "paused" : message.type === "ldm:resume-download" ? "downloading" : "cancelled";
            records = records.map((record) => ({ ...record, status }));
            publish();
            onMessage({ type: "ldm:download-event", id, event: { event: status === "downloading" ? "resumed" : status } });
            return { status };
          }
          throw new Error(`Unexpected message ${message.type}`);
        }
      }
    }
  };
  for (const file of ["transfer-metrics.js", "media-options.js", "popup.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  await tick();
  const card = elements.get("#streams").children[0];
  const download = find(card, "download-button");
  assert.ok(download);
  download.listeners.click();
  await tick();
  assert.equal(requests.filter((message) => message.type === "ldm:download-stream").length, 0);
  const picker = find(card, "media-options");
  assert.ok(picker, "a successful inspect must render the actual shared picker");
  const fields = picker.children[1].children;
  fields[1].children[1].value = "0";
  fields[2].children[1].value = "2";
  fields[3].children[1].value = "mkv";
  download.listeners.click();
  await tick();
  const submitted = requests.find((message) => message.type === "ldm:download-stream");
  assert.equal(submitted.stream.video_stream_index, 0);
  assert.equal(submitted.stream.audio_stream_index, 2);
  assert.equal(submitted.stream.output_format, "mkv");
  assert.equal(submitted.stream.filename, "lesson.mkv");
  const transfer = elements.get("#transfers").children[0];
  const pause = find(transfer, "cancel-transfer pause-transfer");
  await pause.listeners.click();
  await tick();
  assert.equal(pause.textContent, "Resume");
  assert.equal(elements.get("#transfers").children[0], transfer, "pause must keep the same history card mounted");
  assert.equal(find(elements.get("#transfers"), "cancel-transfer pause-transfer"), pause);
  assert.equal(find(card, "cancel-transfer").textContent, "Resume", "the live detected row follows the same paused event");
  await pause.listeners.click();
  await tick();
  assert.equal(pause.textContent, "Pause");
  const cancel = find(transfer, "cancel-transfer");
  await cancel.listeners.click();
  await tick();
  assert.equal(records[0].status, "cancelled");
  assert.equal(find(card, "cancel-transfer").hidden, true);
});
