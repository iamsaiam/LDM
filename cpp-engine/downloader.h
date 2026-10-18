#ifndef LDM_DOWNLOADER_H
#define LDM_DOWNLOADER_H

#include <cstddef>
#include <cstdint>
#include <atomic>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ldm {

struct DownloadProgress {
    DownloadProgress()
        : bytes_downloaded(0),
          bytes_processed(0),
          total_bytes(0),
          percent_complete(0.0),
          bytes_per_second(0.0),
          phase("download"),
          output_filename() {}

    std::uint64_t bytes_downloaded;
    // Output bytes produced by a remux/transcode stage; zero for ordinary downloads.
    std::uint64_t bytes_processed;
    std::uint64_t total_bytes;
    double percent_complete;
    double bytes_per_second;
    std::string phase;
    // Final basename selected by the engine after resolving name collisions.
    std::string output_filename;
};

using ProgressCallback = std::function<void(const DownloadProgress&)>;

class DownloadCancelled : public std::runtime_error {
public:
    DownloadCancelled() : std::runtime_error("Download cancelled") {}
};

struct DownloadOptions {
    DownloadOptions()
        : max_connections(8),
          chunk_size(1U * 1024U * 1024U),
          output_path(),
          manifest_format(),
          connect_timeout_seconds(15),
          transfer_timeout_seconds(0),
          max_retries(3),
          retry_backoff_milliseconds(500),
          resume_partial_downloads(true),
          cancellation_requested(),
          pause_requested(),
          video_stream_index(-1),
          audio_stream_index(-1),
          audio_only(false),
          output_format("mp4"),
          progress_callback(),
          user_agent("LDM/1.0"),
          cookies(),
          referer(),
          custom_headers() {}

    std::size_t max_connections;
    std::size_t chunk_size;
    std::string output_path;
    // Optional HLS/DASH format hint for manifest URLs without a file suffix.
    std::string manifest_format;
    long connect_timeout_seconds;
    long transfer_timeout_seconds;
    // Retries are capped internally to keep failures bounded.
    std::size_t max_retries;
    std::size_t retry_backoff_milliseconds;
    // Persists validated range chunks and resumes them on the next invocation.
    bool resume_partial_downloads;
    // Shared with the HTTP job registry so active curl/FFmpeg work can stop promptly.
    std::shared_ptr<std::atomic_bool> cancellation_requested;
    // Pauses the existing transfer and helper process without discarding its state.
    std::shared_ptr<std::atomic_bool> pause_requested;
    // Absolute ffprobe stream indices. -1 selects the best available stream.
    int video_stream_index;
    int audio_stream_index;
    bool audio_only;
    // Video: mp4/mkv. Audio: m4a/mp3/opus (mp4 resolves to m4a in audio mode).
    std::string output_format;
    ProgressCallback progress_callback;
    std::string user_agent;
    // Optional HTTP cookie header value, for example "session=abc; preference=dark".
    std::string cookies;
    // Optional HTTP Referer header value.
    std::string referer;
    // Additional HTTP request headers as name/value pairs.
    std::vector<std::pair<std::string, std::string>> custom_headers;
};

struct MediaStream {
    int index = -1;
    std::string kind;
    std::string codec;
    int width = 0;
    int height = 0;
    std::uint64_t bit_rate = 0;
    std::string language;
    std::vector<int> program_ids;
    bool is_default = false;
};

struct MediaInspection {
    double duration_seconds = 0.0;
    std::vector<MediaStream> streams;
};

// Reads the actual media metadata using ffprobe, with a bounded active-time timeout.
MediaInspection inspect_media(const std::string& url, const DownloadOptions& options = {});

class Downloader {
public:
    explicit Downloader(DownloadOptions options = {});

    // Downloads to output_path, or resolves a filename from Content-Disposition then the URL.
    // If output_path is a directory, the resolved filename is placed inside it.
    // The progress callback is serialized and may be called from a worker thread.
    void download(const std::string& url) const;

private:
    DownloadOptions options_;
};

}  // namespace ldm

#endif  // LDM_DOWNLOADER_H
