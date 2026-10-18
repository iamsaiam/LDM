#include "downloader.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>

#include <cstring>
#include <cstdio>
#include <exception>
#include <curl/curl.h>
#if __has_include(<filesystem>)
#include <filesystem>
namespace fs = std::filesystem;
#elif __has_include(<experimental/filesystem>)
#include <experimental/filesystem>
namespace fs = std::experimental::filesystem;
#else
#error "This project requires filesystem support"
#endif
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <map>
#include <set>
#include <tuple>
#include <mutex>
#include <poll.h>
#include <spawn.h>
#include <signal.h>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace {

constexpr std::size_t kChunkBufferSize = 64U * 1024U;

void share_lock_callback(CURL*, curl_lock_data, curl_lock_access, void* user_data) {
    static_cast<std::mutex*>(user_data)->lock();
}

void share_unlock_callback(CURL*, curl_lock_data, void* user_data) {
    static_cast<std::mutex*>(user_data)->unlock();
}

class SharedCookieStore {
public:
    SharedCookieStore() : share_(curl_share_init()) {
        if (share_ == nullptr) {
            throw std::runtime_error("Failed to initialize libcurl shared cookie store");
        }
        if (curl_share_setopt(share_, CURLSHOPT_LOCKFUNC, &share_lock_callback) != CURLSHE_OK
            || curl_share_setopt(share_, CURLSHOPT_UNLOCKFUNC, &share_unlock_callback) != CURLSHE_OK
            || curl_share_setopt(share_, CURLSHOPT_USERDATA, &mutex_) != CURLSHE_OK
            || curl_share_setopt(share_, CURLSHOPT_SHARE, CURL_LOCK_DATA_COOKIE) != CURLSHE_OK) {
            curl_share_cleanup(share_);
            share_ = nullptr;
            throw std::runtime_error("Failed to configure libcurl shared cookie store");
        }
    }

    ~SharedCookieStore() {
        if (share_ != nullptr) {
            curl_share_cleanup(share_);
        }
    }

    SharedCookieStore(const SharedCookieStore&) = delete;
    SharedCookieStore& operator=(const SharedCookieStore&) = delete;

    CURLSH* get() const noexcept {
        return share_;
    }

private:
    CURLSH* share_;
    std::mutex mutex_;
};

void initialize_curl() {
    static std::mutex initialization_mutex;
    static bool initialized = false;
    static bool initialization_failed = false;

    std::lock_guard<std::mutex> lock(initialization_mutex);
    if (!initialized) {
        const CURLcode result = curl_global_init(CURL_GLOBAL_DEFAULT);
        if (result != CURLE_OK) {
            initialization_failed = true;
            throw std::runtime_error("Failed to initialize libcurl globally");
        }
        initialized = true;
        return;
    }

    if (initialization_failed) {
        throw std::runtime_error("Failed to initialize libcurl globally");
    }
}

std::string trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return {};
    }

    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1U);
}

int hex_value(unsigned char character) {
    if (character >= '0' && character <= '9') {
        return static_cast<int>(character - '0');
    }
    if (character >= 'a' && character <= 'f') {
        return static_cast<int>(character - 'a') + 10;
    }
    if (character >= 'A' && character <= 'F') {
        return static_cast<int>(character - 'A') + 10;
    }
    return -1;
}

std::string percent_decode(const std::string& value) {
    std::string decoded;
    decoded.reserve(value.size());
    for (std::size_t index = 0U; index < value.size(); ++index) {
        if (value[index] == '%' && index + 2U < value.size()) {
            const int high = hex_value(static_cast<unsigned char>(value[index + 1U]));
            const int low = hex_value(static_cast<unsigned char>(value[index + 2U]));
            if (high >= 0 && low >= 0) {
                decoded.push_back(static_cast<char>((high << 4) | low));
                index += 2U;
                continue;
            }
        }
        decoded.push_back(value[index]);
    }
    return decoded;
}

std::string safe_filename(const std::string& value) {
    std::string normalized = value;
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    const auto slash = normalized.find_last_of('/');
    if (slash != std::string::npos) {
        normalized.erase(0U, slash + 1U);
    }
    if (normalized.empty() || normalized == "." || normalized == "..") {
        return {};
    }
    return normalized;
}

std::string url_path_filename(const std::string& url) {
    const auto scheme_end = url.find("://");
    const std::size_t authority_start = scheme_end == std::string::npos ? 0U : scheme_end + 3U;
    const auto path_start = url.find_first_of("/?#", authority_start);
    if (path_start == std::string::npos || url[path_start] != '/') {
        return {};
    }

    const auto path_end = url.find_first_of("?#", path_start);
    const std::string path = url.substr(path_start, path_end - path_start);
    return safe_filename(percent_decode(path));
}

bool path_is_directory(const std::filesystem::path& path) {
    std::error_code error;
    if (std::filesystem::is_directory(path, error)) {
        return true;
    }
    const std::string value = path.string();
    return !value.empty() && (value.back() == '/' || value.back() == '\\');
}

std::string resolve_output_path(const std::string& url,
    const std::string& configured_path,
    const std::string& server_filename);
bool is_http_url(const std::string& url);
std::chrono::milliseconds retry_delay(const ldm::DownloadOptions& options, std::size_t attempt);
std::size_t retry_count(const ldm::DownloadOptions& options);

void throw_if_cancelled(const ldm::DownloadOptions& options) {
    if (options.cancellation_requested
        && options.cancellation_requested->load(std::memory_order_relaxed)) {
        throw ldm::DownloadCancelled();
    }
}

