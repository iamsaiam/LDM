const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
class Element {
  constructor() { this.children = []; this.listeners = {}; this.value = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const document = { createElement: () => new Element() };
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "media-options.js"), "utf8"), context);
const helper = context.LdmMediaOptions;
const plain = (value) => JSON.parse(JSON.stringify(value));
test("actual inspected video/audio tracks become selectable without inventing quality variants", () => {
  const picker = helper.createPicker(document, { streams: [
    { index: 0, kind: "video", codec: "h264", width: 1920, height: 1080, bit_rate: 5000000 },
    { index: 1, kind: "video", codec: "h264", width: 1280, height: 720 },
    { index: 2, kind: "audio", codec: "aac", language: "eng" },
    { index: 3, kind: "audio", codec: "aac", language: "ben" },
    { index: 3, kind: "audio" }, { index: -1, kind: "video" }, { index: 9, kind: "subtitle" }
  ] });
  assert.deepEqual(picker.controls.video.select.children.map((option) => option.value), ["", "0", "1"]);
  assert.match(picker.controls.video.select.children[1].textContent, /1080p.*h264.*5000 kb\/s/);
  assert.equal(picker.controls.video.select.children.some((option) => /4K|2160p/.test(option.textContent)), false);
  assert.deepEqual(plain(picker.value()), { output_format: "mp4" });
  picker.controls.video.select.value = "1";
  picker.controls.audio.select.value = "3";
  picker.controls.container.select.value = "mkv";
  assert.deepEqual(plain(picker.value()), { video_stream_index: 1, audio_stream_index: 3, output_format: "mkv" });
  assert.equal(helper.filename("lecture.m3u8", picker.value()), "lecture.mkv");
  picker.controls.mode.select.value = "audio";
  picker.controls.mode.select.listeners.change();
  assert.equal(picker.controls.video.wrapper.hidden, true);
  assert.deepEqual(plain(picker.value()), { audio_only: true, audio_stream_index: 3, output_format: "m4a" });
  picker.controls.container.select.value = "opus";
  assert.equal(helper.filename("lecture.m3u8", picker.value()), "lecture.opus");
});
test("audio-only playlists and malformed inspector output are handled explicitly", () => {
  const picker = helper.createPicker(document, { streams: [{ index: 7, kind: "audio", codec: "opus" }] });
  assert.deepEqual(plain(picker.value()), { audio_only: true, output_format: "m4a" });
  assert.equal(picker.controls.mode.select.children.length, 1);
  assert.throws(() => helper.createPicker(document, { streams: [{ index: 0, kind: "subtitle" }] }), /did not expose/);
  assert.deepEqual(plain(helper.fields({ audio_only: true, video_stream_index: -1, audio_stream_index: "7", output_format: "exe" })), { audio_only: true });
});
test("both popup and player load the real media picker helper before their controller", () => {
  for (const name of ["manifest.json", "manifest.firefox.json"]) {
    const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", name), "utf8")).content_scripts[0].js;
    assert.ok(scripts.indexOf("media-options.js") < scripts.indexOf("content.js"));
    assert.ok(scripts.includes("media-options.js"));
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  assert.ok(html.indexOf('src="media-options.js"') < html.indexOf('src="popup.js"'));
});
