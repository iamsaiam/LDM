#!/usr/bin/env python3
"""Exercise actual FFmpeg quality selection, single-stream muxing, and audio output."""
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command, expected=0, **kwargs):
    result = subprocess.run(command, text=True, capture_output=True, timeout=30, **kwargs)
    if result.returncode != expected:
        raise AssertionError(f"command exited {result.returncode}, expected {expected}: {command}\n{result.stdout}\n{result.stderr}")
    return result


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]).stdout)


def assert_tone(path, expected):
    result = subprocess.run(["ffmpeg", "-v", "error", "-ss", "0.4", "-i", str(path), "-map", "0:a:0",
                             "-t", "1", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
                            capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    samples = struct.unpack("<" + "h" * (len(result.stdout) // 2), result.stdout)
    crossings = sum(first <= 0 < second or second <= 0 < first for first, second in zip(samples, samples[1:]))
    frequency = crossings * 8000 / (2 * len(samples))
    assert abs(frequency - expected) < 15, f"audio program mismatch: expected {expected} Hz, got {frequency:.1f} Hz"


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: media_features_test.py PATH_TO_ENGINE_FEATURES_DRIVER")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("FFmpeg/ffprobe are unavailable; media fixture test skipped")
        return 77
    driver = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix="ldm media fixtures ") as directory:
        work = Path(directory)
        # Distinct variant programs exercise automatic matching audio, rather than
        # mapping every rendition into the output as earlier engine versions did.
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "3",
            "-filter_complex", "[0:v]split=2[high][small];[small]scale=320:180[low]",
            "-map", "[low]", "-map", "1:a", "-map", "[high]", "-map", "2:a",
            "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-c:a", "aac",
            "-b:v:0", "200k", "-b:v:1", "600k", "-f", "hls", "-hls_time", "1",
            "-hls_playlist_type", "vod", "-var_stream_map", "v:0,a:0 v:1,a:1",
            "-master_pl_name", "master.m3u8", "-hls_segment_filename", str(work / "segment_%v_%03d.ts"),
            str(work / "variant_%v.m3u8"),
        ])
        master = str(work / "master.m3u8")
        inspected = run([driver, "inspect", master]).stdout.splitlines()
        duration = float(next(line.split("=", 1)[1] for line in inspected if line.startswith("duration=")))
        assert 2.9 <= duration <= 3.2, inspected
        streams = [line.split("=", 1)[1].split("|") for line in inspected if line.startswith("stream=")]
        videos = sorted([stream for stream in streams if stream[1] == "video"], key=lambda stream: int(stream[4]))
        audios = [stream for stream in streams if stream[1] == "audio"]
        assert [int(stream[4]) for stream in videos] == [180, 360], streams
        assert len(audios) == 2 and all(stream[6] for stream in streams), streams
        low, high = videos
        assert set(low[6].split(",")) != set(high[6].split(",")), streams

        def download(name, video=-1, audio=-1, audio_only=False, output_format="mp4", source=master):
            requested = work / (name + ".wrong")
            result = run([driver, "download", source, str(requested), "hls" if source == master else "-",
                          str(video), str(audio), str(int(audio_only)), output_format, "4", str(work / "control")])
            extension = "m4a" if audio_only and output_format == "mp4" else output_format
            output = requested.with_suffix("." + extension)
            assert output.exists() and output.stat().st_size > 0, (result.stdout, result.stderr)
            assert not requested.exists(), "container did not update the output extension"
            assert output.name in result.stdout, "resolved final filename was not reported"
            assert not list(work.glob(output.name + ".part*")), "temporary media output was not removed"
            return output

        best = download("best")
        best_streams = probe(best)["streams"]
        assert len(best_streams) == 2, best_streams
        assert [stream["height"] for stream in best_streams if stream["codec_type"] == "video"] == [360], best_streams
        assert [stream["codec_name"] for stream in best_streams] == ["h264", "aac"], best_streams
        assert_tone(best, 880)
        selected = download("selected-low", video=int(low[0]), output_format="mkv")
        selected_streams = probe(selected)["streams"]
        assert len(selected_streams) == 2, selected_streams
        assert [stream["height"] for stream in selected_streams if stream["codec_type"] == "video"] == [180], selected_streams
        assert_tone(selected, 440)
        matching_audio = next(stream for stream in audios if stream[6] == low[6])
        download("explicit-audio", video=int(low[0]), audio=int(matching_audio[0]))
        for fmt, codec in [("mp4", "aac"), ("m4a", "aac"), ("mp3", "mp3"), ("opus", "opus")]:
            audio_path = download("audio-" + fmt, audio_only=True, output_format=fmt)
            actual = probe(audio_path)["streams"]
            assert len(actual) == 1 and actual[0]["codec_type"] == "audio" and actual[0]["codec_name"] == codec, actual
        # DASH follows the same inspection and single-stream mux path.
        dash_directory = work / "dash"
        dash_directory.mkdir()
        dash = dash_directory / "manifest.mpd"
        run(["ffmpeg", "-v", "error", "-y", "-i", str(best), "-map", "0", "-c", "copy", "-f", "dash", str(dash)])
        dash_output = download("dash-output", source=str(dash))
        dash_streams = probe(dash_output)["streams"]
        assert len(dash_streams) == 2 and {stream["codec_type"] for stream in dash_streams} == {"video", "audio"}, dash_streams
        assert [stream["height"] for stream in dash_streams if stream["codec_type"] == "video"] == [360], dash_streams
        assert_tone(dash_output, 880)
        # Direct media audio extraction uses the same selection pipeline.
        direct_audio = download("direct-audio", audio_only=True, output_format="mp3", source=str(best))
        assert [stream["codec_type"] for stream in probe(direct_audio)["streams"]] == ["audio"]
        invalid = work / "invalid.mp4"
        result = run([driver, "download", master, str(invalid), "hls", "999", "-1", "0", "mp4", "4", str(work / "control")], expected=1)
        assert "stream index" in result.stderr and not invalid.exists(), result.stderr
        assert not list(work.glob("invalid.mp4.part*"))
    print("Real HLS/DASH inspection/program membership, best and explicit quality, one video+audio mux, MKV, M4A/MP3/Opus, direct audio extraction, invalid-index rejection passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