bool wait_until_running(const std::atomic_bool* paused, const std::atomic_bool* cancelled) {
    while (paused != nullptr && paused->load(std::memory_order_relaxed)) {
        if (cancelled != nullptr && cancelled->load(std::memory_order_relaxed)) return false;
        std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    return cancelled == nullptr || !cancelled->load(std::memory_order_relaxed);
}

void wait_until_running(const ldm::DownloadOptions& options) {
    if (!wait_until_running(options.pause_requested.get(), options.cancellation_requested.get())) {
        throw ldm::DownloadCancelled();
    }
}

bool is_hls_url(const std::string& url) {
    std::string filename = url_path_filename(url);
    std::transform(filename.begin(), filename.end(), filename.begin(),
        [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    return filename.size() >= 5U && filename.compare(filename.size() - 5U, 5U, ".m3u8") == 0;
}

bool is_dash_url(const std::string& url) {
    std::string filename = url_path_filename(url);
    std::transform(filename.begin(), filename.end(), filename.begin(),
        [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
    return filename.size() >= 4U && filename.compare(filename.size() - 4U, 4U, ".mpd") == 0;
}

std::string ffmpeg_http_headers(const ldm::DownloadOptions& options) {
    std::ostringstream headers;
    const auto append = [&headers](const std::string& name, const std::string& value) {
        if (value.find_first_of("\r\n") != std::string::npos) {
            throw std::invalid_argument("HTTP header values must not contain newlines");
        }
        if (!value.empty()) {
            headers << name << ": " << value << "\r\n";
        }
    };

    append("User-Agent", options.user_agent);
    append("Referer", options.referer);
    append("Cookie", options.cookies);
    for (const auto& [name, value] : options.custom_headers) {
        if (name.empty() || name.find_first_of(":\r\n") != std::string::npos) {
            throw std::invalid_argument("Invalid custom HTTP header name");
        }
        append(name, value);
    }
    return headers.str();
}

bool remote_media_input(const std::string& url) {
    const auto separator = url.find(':');
    if (separator == std::string::npos || separator == 0U
        || std::isalpha(static_cast<unsigned char>(url.front())) == 0) return false;
    std::string scheme = url.substr(0U, separator);
    for (unsigned char character : scheme) {
        if (std::isalnum(character) == 0 && character != '+' && character != '-' && character != '.') return false;
    }
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return scheme != "file";
}

constexpr const char* kRemoteMediaProtocols = "http,https,ftp,ftps,tcp,tls,crypto";

std::string tls_ca_bundle() {
    const char* configured = std::getenv("LDM_CA_BUNDLE");
    return configured == nullptr ? std::string{} : std::string(configured);
}

void configure_media_network(std::vector<std::string>& command, const std::string& url) {
    if (!remote_media_input(url)) return;
    command.insert(command.end(), {"-protocol_whitelist", kRemoteMediaProtocols});
    // Plain HTTP/FTP cannot consume TLS arguments in FFmpeg's CLI.
    const auto separator = url.find(':');
    std::string scheme = url.substr(0U, separator);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    if (scheme != "https") return;
    command.insert(command.end(), {"-tls_verify", "1"});
    const std::string authorities = tls_ca_bundle();
    if (!authorities.empty()) {
        command.insert(command.end(), {"-ca_file", authorities});
    }
}

int run_process(const std::vector<std::string>& arguments,
    const std::function<void(const std::string&)>& line_callback,
    const std::atomic_bool* cancellation_requested = nullptr,
    const std::atomic_bool* pause_requested = nullptr,
    std::chrono::seconds timeout = std::chrono::seconds::zero()) {
    if (arguments.empty()) {
        throw std::invalid_argument("Cannot execute an empty process command");
    }
    if (cancellation_requested != nullptr
        && cancellation_requested->load(std::memory_order_relaxed)) {
        throw ldm::DownloadCancelled();
    }

    for (const auto& argument : arguments) {
        if (argument.find('\0') != std::string::npos) throw std::invalid_argument("Media arguments cannot contain null bytes");
    }
    int pipe_fds[2] = {-1, -1};
#if defined(LDM_HAVE_PIPE2)
    if (::pipe2(pipe_fds, O_CLOEXEC) != 0) {
        throw std::runtime_error("Failed to create FFmpeg output pipe: "
            + std::string(std::strerror(errno)));
    }
#else
    // On POSIX targets without pipe2, guard pipe()+fcntl() through spawn so
    // another LDM worker cannot inherit these descriptors.
    static std::mutex pipe_spawn_mutex;
    std::unique_lock<std::mutex> pipe_spawn_lock(pipe_spawn_mutex);
    if (::pipe(pipe_fds) != 0) {
        throw std::runtime_error("Failed to create FFmpeg output pipe: "
            + std::string(std::strerror(errno)));
    }
    for (const int pipe_fd : pipe_fds) {
        const int descriptor_flags = ::fcntl(pipe_fd, F_GETFD);
        if (descriptor_flags < 0 || ::fcntl(pipe_fd, F_SETFD, descriptor_flags | FD_CLOEXEC) < 0) {
            const int error_number = errno;
            ::close(pipe_fds[0]);
            ::close(pipe_fds[1]);
            throw std::runtime_error("Failed to protect FFmpeg output pipe descriptors: "
                + std::string(std::strerror(error_number)));
        }
    }
#endif

    posix_spawn_file_actions_t actions;
    int spawn_error = ::posix_spawn_file_actions_init(&actions);
    if (spawn_error != 0) {
        ::close(pipe_fds[0]);
        ::close(pipe_fds[1]);
        throw std::runtime_error("Failed to initialize FFmpeg process actions: "
            + std::string(std::strerror(spawn_error)));
    }

    spawn_error = ::posix_spawn_file_actions_adddup2(&actions, pipe_fds[1], STDOUT_FILENO);
    if (spawn_error == 0) {
        spawn_error = ::posix_spawn_file_actions_addclose(&actions, pipe_fds[0]);
    }
    if (spawn_error == 0) {
        spawn_error = ::posix_spawn_file_actions_addclose(&actions, pipe_fds[1]);
    }
    if (spawn_error != 0) {
        ::posix_spawn_file_actions_destroy(&actions);
        ::close(pipe_fds[0]);
        ::close(pipe_fds[1]);
        throw std::runtime_error("Failed to configure FFmpeg process output: "
            + std::string(std::strerror(spawn_error)));
    }

    std::vector<char*> argv;
    argv.reserve(arguments.size() + 1U);
    for (const auto& argument : arguments) {
        argv.push_back(const_cast<char*>(argument.c_str()));
    }
    argv.push_back(nullptr);

    pid_t process_id = -1;
    spawn_error = ::posix_spawnp(&process_id, argv.front(), &actions, nullptr, argv.data(), environ);
#if defined(__APPLE__)
    // Finder's application environment may omit Homebrew's bin directories.
    // Keep the caller's PATH preference, then try only these known media tools.
    if ((spawn_error == ENOENT || spawn_error == EACCES)
        && (arguments.front() == "ffmpeg" || arguments.front() == "ffprobe")) {
        for (const char* directory : {"/opt/homebrew/bin/", "/usr/local/bin/"}) {
            const std::string executable = std::string(directory) + arguments.front();
            struct stat executable_status{};
            if (::access(executable.c_str(), X_OK) != 0
                || ::stat(executable.c_str(), &executable_status) != 0
                || !S_ISREG(executable_status.st_mode)) continue;
            spawn_error = ::posix_spawn(&process_id, executable.c_str(), &actions,
                nullptr, argv.data(), environ);
            if (spawn_error == 0) break;
        }
    }
#endif
#if !defined(LDM_HAVE_PIPE2)
    pipe_spawn_lock.unlock();
#endif
    ::posix_spawn_file_actions_destroy(&actions);
    ::close(pipe_fds[1]);
    if (spawn_error != 0) {
        ::close(pipe_fds[0]);
        throw std::runtime_error("Unable to start " + arguments.front() + ": "
            + std::string(std::strerror(spawn_error))
            + " (install FFmpeg and ffprobe to process streaming media manifests)");
    }

    std::exception_ptr callback_error;
    std::string pending;
    std::array<char, 4096> buffer{};
    bool cancellation_sent = false;
    bool timeout_sent = false;
    bool force_kill_sent = false;
    bool paused = false;
    bool pipe_closed = false;
    bool child_exited = false;
    int status = 0;
    auto active_deadline = std::chrono::steady_clock::now() + timeout;
    auto previous_tick = std::chrono::steady_clock::now();
    std::chrono::steady_clock::time_point cancellation_at{};
    while (!child_exited || !pipe_closed) {
        const auto now = std::chrono::steady_clock::now();
        if (paused) active_deadline += now - previous_tick;
        previous_tick = now;
        const bool cancelled = cancellation_requested != nullptr
            && cancellation_requested->load(std::memory_order_relaxed);
        const bool expired = timeout > std::chrono::seconds::zero() && now >= active_deadline;
        if (!child_exited && (cancelled || expired || callback_error)) {
            if (!cancellation_sent) {
                // A stopped process cannot handle SIGTERM until resumed.
                if (paused) static_cast<void>(::kill(process_id, SIGCONT));
                paused = false;
                static_cast<void>(::kill(process_id, SIGTERM));
                cancellation_sent = true;
                timeout_sent = expired && !cancelled;
                cancellation_at = now;
            } else if (!force_kill_sent && now - cancellation_at > std::chrono::seconds(2)) {
                static_cast<void>(::kill(process_id, SIGKILL));
                force_kill_sent = true;
            }
        } else if (!child_exited) {
            const bool requested = pause_requested != nullptr
                && pause_requested->load(std::memory_order_relaxed);
            if (requested != paused) {
                static_cast<void>(::kill(process_id, requested ? SIGSTOP : SIGCONT));
                paused = requested;
            }
        }

        if (!pipe_closed) {
            pollfd descriptor{pipe_fds[0], POLLIN | POLLHUP, 0};
            const int ready = ::poll(&descriptor, 1, 50);
            if (ready < 0 && errno != EINTR) {
                callback_error = std::make_exception_ptr(std::runtime_error(
                    "Failed to monitor media process output: " + std::string(std::strerror(errno))));
            } else if (ready == 0 && child_exited) {
                ::close(pipe_fds[0]);
                pipe_closed = true;
            } else if (ready > 0) {
                const ssize_t count = ::read(pipe_fds[0], buffer.data(), buffer.size());
                if (count == 0 || (count < 0 && errno != EINTR)) {
                    if (count < 0) callback_error = std::make_exception_ptr(std::runtime_error(
                        "Failed to read media process output: " + std::string(std::strerror(errno))));
                    ::close(pipe_fds[0]);
                    pipe_closed = true;
                } else if (count > 0 && !callback_error) {
                    pending.append(buffer.data(), static_cast<std::size_t>(count));
                    if (pending.size() > 256U * 1024U) {
                        callback_error = std::make_exception_ptr(std::runtime_error(
                            "Media helper output line exceeded its size limit"));
                        pending.clear();
                    }
                    std::size_t newline = pending.find('\n');
                    while (newline != std::string::npos && !callback_error) {
                        try { line_callback(pending.substr(0U, newline)); }
                        catch (...) { callback_error = std::current_exception(); }
                        pending.erase(0U, newline + 1U);
                        newline = pending.find('\n');
                    }
                }
            }
        } else if (!child_exited) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        if (!child_exited) {
            const pid_t result = ::waitpid(process_id, &status, WNOHANG);
            if (result == process_id) child_exited = true;
            else if (result < 0 && errno != EINTR) {
                if (!pipe_closed) ::close(pipe_fds[0]);
                throw std::runtime_error("Failed to wait for media process: "
                    + std::string(std::strerror(errno)));
            }
        }
    }
    if (!pending.empty() && !callback_error && !cancellation_sent) line_callback(pending);
    if (callback_error) std::rethrow_exception(callback_error);
    if (timeout_sent) throw std::runtime_error(arguments.front() + " exceeded its time limit");
    if (cancellation_sent || (cancellation_requested != nullptr
            && cancellation_requested->load(std::memory_order_relaxed))) {
        throw ldm::DownloadCancelled();
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

// ffprobe's flat writer has stable dotted section paths and quoted string values.
// Parse only the requested metadata; media tags can never become shell arguments.
std::string unquote_probe_value(const std::string& value) {
    if (value.size() < 2U || value.front() != '"' || value.back() != '"') return value;
    std::string decoded;
    for (std::size_t index = 1U; index + 1U < value.size(); ++index) {
        if (value[index] == '\\' && index + 2U < value.size()) {
            const char next = value[++index];
            decoded.push_back(next == 'n' ? '\n' : next == 'r' ? '\r' : next == 't' ? '\t' : next);
        } else decoded.push_back(value[index]);
    }
    return decoded;
}

int probe_integer(const std::string& value, int fallback = 0) {
    try {
        std::size_t consumed = 0U;
        const int number = std::stoi(value, &consumed);
        return consumed == value.size() ? number : fallback;
    } catch (const std::exception&) { return fallback; }
}

ldm::MediaInspection inspect_media_impl(const std::string& url, const ldm::DownloadOptions& options) {
    if (url.empty() || url.find('\0') != std::string::npos) {
        throw std::invalid_argument("Media URL cannot be empty or contain a null byte");
    }
    wait_until_running(options);
#if defined(LDM_REQUIRE_VERIFIED_MEDIA_TLS)
    static std::once_flag media_trust_checked;
    std::call_once(media_trust_checked, [&options] {
        for (const char* helper : {"ffprobe", "ffmpeg"}) {
            bool verification_enabled = false;
            const int status = run_process({helper, "-hide_banner", "-h", "protocol=tls"},
                [&verification_enabled](const std::string& line) {
                    if (line.find("tls_verify") != std::string::npos
                        && (line.find("(default true)") != std::string::npos
                            || line.find("(default 1)") != std::string::npos)) {
                        verification_enabled = true;
                    }
                }, options.cancellation_requested.get(), options.pause_requested.get(), std::chrono::seconds(5));
            if (status != 0 || !verification_enabled) {
                throw std::runtime_error(std::string(helper)
                    + " does not enable TLS certificate verification by default. "
                    "Install the qualified LDM media helpers before downloading streaming media.");
            }
        }
    });
#endif
    const std::string headers = is_http_url(url) ? ffmpeg_http_headers(options) : std::string{};
    std::vector<std::string> command{
        "ffprobe", "-v", "error", "-show_entries",
        "stream=index,codec_type,codec_name,width,height,bit_rate:stream_tags=language:stream_disposition=default:format=duration:program=program_id:program_stream=index",
        "-of", "flat"
    };
    configure_media_network(command, url);
    if (!headers.empty()) command.insert(command.end(), {"-headers", headers});
    command.insert(command.end(), {"-i", url});
    ldm::MediaInspection inspection;
    std::map<int, ldm::MediaStream> streams;
    std::map<int, int> program_ids;
    std::map<int, std::set<int>> program_streams;
    std::size_t output_bytes = 0U;
    const int status = run_process(command, [&](const std::string& line) {
        output_bytes += line.size();
        if (output_bytes > 2U * 1024U * 1024U) throw std::runtime_error("Media metadata is too large");
        const auto separator = line.find('=');
        if (separator == std::string::npos) return;
        const std::string key = line.substr(0U, separator);
        const std::string value = unquote_probe_value(line.substr(separator + 1U));
        if (key == "format.duration") {
            try {
                const double duration = std::stod(value);
                if (std::isfinite(duration) && duration > 0.0) inspection.duration_seconds = duration;
            } catch (const std::exception&) {}
        } else if (key.rfind("streams.stream.", 0U) == 0U) {
            const auto end = key.find('.', 15U);
            if (end == std::string::npos) return;
            const int ordinal = probe_integer(key.substr(15U, end - 15U), -1);
            if (ordinal < 0 || ordinal > 4095) return;
            auto& stream = streams[ordinal];
            const std::string field = key.substr(end + 1U);
            if (field == "index") stream.index = probe_integer(value, -1);
            else if (field == "codec_type") stream.kind = value;
            else if (field == "codec_name") stream.codec = value;
            else if (field == "width") stream.width = std::max(0, probe_integer(value));
            else if (field == "height") stream.height = std::max(0, probe_integer(value));
            else if (field == "bit_rate") {
                try { if (!value.empty() && value.front() != '-') stream.bit_rate = std::stoull(value); }
                catch (const std::exception&) {}
            } else if (field == "tags.language") stream.language = value;
            else if (field == "disposition.default") stream.is_default = value == "1";
        } else if (key.rfind("programs.program.", 0U) == 0U) {
            const auto end = key.find('.', 17U);
            if (end == std::string::npos) return;
            const int ordinal = probe_integer(key.substr(17U, end - 17U), -1);
            if (ordinal < 0 || ordinal > 4095) return;
            const std::string field = key.substr(end + 1U);
            if (field == "program_id") program_ids[ordinal] = probe_integer(value, -1);
            else if (field.rfind("streams.stream.", 0U) == 0U
                && field.size() >= 6U && field.substr(field.size() - 6U) == ".index") {
                const int index = probe_integer(value, -1);
                if (index >= 0) program_streams[ordinal].insert(index);
            }
        }
    }, options.cancellation_requested.get(), options.pause_requested.get(), std::chrono::seconds(30));
    if (status != 0) throw std::runtime_error("ffprobe could not inspect this media (exit " + std::to_string(status) + ")");
    for (auto& [ordinal, stream] : streams) {
        static_cast<void>(ordinal);
        if (stream.index < 0 || (stream.kind != "video" && stream.kind != "audio")) continue;
        for (const auto& [program, indices] : program_streams) {
            const auto id = program_ids.find(program);
            if (indices.count(stream.index) && id != program_ids.end() && id->second >= 0) {
                stream.program_ids.push_back(id->second);
            }
        }
        inspection.streams.push_back(std::move(stream));
    }
    if (inspection.streams.empty()) throw std::runtime_error("No video or audio streams were found in this media");
    return inspection;
}

std::string resolve_output_path(const std::string& url,
    const std::string& configured_path,
    const std::string& server_filename) {
    if (!configured_path.empty() && !path_is_directory(configured_path)) {
        return configured_path;
    }

    std::string filename = safe_filename(server_filename);
    if (filename.empty()) {
        filename = url_path_filename(url);
    }
    if (filename.empty()) {
        filename = "download.bin";
    }
    return configured_path.empty()
        ? filename
        : (std::filesystem::path(configured_path) / filename).string();
}

class OutputPathReservation {
public:
    OutputPathReservation(std::filesystem::path target_path, int lock_descriptor)
        : target_path_(std::move(target_path)), lock_descriptor_(lock_descriptor) {}

    ~OutputPathReservation() {
        if (lock_descriptor_ >= 0) {
            static_cast<void>(::flock(lock_descriptor_, LOCK_UN));
            ::close(lock_descriptor_);
        }
    }

    OutputPathReservation(const OutputPathReservation&) = delete;
    OutputPathReservation& operator=(const OutputPathReservation&) = delete;

    OutputPathReservation(OutputPathReservation&& other) noexcept
        : target_path_(std::move(other.target_path_)),
          lock_descriptor_(std::exchange(other.lock_descriptor_, -1)) {}

    const std::filesystem::path& target_path() const noexcept {
        return target_path_;
    }

private:
    std::filesystem::path target_path_;
    int lock_descriptor_;
};

std::filesystem::path output_lock_directory() {
    const std::filesystem::path directory = std::filesystem::temp_directory_path()
        / ("ldm-output-locks-" + std::to_string(::getuid()));
    std::error_code create_error;
    static_cast<void>(std::filesystem::create_directory(directory, create_error));
    if (create_error && create_error != std::errc::file_exists) {
        throw std::runtime_error("Unable to create the LDM output lock directory: "
            + create_error.message());
    }

    struct stat directory_status{};
    if (::lstat(directory.c_str(), &directory_status) != 0) {
        throw std::runtime_error("Unable to inspect the LDM output lock directory: "
            + std::string(std::strerror(errno)));
    }
    if (!S_ISDIR(directory_status.st_mode) || directory_status.st_uid != ::getuid()) {
        throw std::runtime_error("The LDM output lock path is not a private directory owned by this user");
    }
    if (::chmod(directory.c_str(), S_IRWXU) != 0) {
        throw std::runtime_error("Unable to secure the LDM output lock directory: "
            + std::string(std::strerror(errno)));
    }
    return directory;
}

bool output_entry_exists(const std::filesystem::path& path) {
    std::error_code error;
    const std::filesystem::file_status status = std::filesystem::symlink_status(path, error);
    if (error == std::errc::no_such_file_or_directory) {
        return false;
    }
    if (error) {
        throw std::runtime_error("Unable to inspect output path '" + path.string() + "': "
            + error.message());
    }
    return status.type() != std::filesystem::file_type::not_found;
}

std::filesystem::path numbered_output_path(const std::filesystem::path& requested,
    std::size_t suffix) {
    const std::filesystem::path filename = requested.filename();
    const std::string extension = filename.extension().string();
    const std::string stem = filename.stem().string();
    const std::string numbered_name = stem + " (" + std::to_string(suffix) + ")" + extension;
    return requested.parent_path() / numbered_name;
}

OutputPathReservation reserve_output_path(const std::filesystem::path& requested_path) {
    const std::filesystem::path lock_directory = output_lock_directory();
    for (std::size_t suffix = 0U; suffix < 10000U; ++suffix) {
        const std::filesystem::path candidate = suffix == 0U
            ? requested_path
            : numbered_output_path(requested_path, suffix);
        if (output_entry_exists(candidate)) {
            continue;
        }

        std::error_code canonical_error;
        const std::filesystem::path canonical_path = std::filesystem::weakly_canonical(
            candidate, canonical_error);
        if (canonical_error) {
            throw std::runtime_error("Unable to normalize output path '" + candidate.string() + "': "
                + canonical_error.message());
        }
        const std::string canonical_name = canonical_path.generic_string();
        std::uint64_t hash = 14695981039346656037ULL;
        for (const unsigned char character : canonical_name) {
            hash ^= character;
            hash *= 1099511628211ULL;
        }
        std::ostringstream lock_name;
        lock_name << std::hex << std::setw(16) << std::setfill('0') << hash << ".lock";
        const std::filesystem::path lock_path = lock_directory / lock_name.str();
        int open_flags = O_CREAT | O_RDWR | O_CLOEXEC;
#ifdef O_NOFOLLOW
        open_flags |= O_NOFOLLOW;
#endif
        const int lock_descriptor = ::open(lock_path.c_str(), open_flags, S_IRUSR | S_IWUSR);
        if (lock_descriptor < 0) {
            throw std::runtime_error("Unable to open output reservation: "
                + std::string(std::strerror(errno)));
        }
        if (::flock(lock_descriptor, LOCK_EX | LOCK_NB) != 0) {
            const int lock_error = errno;
            ::close(lock_descriptor);
            if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
                continue;
            }
            throw std::runtime_error("Unable to reserve output path: "
                + std::string(std::strerror(lock_error)));
        }

        if (output_entry_exists(candidate)) {
            static_cast<void>(::flock(lock_descriptor, LOCK_UN));
            ::close(lock_descriptor);
            continue;
        }
        return OutputPathReservation(candidate, lock_descriptor);
    }
    throw std::runtime_error("Unable to find an unused name for the downloaded file");
}


const ldm::MediaStream* selected_stream(const ldm::MediaInspection& media,
    const std::string& kind, int requested) {
    if (requested < -1) throw std::invalid_argument("Stream indices must be nonnegative or -1 for automatic selection");
    const ldm::MediaStream* selected = nullptr;
    for (const auto& stream : media.streams) {
        if (stream.kind != kind) continue;
        if (stream.index == requested) return &stream;
        if (requested >= 0) continue;
        if (selected == nullptr || (kind == "video"
            ? std::make_tuple(stream.height, stream.width, stream.bit_rate, stream.is_default)
                > std::make_tuple(selected->height, selected->width, selected->bit_rate, selected->is_default)
            : std::make_tuple(stream.is_default, stream.bit_rate)
                > std::make_tuple(selected->is_default, selected->bit_rate))) selected = &stream;
    }
    if (requested >= 0 && selected == nullptr) {
        throw std::invalid_argument("Selected " + kind + " stream index is not available in this media");
    }
    return selected;
}

bool matching_program(const ldm::MediaStream& video, const ldm::MediaStream& audio) {
    for (int program : video.program_ids) {
        if (std::find(audio.program_ids.begin(), audio.program_ids.end(), program) != audio.program_ids.end()) return true;
    }
    return false;
}

void download_manifest(const std::string& url, const ldm::DownloadOptions& options,
    const std::string& stream_type) {
    const ldm::MediaInspection media = inspect_media_impl(url, options);
    const ldm::MediaStream* video = options.audio_only ? nullptr
        : selected_stream(media, "video", options.video_stream_index);
    const ldm::MediaStream* audio = selected_stream(media, "audio", options.audio_stream_index);
    if (options.audio_only && options.video_stream_index != -1) {
        throw std::invalid_argument("Audio-only downloads cannot select a video stream");
    }
    if (video != nullptr && options.audio_stream_index == -1 && !video->program_ids.empty()) {
        // HLS variants can repeat one audio rendition across several programs.
        // Prefer an audio stream belonging to the selected video program.
        const ldm::MediaStream* matching = nullptr;
        for (const auto& stream : media.streams) {
            if (stream.kind == "audio" && matching_program(*video, stream)
                && (matching == nullptr || std::make_tuple(stream.is_default, stream.bit_rate)
                    > std::make_tuple(matching->is_default, matching->bit_rate))) matching = &stream;
        }
        if (matching != nullptr) audio = matching;
        else if (audio != nullptr && !audio->program_ids.empty()) audio = nullptr;
    }
    const bool audio_only = options.audio_only || video == nullptr;
    if (audio_only && audio == nullptr) throw std::invalid_argument("This media does not contain an audio stream");
    std::string format = options.output_format.empty() ? "mp4" : options.output_format;
    if (audio_only && format == "mp4") format = "m4a";
    if (audio_only ? (format != "m4a" && format != "mp3" && format != "opus")
        : (format != "mp4" && format != "mkv")) {
        throw std::invalid_argument(audio_only ? "Audio format must be m4a, mp3, or opus"
            : "Video format must be mp4 or mkv");
    }
    if (!audio_only && format == "mp4") {
        const std::set<std::string> video_codecs{"h264", "hevc", "av1", "mpeg4", "vp9", "mpeg2video"};
        const std::set<std::string> audio_codecs{"aac", "mp3", "ac3", "eac3", "alac", "opus"};
        if (!video_codecs.count(video->codec) || (audio != nullptr && !audio_codecs.count(audio->codec))) {
            throw std::invalid_argument("The selected codecs cannot be copied to MP4; select MKV to preserve their quality");
        }
    }
    const std::string resolved_path = resolve_output_path(url, options.output_path,
        url_path_filename(url));
    std::filesystem::path target_path(resolved_path);
    target_path.replace_extension("." + format);
    const std::filesystem::path parent_path = target_path.parent_path();
    if (!parent_path.empty()) std::filesystem::create_directories(parent_path);
    OutputPathReservation output_reservation = reserve_output_path(target_path);
    target_path = output_reservation.target_path();
    const std::filesystem::path temp_path = target_path.string() + ".part." + format;
    std::error_code remove_error;
    std::filesystem::remove(temp_path, remove_error);
    if (remove_error) throw std::runtime_error("Unable to remove stale media temporary file: " + remove_error.message());
    const bool http_url = is_http_url(url);
    const std::string headers = http_url ? ffmpeg_http_headers(options) : std::string{};
    std::uint64_t latest_size = 0U;
    std::uint64_t latest_time_us = 0U;
    const auto report_progress = [&]() {
        if (!options.progress_callback) return;
        ldm::DownloadProgress progress;
        progress.bytes_processed = latest_size;
        progress.percent_complete = media.duration_seconds > 0.0
            ? std::min(99.0, static_cast<double>(latest_time_us) / 1000000.0 / media.duration_seconds * 100.0)
            : 0.0;
        progress.phase = stream_type;
        progress.output_filename = target_path.filename().string();
        options.progress_callback(progress);
    };
    const auto parse_progress_line = [&](const std::string& line) {
        const auto separator = line.find('=');
        if (separator == std::string::npos) return;
        const std::string key = line.substr(0U, separator);
        const std::string value = line.substr(separator + 1U);
        if (key == "progress") { report_progress(); return; }
        try {
            if (key == "total_size") latest_size = std::stoull(value);
            else if (key == "out_time_us") latest_time_us = std::stoull(value);
        } catch (const std::exception&) {}
    };
    std::vector<std::string> command{
        "ffmpeg", "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-progress", "pipe:1", "-stats_period", "0.5"
    };
    configure_media_network(command, url);
    if (http_url) command.insert(command.end(), {
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"
    });
    if (!headers.empty()) command.insert(command.end(), {"-headers", headers});
    command.insert(command.end(), {"-i", url});
    if (video != nullptr) command.insert(command.end(), {"-map", "0:" + std::to_string(video->index)});
    if (audio != nullptr) command.insert(command.end(), {"-map", "0:" + std::to_string(audio->index)});
    command.insert(command.end(), {"-c", "copy"});
    if (audio_only) {
        if (format == "m4a" && audio->codec != "aac" && audio->codec != "alac") {
            command.insert(command.end(), {"-c:a", "aac", "-b:a", "192k"});
        } else if (format == "mp3" && audio->codec != "mp3") {
            command.insert(command.end(), {"-c:a", "libmp3lame", "-q:a", "2"});
        } else if (format == "opus" && audio->codec != "opus") {
            command.insert(command.end(), {"-c:a", "libopus", "-b:a", "160k"});
        }
    }
    if (format == "mp4" || format == "m4a") command.insert(command.end(), {"-movflags", "+faststart"});
    const std::string muxer = format == "mkv" ? "matroska" : format == "m4a" ? "ipod" : format;
    command.insert(command.end(), {"-f", muxer, temp_path.string()});
    try {
        report_progress();
        for (std::size_t attempt = 0U;; ++attempt) {
            if (attempt > 0U) { latest_size = 0U; latest_time_us = 0U; }
            std::error_code attempt_cleanup_error;
            std::filesystem::remove(temp_path, attempt_cleanup_error);
            if (attempt_cleanup_error) throw std::runtime_error("Unable to clear partial media output: " + attempt_cleanup_error.message());
            wait_until_running(options);
            const int status = run_process(command, parse_progress_line, options.cancellation_requested.get(),
                options.pause_requested.get(), std::chrono::seconds(std::max(0L, options.transfer_timeout_seconds)));
            if (status == 0) break;
            if (attempt >= retry_count(options)) {
                throw std::runtime_error("FFmpeg could not process this " + stream_type
                    + " stream after retries (exit " + std::to_string(status)
                    + "). The stream may be unsupported, encrypted, or unavailable.");
            }
            std::this_thread::sleep_for(retry_delay(options, attempt));
        }
        const std::uint64_t final_size = std::filesystem::file_size(temp_path);
        if (final_size == 0U) throw std::runtime_error("FFmpeg produced an empty media output");
        wait_until_running(options);
        std::filesystem::rename(temp_path, target_path);
        if (options.progress_callback) {
            ldm::DownloadProgress progress;
            progress.bytes_processed = final_size;
            progress.percent_complete = 100.0;
            progress.phase = stream_type;
            progress.output_filename = target_path.filename().string();
            options.progress_callback(progress);
        }
    } catch (...) {
        std::error_code cleanup_error;
        std::filesystem::remove(temp_path, cleanup_error);
        throw;
    }
}


size_t header_callback(char* data, size_t size, size_t nmemb, void* user_data) {
    if (size != 0U && nmemb > std::numeric_limits<size_t>::max() / size) {
        return 0U;
    }
    const size_t bytes = size * nmemb;
    if (bytes == 0U) {
        return 0U;
    }

    auto* headers = static_cast<std::vector<std::string>*>(user_data);
    headers->emplace_back(data, bytes);
    return bytes;
}

size_t discard_callback(char*, size_t size, size_t nmemb, void*) {
    if (size != 0U && nmemb > std::numeric_limits<size_t>::max() / size) {
        return 0U;
    }
    return size * nmemb == 1U ? 1U : 0U;
}

struct CurlSlistDeleter {
    void operator()(curl_slist* headers) const noexcept {
        curl_slist_free_all(headers);
    }
};

using CurlSlistHandle = std::unique_ptr<curl_slist, CurlSlistDeleter>;

bool has_custom_header(const ldm::DownloadOptions& options, const std::string& expected_name) {
    return std::any_of(options.custom_headers.begin(), options.custom_headers.end(),
        [&expected_name](const auto& header) {
            std::string name = header.first;
            std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
                return static_cast<char>(std::tolower(character));
            });
            return name == expected_name;
        });
}

CurlSlistHandle make_request_headers(const ldm::DownloadOptions& options,
    const std::string& additional_header = {}) {
    CurlSlistHandle headers;
    const auto append = [&headers](const std::string& line) {
        curl_slist* updated = curl_slist_append(headers.get(), line.c_str());
        if (updated == nullptr) {
            throw std::runtime_error("Unable to allocate HTTP request header");
        }
        static_cast<void>(headers.release());
        headers.reset(updated);
    };

    for (const auto& [name, value] : options.custom_headers) {
        if (name.empty() || name.find_first_of(":\r\n") != std::string::npos
            || value.find_first_of("\r\n") != std::string::npos) {
            throw std::invalid_argument("Custom HTTP header contains an invalid name or value");
        }
        append(name + ": " + value);
    }
    if (!additional_header.empty()) {
        append(additional_header);
    }
    return headers;
}

void configure_request_identity(CURL* curl,
    const ldm::DownloadOptions& options,
    const CurlSlistHandle& headers,
    CURLSH* cookie_store) {
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
    const std::string authorities = tls_ca_bundle();
    if (!authorities.empty()) curl_easy_setopt(curl, CURLOPT_CAINFO, authorities.c_str());
    curl_easy_setopt(curl, CURLOPT_SHARE, cookie_store);
    curl_easy_setopt(curl, CURLOPT_COOKIEFILE, "");
    if (!options.user_agent.empty() && !has_custom_header(options, "user-agent")) {
        curl_easy_setopt(curl, CURLOPT_USERAGENT, options.user_agent.c_str());
    }
    if (!options.cookies.empty() && !has_custom_header(options, "cookie")) {
        curl_easy_setopt(curl, CURLOPT_COOKIE, options.cookies.c_str());
    }
    if (!options.referer.empty() && !has_custom_header(options, "referer")) {
        curl_easy_setopt(curl, CURLOPT_REFERER, options.referer.c_str());
    }
    if (headers) {
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers.get());
    }
}

std::string header_value(const std::vector<std::string>& headers, const std::string& key) {
    for (auto iterator = headers.rbegin(); iterator != headers.rend(); ++iterator) {
        const auto colon = iterator->find(':');
        if (colon == std::string::npos) {
            continue;
        }
        std::string name = trim(iterator->substr(0U, colon));
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        if (name == key) {
            return trim(iterator->substr(colon + 1U));
        }
    }
    return {};
}

std::string disposition_parameter(const std::string& disposition, const std::string& parameter_name) {
    std::size_t position = 0U;
    while (position < disposition.size()) {
        const auto separator = disposition.find(';', position);
        if (separator == std::string::npos) {
            return {};
        }
        position = separator + 1U;
        while (position < disposition.size()
            && std::isspace(static_cast<unsigned char>(disposition[position])) != 0) {
            ++position;
        }
        const auto equals = disposition.find('=', position);
        const auto parameter_end = disposition.find(';', position);
        if (equals == std::string::npos
            || (parameter_end != std::string::npos && equals > parameter_end)) {
            if (parameter_end == std::string::npos) {
                return {};
            }
            position = parameter_end;
            continue;
        }

        std::string name = trim(disposition.substr(position, equals - position));
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        position = equals + 1U;

        std::string value;
        if (position < disposition.size() && disposition[position] == '"') {
            ++position;
            while (position < disposition.size()) {
                const char character = disposition[position++];
                if (character == '\\' && position < disposition.size()) {
                    value.push_back(disposition[position++]);
                } else if (character == '"') {
                    break;
                } else {
                    value.push_back(character);
                }
            }
            const auto next_separator = disposition.find(';', position);
            position = next_separator == std::string::npos ? disposition.size() : next_separator;
        } else {
            const auto next_separator = disposition.find(';', position);
            value = trim(disposition.substr(position, next_separator - position));
            position = next_separator == std::string::npos ? disposition.size() : next_separator;
        }
        if (name == parameter_name) {
            return value;
        }
    }
    return {};
}

std::string disposition_filename(const std::vector<std::string>& headers) {
    const std::string disposition = header_value(headers, "content-disposition");
    if (disposition.empty()) {
        return {};
    }
    std::string value = disposition_parameter(disposition, "filename*");
    if (!value.empty()) {
        const auto charset_end = value.find('\'');
        if (charset_end != std::string::npos) {
            const auto language_end = value.find('\'', charset_end + 1U);
            if (language_end != std::string::npos) {
                value = value.substr(language_end + 1U);
            }
        }
        value = percent_decode(value);
    } else {
        value = disposition_parameter(disposition, "filename");
    }
    return safe_filename(value);
}

bool is_http_url(const std::string& url) {
    const auto separator = url.find(':');
    if (separator == std::string::npos) {
        return false;
    }
    std::string scheme = url.substr(0U, separator);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return scheme == "http" || scheme == "https";
}

bool is_ftp_url(const std::string& url) {
    const auto separator = url.find(':');
    if (separator == std::string::npos) {
        return false;
    }
    std::string scheme = url.substr(0U, separator);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return scheme == "ftp" || scheme == "ftps";
}

class ProgressReporter {
public:
    ProgressReporter(const ldm::DownloadOptions& options,
        std::uint64_t total_bytes,
        std::uint64_t initial_bytes = 0U)
        : options_(options),
          total_bytes_(total_bytes),
          bytes_downloaded_(initial_bytes),
          initial_bytes_(initial_bytes),
          last_callback_at_(std::chrono::steady_clock::now()),
          started_at_(last_callback_at_),
          last_notification_ticks_(steady_ticks(last_callback_at_)),
          last_notified_bytes_(initial_bytes),
          interactive_(::isatty(STDERR_FILENO) != 0) {}

    ~ProgressReporter() {
        std::lock_guard<std::mutex> lock(notification_mutex_);
        if (rendered_ && !finished_) {
            std::cerr << '\n';
        }
    }

    void add(std::uint64_t bytes) {
        bytes_downloaded_.fetch_add(bytes, std::memory_order_relaxed);
        notify_if_due();
    }

    void set_total(std::uint64_t total_bytes) {
        if (total_bytes == 0U) {
            return;
        }
        total_bytes_.store(total_bytes, std::memory_order_relaxed);
        notify_if_due();
    }

    void set_output_filename(std::string filename) {
        std::lock_guard<std::mutex> lock(notification_mutex_);
        output_filename_ = std::move(filename);
    }

    void finish(std::uint64_t total_bytes) {
        if (total_bytes_.load(std::memory_order_relaxed) == 0U) {
            total_bytes_.store(total_bytes, std::memory_order_relaxed);
        }
        const std::uint64_t downloaded = bytes_downloaded_.load(std::memory_order_relaxed);
        if (downloaded > total_bytes_.load(std::memory_order_relaxed)) {
            total_bytes_.store(downloaded, std::memory_order_relaxed);
        }
        std::lock_guard<std::mutex> lock(notification_mutex_);
        finished_ = true;
        const auto now = std::chrono::steady_clock::now();
        const double elapsed = std::chrono::duration<double>(now - started_at_).count();
        if (elapsed > 0.0 && downloaded >= initial_bytes_) {
            speed_bytes_per_second_ = static_cast<double>(downloaded - initial_bytes_) / elapsed;
        }
        last_callback_at_ = now;
        last_notified_bytes_ = downloaded;
        report_callback_locked(downloaded, total_bytes_.load(std::memory_order_relaxed));
        render_locked(true, downloaded, total_bytes_.load(std::memory_order_relaxed));
        if (rendered_) {
            std::cerr << '\n';
        }
    }

private:
    static std::int64_t steady_ticks(std::chrono::steady_clock::time_point time) {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
            time.time_since_epoch()).count();
    }

    static std::string format_size(double bytes) {
        constexpr double kibibyte = 1024.0;
        constexpr double mebibyte = kibibyte * 1024.0;
        std::ostringstream formatted;
        formatted << std::fixed << std::setprecision(1);
        if (bytes >= mebibyte) {
            formatted << bytes / mebibyte << " MB";
        } else {
            formatted << bytes / kibibyte << " KB";
        }
        return formatted.str();
    }

    static std::string format_eta(double seconds) {
        if (!std::isfinite(seconds) || seconds < 0.0) {
            return "--:--:--";
        }
        const auto remaining = static_cast<std::uint64_t>(std::ceil(seconds));
        const auto hours = remaining / 3600U;
        const auto minutes = (remaining % 3600U) / 60U;
        const auto secs = remaining % 60U;
        std::ostringstream formatted;
        formatted << std::setfill('0') << std::setw(2) << hours << ':'
                  << std::setw(2) << minutes << ':' << std::setw(2) << secs;
        return formatted.str();
    }

    void notify_if_due() {
        const auto now = std::chrono::steady_clock::now();
        const std::int64_t now_ticks = steady_ticks(now);
        std::int64_t previous_ticks = last_notification_ticks_.load(std::memory_order_relaxed);
        const std::int64_t interval_ticks =
            std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::milliseconds(100)).count();
        if (now_ticks - previous_ticks < interval_ticks) {
            return;
        }
        if (!last_notification_ticks_.compare_exchange_strong(
                previous_ticks, now_ticks, std::memory_order_relaxed)) {
            return;
        }

        std::lock_guard<std::mutex> lock(notification_mutex_);
        const std::uint64_t downloaded = bytes_downloaded_.load(std::memory_order_relaxed);
        const std::uint64_t total = total_bytes_.load(std::memory_order_relaxed);
        update_speed_locked(now, downloaded);
        report_callback_locked(downloaded, total);
        render_locked(false, downloaded, total);
    }

    void update_speed_locked(std::chrono::steady_clock::time_point now, std::uint64_t downloaded) {
        const double elapsed = std::chrono::duration<double>(now - last_callback_at_).count();
        if (elapsed > 0.0) {
            const std::uint64_t delta = downloaded >= last_notified_bytes_
                ? downloaded - last_notified_bytes_
                : 0U;
            speed_bytes_per_second_ = static_cast<double>(delta) / elapsed;
        }
        last_callback_at_ = now;
        last_notified_bytes_ = downloaded;
    }

    void report_callback_locked(std::uint64_t downloaded, std::uint64_t total) {
        if (!options_.progress_callback) {
            return;
        }
        ldm::DownloadProgress progress;
        progress.bytes_downloaded = downloaded;
        progress.total_bytes = total;
        progress.percent_complete = total == 0U
            ? (finished_ ? 100.0 : 0.0)
            : std::min(100.0, 100.0 * static_cast<double>(downloaded) / static_cast<double>(total));
        progress.bytes_per_second = speed_bytes_per_second_;
        progress.output_filename = output_filename_;
        options_.progress_callback(progress);
    }

    void render_locked(bool force, std::uint64_t downloaded, std::uint64_t total) {
        const auto now = std::chrono::steady_clock::now();
        if (!interactive_ && !force) {
            return;
        }
        if (!force && rendered_ && now - last_render_at_ < std::chrono::milliseconds(100)) {
            return;
        }

        const double percent = total == 0U
            ? (finished_ ? 100.0 : 0.0)
            : std::min(100.0, 100.0 * static_cast<double>(downloaded) / static_cast<double>(total));
        constexpr std::size_t bar_width = 30U;
        const std::size_t filled = total == 0U
            ? 0U
            : std::min(bar_width, static_cast<std::size_t>(percent * static_cast<double>(bar_width) / 100.0));
        const double eta = speed_bytes_per_second_ > 0.0 && total > downloaded
            ? static_cast<double>(total - downloaded) / speed_bytes_per_second_
            : (finished_ ? 0.0 : std::numeric_limits<double>::infinity());

        std::ostringstream line;
        line << '\r' << '[' << std::string(filled, '=') << std::string(bar_width - filled, ' ')
             << "] " << std::fixed << std::setprecision(1) << percent << "% "
             << format_size(static_cast<double>(downloaded));
        if (total > 0U) {
            line << '/' << format_size(static_cast<double>(total));
        }
        line << " | " << format_size(speed_bytes_per_second_) << "/s"
             << " | ETA " << format_eta(eta);
        if (interactive_) {
            line << "\033[K";
        }
        std::cerr << line.str() << std::flush;

        rendered_ = true;
        last_render_at_ = now;
    }

    const ldm::DownloadOptions& options_;
    std::atomic<std::uint64_t> total_bytes_;
    std::atomic<std::uint64_t> bytes_downloaded_;
    std::uint64_t initial_bytes_;
    double speed_bytes_per_second_ = 0.0;
    std::chrono::steady_clock::time_point last_callback_at_;
    std::chrono::steady_clock::time_point started_at_;
    std::chrono::steady_clock::time_point last_render_at_{};
    std::atomic<std::int64_t> last_notification_ticks_;
    std::uint64_t last_notified_bytes_;
    std::string output_filename_;
    bool interactive_;
    bool rendered_ = false;
    bool finished_ = false;
    std::mutex notification_mutex_;
};

struct FileWriteContext {
    FILE* output;
    ProgressReporter* progress;
    const std::atomic_bool* cancellation_requested;
    const std::atomic_bool* pause_requested;
    std::exception_ptr callback_exception;
    long timeout_seconds = 0;
    bool report_transfer_total = true;
    std::chrono::steady_clock::time_point started_at = std::chrono::steady_clock::now();
    std::chrono::steady_clock::duration paused_time{};
};

bool wait_for_transfer(FileWriteContext& context) {
    const auto before = std::chrono::steady_clock::now();
    const bool was_paused = context.pause_requested != nullptr
        && context.pause_requested->load(std::memory_order_relaxed);
    if (!wait_until_running(context.pause_requested, context.cancellation_requested)) return false;
    const auto now = std::chrono::steady_clock::now();
    if (was_paused) context.paused_time += now - before;
    if (context.timeout_seconds > 0
        && now - context.started_at - context.paused_time > std::chrono::seconds(context.timeout_seconds)) {
        context.callback_exception = std::make_exception_ptr(std::runtime_error("Transfer exceeded its active time limit"));
        return false;
    }
    return true;
}

struct FileCloser {
    void operator()(FILE* file) const noexcept {
        if (file != nullptr) {
            std::fclose(file);
        }
    }
};

int transfer_progress_callback(void* user_data,
    curl_off_t download_total,
    curl_off_t,
    curl_off_t,
    curl_off_t) {
    auto* context = static_cast<FileWriteContext*>(user_data);
    if (!wait_for_transfer(*context)) return 1;
    if (download_total > 0 && context->report_transfer_total) {
        try {
            context->progress->set_total(static_cast<std::uint64_t>(download_total));
        } catch (...) {
            context->callback_exception = std::current_exception();
            return 1;
        }
    }
    return 0;
}

int cancellation_check_callback(void* user_data, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
    auto* context = static_cast<FileWriteContext*>(user_data);
    return wait_for_transfer(*context) ? 0 : 1;
}

size_t file_write_callback(char* data, size_t size, size_t nmemb, void* user_data) {
    auto* context = static_cast<FileWriteContext*>(user_data);
    if (!wait_for_transfer(*context)) return 0U;
    if (size != 0U && nmemb > std::numeric_limits<size_t>::max() / size) {
        return 0U;
    }
    const size_t bytes_to_write = size * nmemb;
    if (bytes_to_write == 0U) {
        return 0U;
    }

    const size_t written = std::fwrite(data, 1U, bytes_to_write, context->output);
    if (written != bytes_to_write) {
        try {
            throw std::runtime_error("Failed writing downloaded data to disk");
        } catch (...) {
            context->callback_exception = std::current_exception();
        }
        return 0U;
    }

    try {
        context->progress->add(static_cast<std::uint64_t>(written));
    } catch (...) {
        context->callback_exception = std::current_exception();
        return 0U;
    }
    return bytes_to_write;
}

void copy_stream(std::istream& input, std::ostream& output, const ldm::DownloadOptions& options) {
    std::array<char, kChunkBufferSize> buffer{};
    while (input) {
        wait_until_running(options);
        input.read(buffer.data(), static_cast<std::streamsize>(buffer.size()));
        const std::streamsize bytes_read = input.gcount();
        if (bytes_read > 0) {
            output.write(buffer.data(), bytes_read);
        }
    }
    if (input.bad() || !input.eof() || !output) {
        throw std::runtime_error("Failed while assembling downloaded chunks");
    }
}

struct ServerMetadata {
    std::uint64_t content_length = 0U;
    bool supports_ranges = false;
    long response_code = 0L;
    std::string filename;
    std::string validator;
};

struct ResumeState {
    std::uint64_t url_fingerprint = 0U;
    std::uint64_t total_bytes = 0U;
    std::size_t chunk_count = 0U;
    std::uint64_t chunk_size = 0U;
    std::string validator;
};

std::uint64_t fingerprint_url(const std::string& url) {
    std::uint64_t hash = 14695981039346656037ULL;
    for (const unsigned char character : url) {
        hash ^= character;
        hash *= 1099511628211ULL;
    }
    return hash;
}

bool resume_state_matches(const std::filesystem::path& state_path, const ResumeState& expected) {
    std::ifstream input(state_path);
    ResumeState stored;
    unsigned version = 0U;
    const bool parsed = static_cast<bool>(input >> version >> stored.url_fingerprint
        >> stored.total_bytes >> stored.chunk_count >> stored.chunk_size
        >> std::quoted(stored.validator));
    return parsed
        && version == 2U
        && stored.url_fingerprint == expected.url_fingerprint
        && stored.total_bytes == expected.total_bytes
        && stored.chunk_count == expected.chunk_count
        && stored.chunk_size == expected.chunk_size
        && stored.validator == expected.validator;
}

void save_resume_state(const std::filesystem::path& state_path, const ResumeState& state) {
    const std::filesystem::path temporary_path = state_path.string() + ".tmp";
    {
        std::ofstream output(temporary_path, std::ios::trunc);
        if (!output) {
            throw std::runtime_error("Unable to create download resume metadata");
        }
        output << 2U << ' ' << state.url_fingerprint << ' ' << state.total_bytes << ' '
               << state.chunk_count << ' ' << state.chunk_size << ' '
               << std::quoted(state.validator) << '\n';
        output.flush();
        if (!output) {
            throw std::runtime_error("Unable to write download resume metadata");
        }
    }
    std::filesystem::rename(temporary_path, state_path);
}

std::chrono::milliseconds retry_delay(const ldm::DownloadOptions& options, std::size_t attempt) {
    const std::size_t shift = std::min<std::size_t>(attempt, 10U);
    const std::size_t delay_ms = options.retry_backoff_milliseconds > (30000U >> shift)
        ? 30000U
        : std::min<std::size_t>(
            options.retry_backoff_milliseconds * (std::size_t{1} << shift), 30000U);
    return std::chrono::milliseconds(delay_ms);
}

std::size_t retry_count(const ldm::DownloadOptions& options) {
    return std::min<std::size_t>(options.max_retries, 5U);
}

bool retryable_http_status(long status) {
    return status == 408L || status == 425L || status == 429L || status >= 500L;
}

bool retryable_curl_error(CURLcode code) {
    switch (code) {
        case CURLE_COULDNT_CONNECT:
        case CURLE_COULDNT_RESOLVE_HOST:
        case CURLE_OPERATION_TIMEDOUT:
        case CURLE_RECV_ERROR:
        case CURLE_SEND_ERROR:
        case CURLE_PARTIAL_FILE:
        case CURLE_GOT_NOTHING:
        case CURLE_SSL_CONNECT_ERROR:
        case CURLE_HTTP2:
        case CURLE_HTTP2_STREAM:
            return true;
        default:
            return false;
    }
}

bool retryable_stream_error(const std::string& message) {
    const std::string status_prefix = "Server returned HTTP ";
    if (message.rfind(status_prefix, 0U) == 0U) {
        try {
            const long status = std::stol(message.substr(status_prefix.size()));
            return retryable_http_status(status);
        } catch (const std::exception&) {
            return false;
        }
    }
    return false;
}

ServerMetadata probe_server(const std::string& url,
    const ldm::DownloadOptions& options,
    CURLSH* cookie_store) {
    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), &curl_easy_cleanup);
    if (!curl) {
        throw std::runtime_error("Failed to initialize libcurl");
    }

    std::vector<std::string> response_headers;
    const CurlSlistHandle request_headers = make_request_headers(options);
    curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl.get(), CURLOPT_NOBODY, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_HEADERFUNCTION, &header_callback);
    curl_easy_setopt(curl.get(), CURLOPT_HEADERDATA, &response_headers);
    curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, options.connect_timeout_seconds);
    curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 0L);
    configure_request_identity(curl.get(), options, request_headers, cookie_store);
    FileWriteContext probe_context{nullptr, nullptr, options.cancellation_requested.get(), options.pause_requested.get(), {}};
    probe_context.timeout_seconds = options.transfer_timeout_seconds > 0
        ? options.transfer_timeout_seconds : options.connect_timeout_seconds + 30L;
    curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, &cancellation_check_callback);
    curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &probe_context);
    curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);

    const bool http_url = is_http_url(url);
    const bool ftp_url = is_ftp_url(url);
    const CURLcode result = curl_easy_perform(curl.get());
    if (probe_context.callback_exception) std::rethrow_exception(probe_context.callback_exception);
    if (result == CURLE_ABORTED_BY_CALLBACK && options.cancellation_requested
        && options.cancellation_requested->load(std::memory_order_relaxed)) {
        throw ldm::DownloadCancelled();
    }

    ServerMetadata metadata;
    if (result == CURLE_OK) {
        curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &metadata.response_code);
    }
    metadata.filename = disposition_filename(response_headers);
    metadata.validator = header_value(response_headers, "etag");
    if (metadata.validator.rfind("W/", 0U) == 0U) {
        metadata.validator.clear();
    }
    if (metadata.validator.empty()) {
        metadata.validator = header_value(response_headers, "last-modified");
    }
    std::string content_length = header_value(response_headers, "content-length");
    if (!content_length.empty()) {
        try {
            metadata.content_length = static_cast<std::uint64_t>(std::stoull(content_length));
        } catch (const std::exception&) {
            metadata.content_length = 0U;
        }
    }
    std::string accepted_ranges = header_value(response_headers, "accept-ranges");
    std::transform(accepted_ranges.begin(), accepted_ranges.end(), accepted_ranges.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    metadata.supports_ranges = (accepted_ranges == "bytes");
    curl_off_t remote_size = 0;
    curl_easy_getinfo(curl.get(), CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &remote_size);
    if (remote_size > 0 && metadata.content_length == 0U) {
        metadata.content_length = static_cast<std::uint64_t>(remote_size);
    }

    const bool head_unusable = result != CURLE_OK
        || metadata.response_code < 200L || metadata.response_code >= 400L;
    const std::uint64_t configured_chunk_size =
        static_cast<std::uint64_t>(std::max<std::size_t>(1U, options.chunk_size));
    const bool range_verification_needed = metadata.content_length > configured_chunk_size;
    if ((http_url && (head_unusable
            || (metadata.content_length > 0U && (!metadata.supports_ranges || range_verification_needed))))
        || (ftp_url && metadata.content_length > 0U && !metadata.supports_ranges)) {
        if (head_unusable) {
            metadata.content_length = 0U;
            metadata.filename.clear();
            metadata.validator.clear();
        }
        response_headers.clear();
        curl_easy_setopt(curl.get(), CURLOPT_NOBODY, 0L);
        curl_easy_setopt(curl.get(), CURLOPT_RANGE, "0-0");
        curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, &discard_callback);
        curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, nullptr);
        const CURLcode range_result = curl_easy_perform(curl.get());
        if (probe_context.callback_exception) std::rethrow_exception(probe_context.callback_exception);
        if (range_result == CURLE_ABORTED_BY_CALLBACK && options.cancellation_requested
            && options.cancellation_requested->load(std::memory_order_relaxed)) {
            throw ldm::DownloadCancelled();
        }
        long range_response_code = 0L;
        curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &range_response_code);
        // The probe callback intentionally aborts a successful non-range 200
        // response after its first body block. Its response headers still
        // provide enough metadata to fall back to a single streaming request.
        const bool intentionally_aborted_non_range_response = range_result == CURLE_WRITE_ERROR
            && range_response_code >= 200L && range_response_code < 300L;
        if (range_result == CURLE_OK || intentionally_aborted_non_range_response) {
            metadata.response_code = range_response_code;
            const std::string range_header = trim(header_value(response_headers, "content-range"));
            std::string normalized_range_header = range_header;
            std::transform(normalized_range_header.begin(), normalized_range_header.end(),
                normalized_range_header.begin(), [](unsigned char character) {
                    return static_cast<char>(std::tolower(character));
                });
            curl_off_t range_size = 0;
            curl_easy_getinfo(curl.get(), CURLINFO_SIZE_DOWNLOAD_T, &range_size);
            std::uint64_t range_total = 0U;
            bool valid_single_byte_range = false;
            constexpr const char* kSingleByteRangePrefix = "bytes 0-0/";
            if (normalized_range_header.rfind(kSingleByteRangePrefix, 0U) == 0U) {
                const std::string total_text = normalized_range_header.substr(std::strlen(kSingleByteRangePrefix));
                try {
                    std::size_t parsed = 0U;
                    range_total = static_cast<std::uint64_t>(std::stoull(total_text, &parsed));
                    valid_single_byte_range = parsed == total_text.size() && range_total > 0U;
                } catch (const std::exception&) {
                    range_total = 0U;
                }
            }
            metadata.supports_ranges = http_url
                ? metadata.response_code == 206L && valid_single_byte_range
                : range_size == 1;
            if (valid_single_byte_range) {
                metadata.content_length = range_total;
            } else if (http_url && metadata.response_code == 206L) {
                metadata.content_length = 0U;
            }
            const std::string range_filename = disposition_filename(response_headers);
            if (!range_filename.empty()) metadata.filename = range_filename;
            if (http_url && metadata.response_code != 206L) {
                const std::string range_content_length = header_value(response_headers, "content-length");
                if (!range_content_length.empty()) {
                    try {
                        metadata.content_length = static_cast<std::uint64_t>(std::stoull(range_content_length));
                    } catch (const std::exception&) {
                        metadata.content_length = 0U;
                    }
                }
            }
            std::string range_validator = header_value(response_headers, "etag");
            if (range_validator.rfind("W/", 0U) == 0U) {
                range_validator.clear();
            }
            if (range_validator.empty()) {
                range_validator = header_value(response_headers, "last-modified");
            }
            if (!range_validator.empty()) metadata.validator = range_validator;
        }
        if (http_url && metadata.response_code == 0L
            && range_result != CURLE_OK && !intentionally_aborted_non_range_response) {
            throw std::runtime_error("HTTP metadata probe failed: "
                + std::string(curl_easy_strerror(range_result)));
        }
    }

    if (http_url && metadata.response_code >= 400L) {
        throw std::runtime_error("Server rejected the probe request (HTTP "
            + std::to_string(metadata.response_code) + ")");
    }
    return metadata;
}

