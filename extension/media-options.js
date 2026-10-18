(() => {
  function normalize(result) {
    const seen = new Set();
    const streams = (Array.isArray(result?.streams) ? result.streams : []).filter((stream) => {
      if (!stream || !Number.isInteger(stream.index) || stream.index < 0
        || !["video", "audio"].includes(stream.kind) || seen.has(stream.index)) return false;
      seen.add(stream.index);
      return true;
    });
    return { duration_seconds: Number(result?.duration_seconds) || 0, streams };
  }

  function fields(selection = {}) {
    const result = {};
    for (const key of ["video_stream_index", "audio_stream_index"]) {
      if (Number.isInteger(selection[key]) && selection[key] >= 0) result[key] = selection[key];
    }
    if (selection.audio_only === true) result.audio_only = true;
    if (["mp4", "mkv", "m4a", "mp3", "opus"].includes(selection.output_format)) {
      result.output_format = selection.output_format;
    }
    return result;
  }

  function filename(value, selection = {}) {
    const extension = selection.output_format || (selection.audio_only ? "m4a" : "mp4");
    return `${String(value || "media").replace(/\.(?:m3u8|mpd|mp4|mkv|m4a|mp3|opus)$/i, "")}.${extension}`;
  }

  function label(stream) {
    const bitrate = Number(stream.bit_rate) > 0 ? `${Math.round(Number(stream.bit_rate) / 1000)} kb/s` : "";
    return [stream.kind === "video" && Number(stream.height) > 0 ? `${stream.height}p` : "",
      stream.codec, stream.language, bitrate, `track ${stream.index}`].filter(Boolean).join(" · ");
  }

  function createPicker(document, result, onChange = () => {}) {
    const inspected = normalize(result);
    if (!inspected.streams.length) throw new Error("This playlist did not expose any downloadable video or audio tracks.");
    const root = document.createElement("div");
    root.className = "media-options";
    const note = document.createElement("p");
    note.className = "media-options-note";
    note.textContent = "Tracks verified from this playlist. Best selects the highest available video and matching audio.";
    const grid = document.createElement("div");
    grid.className = "media-options-grid";
    const controls = {};
    const makeSelect = (key, caption) => {
      const wrapper = document.createElement("label");
      wrapper.className = "media-option";
      const text = document.createElement("span");
      text.textContent = caption;
      const select = document.createElement("select");
      select.setAttribute("aria-label", caption);
      wrapper.append(text, select);
      grid.append(wrapper);
      controls[key] = { wrapper, select };
      return select;
    };
    const option = (select, value, text) => {
      const item = document.createElement("option");
      item.value = String(value);
      item.textContent = text;
      select.append(item);
    };
    const videos = inspected.streams.filter((stream) => stream.kind === "video");
    const audios = inspected.streams.filter((stream) => stream.kind === "audio");
    const mode = makeSelect("mode", "Save");
    if (videos.length) option(mode, "video", "Video + audio");
    if (audios.length) option(mode, "audio", "Audio only");
    mode.value = videos.length ? "video" : "audio";
    const video = makeSelect("video", "Video quality");
    option(video, "", "Best available (automatic)");
    for (const stream of videos) option(video, stream.index, label(stream));
    video.value = "";
    const audio = makeSelect("audio", "Audio track");
    option(audio, "", audios.length ? "Matching audio (automatic)" : "No audio track available");
    for (const stream of audios) option(audio, stream.index, label(stream));
    audio.value = "";
    audio.disabled = !audios.length;
    const container = makeSelect("container", "File format");
    let audioMode = null;
    const value = () => ({
      ...(mode.value === "audio" ? { audio_only: true } : {}),
      ...(mode.value !== "audio" && video.value !== "" ? { video_stream_index: Number(video.value) } : {}),
      ...(audio.value !== "" ? { audio_stream_index: Number(audio.value) } : {}),
      output_format: container.value
    });
    function refresh() {
      const nextAudioMode = mode.value === "audio";
      controls.video.wrapper.hidden = nextAudioMode || !videos.length;
      if (nextAudioMode !== audioMode) {
        container.replaceChildren();
        for (const format of nextAudioMode ? ["m4a", "mp3", "opus"] : ["mp4", "mkv"]) {
          option(container, format, format.toUpperCase());
        }
        container.value = nextAudioMode ? "m4a" : "mp4";
        audioMode = nextAudioMode;
      }
      onChange(value());
    }
    for (const { select } of Object.values(controls)) select.addEventListener("change", refresh);
    root.append(note, grid);
    refresh();
    return { root, value, controls, inspected };
  }

  globalThis.LdmMediaOptions = Object.freeze({ normalize, fields, filename, createPicker });
})();