void download_stream_to_file(const std::string& url,
    const std::filesystem::path& output_path,
    const ldm::DownloadOptions& options,
    ProgressReporter& progress,
    std::uint64_t expected_bytes,
    std::uint64_t& total_bytes_written,
    std::string& error_message,
    bool& retryable_error,
    CURLSH* cookie_store) {
    total_bytes_written = 0U;
    retryable_error = false;
    using FileHandle = std::unique_ptr<FILE, FileCloser>;
    FileHandle output_file(std::fopen(output_path.c_str(), "wb"));
    if (!output_file) {
        throw std::runtime_error("Unable to open output file for writing: " + std::string(std::strerror(errno)));
    }

    std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), &curl_easy_cleanup);
    if (!curl) {
        throw std::runtime_error("Unable to initialize libcurl");
    }
    FileWriteContext write_context{output_file.get(), &progress, options.cancellation_requested.get(), options.pause_requested.get(), {}};
    write_context.timeout_seconds = options.transfer_timeout_seconds;
    const CurlSlistHandle request_headers = make_request_headers(options);

    try {
        curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, &file_write_callback);
        curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &write_context);
        curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, &transfer_progress_callback);
        curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &write_context);
        curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
        configure_request_identity(curl.get(), options, request_headers, cookie_store);
        curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, options.connect_timeout_seconds);
        curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 0L);
        curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);

        const CURLcode result = curl_easy_perform(curl.get());
        if (result != CURLE_OK) {
            if (write_context.callback_exception) {
                std::rethrow_exception(write_context.callback_exception);
            }
            if (options.cancellation_requested
                && options.cancellation_requested->load(std::memory_order_relaxed)) {
                throw ldm::DownloadCancelled();
            }
            retryable_error = retryable_curl_error(result);
            const std::string detail = std::string(curl_easy_strerror(result));
            throw std::runtime_error("Download failed: " + detail);
        }

        long http_code = 0;
        curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &http_code);
        curl_off_t bytes_received = 0;
        curl_easy_getinfo(curl.get(), CURLINFO_SIZE_DOWNLOAD_T, &bytes_received);

        if (http_code >= 400L) {
            throw std::runtime_error("Server returned HTTP " + std::to_string(http_code));
        }

        if (bytes_received < 0) {
            throw std::runtime_error("Download returned an invalid byte count");
        }
        if (expected_bytes > 0U
            && static_cast<std::uint64_t>(bytes_received) != expected_bytes) {
            throw std::runtime_error("Downloaded size did not match the size reported by the server");
        }
        if (std::fflush(output_file.get()) != 0 || std::ferror(output_file.get()) != 0) {
            throw std::runtime_error("Failed writing download to disk");
        }
        total_bytes_written = std::filesystem::file_size(output_path);
    } catch (const std::exception& error) {
        error_message = error.what();
        throw;
    }
}

void download_chunk(const std::string& url,
    const std::filesystem::path& chunk_path,
    std::uint64_t start_range,
    std::uint64_t end_range,
    std::uint64_t total_bytes,
    const ldm::DownloadOptions& options,
    bool resume_partial_chunks,
    const std::string& validator,
    ProgressReporter& progress,
    std::uint64_t& bytes_written,
    std::string& error_message,
    CURLSH* cookie_store) {
    bytes_written = 0U;
    error_message.clear();
    const std::uint64_t expected_bytes = end_range - start_range + 1U;
    const bool http_url = is_http_url(url);

    const std::size_t max_retries = retry_count(options);
    for (std::size_t attempt = 0U; attempt <= max_retries; ++attempt) {
        throw_if_cancelled(options);
        std::error_code filesystem_error;
        std::uint64_t existing_bytes = 0U;
        if (resume_partial_chunks && std::filesystem::exists(chunk_path, filesystem_error)) {
            existing_bytes = std::filesystem::file_size(chunk_path, filesystem_error);
            if (filesystem_error || existing_bytes > expected_bytes) {
                std::filesystem::remove(chunk_path);
                existing_bytes = 0U;
            }
        } else if (!resume_partial_chunks) {
            std::filesystem::remove(chunk_path);
        }
        if (existing_bytes == expected_bytes) {
            bytes_written = existing_bytes;
            return;
        }

        const std::uint64_t request_start = start_range + existing_bytes;
        const std::string range_value = std::to_string(request_start) + "-" + std::to_string(end_range);
        using FileHandle = std::unique_ptr<FILE, FileCloser>;
        FileHandle output_file(std::fopen(chunk_path.c_str(), existing_bytes == 0U ? "wb" : "ab"));
        if (!output_file) {
            throw std::runtime_error("Unable to open temporary chunk file: " + std::string(std::strerror(errno)));
        }

        std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> curl(curl_easy_init(), &curl_easy_cleanup);
        if (!curl) {
            throw std::runtime_error("Failed to initialize worker libcurl handle");
        }
        FileWriteContext write_context{output_file.get(), &progress, options.cancellation_requested.get(), options.pause_requested.get(), {}};
        write_context.timeout_seconds = options.transfer_timeout_seconds;
        // curl's range dltotal describes this chunk, while the shared reporter
        // already knows the complete file length from the metadata probe.
        write_context.report_transfer_total = false;
        std::vector<std::string> response_headers;
        std::string if_range_header;
        if (http_url && !validator.empty()) {
            if_range_header = "If-Range: " + validator;
        }
        const CurlSlistHandle request_headers = make_request_headers(options, if_range_header);

        curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl.get(), CURLOPT_RANGE, range_value.c_str());
        curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, &file_write_callback);
        curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &write_context);
        curl_easy_setopt(curl.get(), CURLOPT_XFERINFOFUNCTION, &transfer_progress_callback);
        curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, &write_context);
        curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(curl.get(), CURLOPT_HEADERFUNCTION, &header_callback);
        curl_easy_setopt(curl.get(), CURLOPT_HEADERDATA, &response_headers);
        configure_request_identity(curl.get(), options, request_headers, cookie_store);
        curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, options.connect_timeout_seconds);
        curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 0L);
        curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(curl.get(), CURLOPT_FAILONERROR, 1L);
        const CURLcode result = curl_easy_perform(curl.get());
        long http_code = 0L;
        curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &http_code);
        if (std::fflush(output_file.get()) != 0 || std::ferror(output_file.get()) != 0) {
            throw std::runtime_error("Failed writing download chunk to disk");
        }
        output_file.reset();

        if (write_context.callback_exception) {
            std::rethrow_exception(write_context.callback_exception);
        }
        if (options.cancellation_requested
            && options.cancellation_requested->load(std::memory_order_relaxed)) {
            if (!resume_partial_chunks) std::filesystem::remove(chunk_path);
            throw ldm::DownloadCancelled();
        }

        if (http_url && http_code >= 400L) {
            const bool retryable_status = retryable_http_status(http_code);
            if (!retryable_status) {
                std::filesystem::remove(chunk_path);
                throw std::runtime_error("Range request rejected (HTTP " + std::to_string(http_code) + ")");
            }
            std::error_code truncate_error;
            const bool chunk_exists = std::filesystem::exists(chunk_path, truncate_error);
            if (truncate_error) {
                throw std::runtime_error("Unable to inspect partial chunk after HTTP error: "
                    + truncate_error.message());
            }
            if (chunk_exists) {
                std::filesystem::resize_file(chunk_path, existing_bytes, truncate_error);
                if (truncate_error) {
                    throw std::runtime_error("Unable to preserve partial chunk after HTTP error: "
                        + truncate_error.message());
                }
            }
            if (attempt == max_retries) {
                throw std::runtime_error("Range request failed after retries (HTTP "
                    + std::to_string(http_code) + ")");
            }
            std::this_thread::sleep_for(retry_delay(options, attempt));
            continue;
        }

        if (result != CURLE_OK) {
            if (retryable_curl_error(result)) {
                if (attempt == max_retries) {
                    std::filesystem::remove(chunk_path);
                    throw std::runtime_error("Range request failed after retries: "
                        + std::string(curl_easy_strerror(result)));
                }
                std::this_thread::sleep_for(retry_delay(options, attempt));
                continue;
            }
            std::filesystem::remove(chunk_path);
            throw std::runtime_error("Range request failed: " + std::string(curl_easy_strerror(result)));
        }

        const std::uint64_t current_size = std::filesystem::file_size(chunk_path);
        if (result == CURLE_OK && (!http_url || http_code == 206L)) {
            if (http_url) {
                const std::string expected_range = "bytes " + std::to_string(request_start) + "-"
                    + std::to_string(end_range) + "/" + std::to_string(total_bytes);
                std::string actual_range = trim(header_value(response_headers, "content-range"));
                std::transform(actual_range.begin(), actual_range.end(), actual_range.begin(),
                    [](unsigned char character) {
                        return static_cast<char>(std::tolower(character));
                    });
                if (actual_range != expected_range) {
                    std::filesystem::remove(chunk_path);
                    throw std::runtime_error("Server returned an unexpected Content-Range for a chunk");
                }
            }
            if (current_size == expected_bytes) {
                bytes_written = current_size;
                return;
            }
            if (current_size > expected_bytes) {
                std::filesystem::remove(chunk_path);
                throw std::runtime_error("Server returned more data than the requested byte range");
            }
        } else if (result == CURLE_OK && http_url && http_code != 206L) {
            std::filesystem::remove(chunk_path);
            throw std::runtime_error("Server ignored the requested byte range (HTTP "
                + std::to_string(http_code) + ")");
        }

        if (attempt == max_retries) {
            const std::string detail = result == CURLE_OK
                ? "received an incomplete range response (HTTP " + std::to_string(http_code) + ")"
                : curl_easy_strerror(result);
            throw std::runtime_error("Chunk download failed after retries: " + detail);
        }

        std::this_thread::sleep_for(retry_delay(options, attempt));
    }
}

}  // namespace

namespace ldm {

MediaInspection inspect_media(const std::string& url, const DownloadOptions& options) {
    return inspect_media_impl(url, options);
}

Downloader::Downloader(DownloadOptions options) : options_(std::move(options)) {}

void Downloader::download(const std::string& url) const {
    wait_until_running(options_);
    if (url.empty() || url.find('\0') != std::string::npos) {
        throw std::invalid_argument("Download URL cannot be empty or contain a null byte");
    }
    if (options_.video_stream_index < -1 || options_.audio_stream_index < -1) {
        throw std::invalid_argument("Stream indices must be nonnegative or -1 for automatic selection");
    }

    std::string manifest_format = options_.manifest_format;
    if (manifest_format.empty()) {
        if (is_dash_url(url)) {
            manifest_format = "dash";
        } else if (is_hls_url(url)) {
            manifest_format = "hls";
        }
    }
    if (!manifest_format.empty()) {
        if (manifest_format != "hls" && manifest_format != "dash") {
            throw std::invalid_argument("Manifest format must be 'hls' or 'dash'");
        }
        download_manifest(url, options_, manifest_format);
        return;
    }

    if (options_.audio_only || options_.video_stream_index >= 0 || options_.audio_stream_index >= 0
        || (!options_.output_format.empty() && options_.output_format != "mp4")) {
        download_manifest(url, options_, "media");
        return;
    }
    initialize_curl();

    SharedCookieStore cookie_store;
    const ServerMetadata metadata = probe_server(url, options_, cookie_store.get());
    throw_if_cancelled(options_);
    const std::string file_path = resolve_output_path(url, options_.output_path, metadata.filename);
    std::filesystem::path target_path(file_path);
    const std::filesystem::path parent_path = target_path.parent_path();
    if (!parent_path.empty()) {
        std::filesystem::create_directories(parent_path);
    }
    OutputPathReservation output_reservation = reserve_output_path(target_path);
    target_path = output_reservation.target_path();

    const std::filesystem::path temp_path = target_path.string() + ".part";
    std::filesystem::remove(temp_path);

    const std::uint64_t total_size = metadata.content_length;
    const std::uint64_t configured_chunk_size =
        static_cast<std::uint64_t>(std::max<std::size_t>(1U, options_.chunk_size));

    if (total_size == 0U || total_size <= configured_chunk_size || !metadata.supports_ranges) {
        for (std::size_t attempt = 0U;; ++attempt) {
            ProgressReporter progress(options_, total_size);
            progress.set_output_filename(target_path.filename().string());
            std::uint64_t bytes_written = 0U;
            std::string error_message;
            bool retryable_error = false;
            try {
                throw_if_cancelled(options_);
                download_stream_to_file(url, temp_path, options_, progress, total_size, bytes_written,
                    error_message, retryable_error, cookie_store.get());
                wait_until_running(options_);
                std::filesystem::rename(temp_path, target_path);
                progress.finish(bytes_written);
                return;
            } catch (const ldm::DownloadCancelled&) {
                std::filesystem::remove(temp_path);
                throw;
            } catch (const std::exception& error) {
                std::filesystem::remove(temp_path);
                const std::string message = error_message.empty() ? error.what() : error_message;
                if (attempt >= retry_count(options_)
                    || (!retryable_error && !retryable_stream_error(message))) {
                    throw std::runtime_error(message);
                }
                std::this_thread::sleep_for(retry_delay(options_, attempt));
            }
        }
    }

    const std::uint64_t connection_limit = static_cast<std::uint64_t>(
        std::clamp<std::size_t>(options_.max_connections, 1U, 256U));
    const std::uint64_t desired_chunks = total_size / configured_chunk_size
        + (total_size % configured_chunk_size == 0U ? 0U : 1U);
    const std::uint64_t chunk_count_u64 = std::min(desired_chunks, connection_limit);
    if (chunk_count_u64 > std::numeric_limits<std::size_t>::max()) {
        throw std::runtime_error("Download requires too many chunks for this platform");
    }
    const std::size_t chunk_count = static_cast<std::size_t>(chunk_count_u64);
    const std::uint64_t chunk_count_as_u64 = chunk_count_u64;

    std::vector<std::filesystem::path> chunk_paths(chunk_count);
    for (std::size_t index = 0U; index < chunk_count; ++index) {
        chunk_paths[index] = target_path.string() + ".part." + std::to_string(index);
    }
    std::vector<std::string> chunk_errors(chunk_count);
    const std::filesystem::path state_path = target_path.string() + ".part.meta";
    const ResumeState resume_state{
        fingerprint_url(url), total_size, chunk_count, configured_chunk_size, metadata.validator};
    // A URL and byte count alone cannot prove that old chunks still match the
    // server's current object. Persist/resume chunks only with a server validator.
    const bool resume_enabled = options_.resume_partial_downloads && !metadata.validator.empty();
    const bool resume = resume_enabled
        && resume_state_matches(state_path, resume_state);
    if (!resume) {
        for (const auto& path : chunk_paths) {
            std::filesystem::remove(path);
        }
        std::filesystem::remove(state_path);
    }
    if (resume_enabled) {
        save_resume_state(state_path, resume_state);
    }
    std::uint64_t initially_downloaded = 0U;
    for (std::size_t index = 0U; index < chunk_count; ++index) {
        std::error_code size_error;
        const std::uint64_t chunk_size = total_size / chunk_count_u64
            + (static_cast<std::uint64_t>(index) < total_size % chunk_count_u64 ? 1U : 0U);
        const std::uint64_t current_size = std::filesystem::exists(chunk_paths[index], size_error)
            ? std::filesystem::file_size(chunk_paths[index], size_error)
            : 0U;
        if (size_error || current_size > chunk_size) {
            std::filesystem::remove(chunk_paths[index]);
            continue;
        }
        initially_downloaded += current_size;
    }
    ProgressReporter progress(options_, total_size, initially_downloaded);
    progress.set_output_filename(target_path.filename().string());
    std::vector<std::thread> workers;
    workers.reserve(chunk_count);

    try {
        for (std::size_t index = 0U; index < chunk_count; ++index) {
            workers.emplace_back([&, index]() {
                const std::uint64_t chunk_index = static_cast<std::uint64_t>(index);
                const std::uint64_t base_chunk_size = total_size / chunk_count_as_u64;
                const std::uint64_t larger_chunk_count = total_size % chunk_count_as_u64;
                const std::uint64_t start =
                    chunk_index * base_chunk_size + std::min(chunk_index, larger_chunk_count);
                const std::uint64_t this_chunk_size =
                    base_chunk_size + (chunk_index < larger_chunk_count ? 1U : 0U);
                const std::uint64_t end = start + this_chunk_size - 1U;
                try {
                    std::uint64_t written = 0U;
                    std::string error_message;
                    download_chunk(url, chunk_paths[index], start, end, total_size, options_, resume_enabled,
                        metadata.validator, progress, written, error_message, cookie_store.get());
                    const std::uint64_t expected_bytes = this_chunk_size;
                    if (written != expected_bytes) {
                        throw std::runtime_error("Chunk download size did not match the requested byte range");
                    }
                } catch (const std::exception& error) {
                    chunk_errors[index] = error.what();
                } catch (...) {
                    chunk_errors[index] = "Chunk download failed with a non-standard exception";
                }
            });
        }
    } catch (...) {
        for (std::thread& worker : workers) {
            if (worker.joinable()) {
                worker.join();
            }
        }
        if (!resume_enabled) {
            for (const auto& path : chunk_paths) {
                std::filesystem::remove(path);
            }
        }
        throw;
    }

    for (std::thread& worker : workers) {
        if (worker.joinable()) {
            worker.join();
        }
    }

    if (options_.cancellation_requested
        && options_.cancellation_requested->load(std::memory_order_relaxed)) {
        if (!resume_enabled) {
            for (const auto& path : chunk_paths) std::filesystem::remove(path);
            std::filesystem::remove(state_path);
        }
        std::filesystem::remove(temp_path);
        throw ldm::DownloadCancelled();
    }

    for (std::size_t index = 0U; index < chunk_count; ++index) {
        if (!chunk_errors[index].empty()) {
            if (!resume_enabled) {
                for (const auto& path : chunk_paths) {
                    std::filesystem::remove(path);
                }
            }
            std::filesystem::remove(temp_path);
            if (!resume_enabled) {
                std::filesystem::remove(state_path);
            }
            throw std::runtime_error(chunk_errors[index]);
        }
    }

    try {
        std::ofstream assembled_output(temp_path, std::ios::binary | std::ios::trunc);
        if (!assembled_output.is_open()) {
            throw std::runtime_error("Unable to open the final output file for assembly");
        }

        for (const auto& path : chunk_paths) {
            throw_if_cancelled(options_);
            std::ifstream chunk_input(path, std::ios::binary);
            if (!chunk_input.is_open()) {
                throw std::runtime_error("Failed to open chunk file for assembly: " + path.string());
            }

            copy_stream(chunk_input, assembled_output, options_);
        }

        assembled_output.close();
        if (!assembled_output) {
            throw std::runtime_error("Failed to finalize the assembled download");
        }

        wait_until_running(options_);
        std::filesystem::rename(temp_path, target_path);
    } catch (...) {
        if (!resume_enabled) {
            for (const auto& path : chunk_paths) {
                std::filesystem::remove(path);
            }
        }
        std::filesystem::remove(temp_path);
        if (!resume_enabled) {
            std::filesystem::remove(state_path);
        }
        throw;
    }

    for (const auto& path : chunk_paths) {
        std::filesystem::remove(path);
    }
    std::filesystem::remove(state_path);

    progress.finish(total_size);
}

}  // namespace ldm
