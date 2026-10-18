#include "ipc_server.h"

#include "downloader.h"
#include "download_registry.h"
#include "desktop_ui_bundle.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <spawn.h>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;

namespace {

constexpr std::size_t kMaximumRequestBytes = 1024U * 1024U;
constexpr std::size_t kMaximumHttpHeaderBytes = 16U * 1024U;
constexpr std::size_t kMaximumActiveClients = 64U;
ldm::DownloadRegistry http_download_registry;
std::atomic<std::uint64_t> next_http_download_id{1U};
std::atomic<std::size_t> active_inspections{0U};
#ifdef MSG_NOSIGNAL
constexpr int kSendFlags = MSG_NOSIGNAL;
#else
constexpr int kSendFlags = 0;
#endif

class SocketHandle {
public:
    explicit SocketHandle(int descriptor = -1) noexcept : descriptor_(descriptor) {}

    ~SocketHandle() {
        if (descriptor_ >= 0) {
            ::close(descriptor_);
        }
    }

    SocketHandle(const SocketHandle&) = delete;
    SocketHandle& operator=(const SocketHandle&) = delete;

    int get() const noexcept {
        return descriptor_;
    }

    int release() noexcept {
        const int descriptor = descriptor_;
        descriptor_ = -1;
        return descriptor;
    }

private:
    int descriptor_;
};

struct JsonValue {
    using Object = std::map<std::string, JsonValue>;
    using Array = std::vector<JsonValue>;
    using Value = std::variant<std::nullptr_t, bool, double, std::string, Array, Object>;

    Value value;
};

class JsonParser {
public:
    explicit JsonParser(const std::string& input) : input_(input) {}

    JsonValue parse() {
        JsonValue result = parse_value();
        skip_whitespace();
        if (position_ != input_.size()) {
            fail("Unexpected trailing data");
        }
        return result;
    }

private:
    [[noreturn]] void fail(const char* message) const {
        throw std::invalid_argument(std::string("Invalid JSON: ") + message);
    }

    void skip_whitespace() {
        while (position_ < input_.size()) {
            const char character = input_[position_];
            if (character != ' ' && character != '\t' && character != '\r' && character != '\n') {
                break;
            }
            ++position_;
        }
    }

    bool consume(char expected) {
        skip_whitespace();
        if (position_ < input_.size() && input_[position_] == expected) {
            ++position_;
            return true;
        }
        return false;
    }

    static void append_utf8(std::string& output, std::uint32_t codepoint) {
        if (codepoint <= 0x7fU) {
            output.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7ffU) {
            output.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else if (codepoint <= 0xffffU) {
            output.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        } else {
            output.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
        }
    }

    std::uint32_t parse_hex_quad() {
        if (input_.size() - position_ < 4U) {
            fail("Incomplete Unicode escape");
        }
        std::uint32_t codepoint = 0U;
        for (std::size_t index = 0U; index < 4U; ++index) {
            const char character = input_[position_++];
            codepoint <<= 4U;
            if (character >= '0' && character <= '9') {
                codepoint |= static_cast<std::uint32_t>(character - '0');
            } else if (character >= 'a' && character <= 'f') {
                codepoint |= static_cast<std::uint32_t>(character - 'a' + 10);
            } else if (character >= 'A' && character <= 'F') {
                codepoint |= static_cast<std::uint32_t>(character - 'A' + 10);
            } else {
                fail("Invalid Unicode escape");
            }
        }
        return codepoint;
    }

    std::string parse_string() {
        if (!consume('"')) {
            fail("Expected string");
        }
        std::string result;
        while (position_ < input_.size()) {
            const unsigned char character = static_cast<unsigned char>(input_[position_++]);
            if (character == '"') {
                return result;
            }
            if (character < 0x20U) {
                fail("Unescaped control character");
            }
            if (character != '\\') {
                result.push_back(static_cast<char>(character));
                continue;
            }
            if (position_ == input_.size()) {
                fail("Incomplete escape");
            }
            const char escaped = input_[position_++];
            switch (escaped) {
                case '"': result.push_back('"'); break;
                case '\\': result.push_back('\\'); break;
                case '/': result.push_back('/'); break;
                case 'b': result.push_back('\b'); break;
                case 'f': result.push_back('\f'); break;
                case 'n': result.push_back('\n'); break;
                case 'r': result.push_back('\r'); break;
                case 't': result.push_back('\t'); break;
                case 'u': {
                    std::uint32_t codepoint = parse_hex_quad();
                    if (codepoint >= 0xd800U && codepoint <= 0xdbffU) {
                        if (input_.size() - position_ < 6U
                            || input_[position_] != '\\'
                            || input_[position_ + 1U] != 'u') {
                            fail("Missing low surrogate");
                        }
                        position_ += 2U;
                        const std::uint32_t low = parse_hex_quad();
                        if (low < 0xdc00U || low > 0xdfffU) {
                            fail("Invalid low surrogate");
                        }
                        codepoint = 0x10000U + ((codepoint - 0xd800U) << 10U) + (low - 0xdc00U);
                    } else if (codepoint >= 0xdc00U && codepoint <= 0xdfffU) {
                        fail("Unexpected low surrogate");
                    }
                    append_utf8(result, codepoint);
                    break;
                }
                default: fail("Invalid escape");
            }
        }
        fail("Unterminated string");
    }

    JsonValue parse_number() {
        const std::size_t start = position_;
        if (position_ < input_.size() && input_[position_] == '-') {
            ++position_;
        }
        if (position_ == input_.size()) {
            fail("Invalid number");
        }
        if (input_[position_] == '0') {
            ++position_;
        } else {
            if (input_[position_] < '1' || input_[position_] > '9') {
                fail("Invalid number");
            }
            while (position_ < input_.size()
                && input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
        }
        if (position_ < input_.size() && input_[position_] == '.') {
            ++position_;
            const std::size_t fraction_start = position_;
            while (position_ < input_.size()
                && input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
            if (fraction_start == position_) {
                fail("Invalid fraction");
            }
        }
        if (position_ < input_.size() && (input_[position_] == 'e' || input_[position_] == 'E')) {
            ++position_;
            if (position_ < input_.size() && (input_[position_] == '+' || input_[position_] == '-')) {
                ++position_;
            }
            const std::size_t exponent_start = position_;
            while (position_ < input_.size()
                && input_[position_] >= '0' && input_[position_] <= '9') {
                ++position_;
            }
            if (exponent_start == position_) {
                fail("Invalid exponent");
            }
        }
        return JsonValue{std::strtod(input_.substr(start, position_ - start).c_str(), nullptr)};
    }

    JsonValue parse_value(std::size_t depth = 0U) {
        if (depth > 64U) {
            fail("Nesting exceeds the 64-level limit");
        }
        skip_whitespace();
        if (position_ >= input_.size()) {
            fail("Expected value");
        }
        if (input_[position_] == '"') {
            return JsonValue{parse_string()};
        }
        if (input_[position_] == '{') {
            ++position_;
            JsonValue::Object object;
            if (consume('}')) {
                return JsonValue{std::move(object)};
            }
            do {
                skip_whitespace();
                const std::string key = parse_string();
                if (!consume(':')) {
                    fail("Expected colon");
                }
                if (!object.emplace(key, parse_value(depth + 1U)).second) {
                    fail("Duplicate object key");
                }
            } while (consume(','));
            if (!consume('}')) {
                fail("Expected closing brace");
            }
            return JsonValue{std::move(object)};
        }
        if (input_[position_] == '[') {
            ++position_;
            JsonValue::Array array;
            if (consume(']')) {
                return JsonValue{std::move(array)};
            }
            do {
                array.push_back(parse_value(depth + 1U));
            } while (consume(','));
            if (!consume(']')) {
                fail("Expected closing bracket");
            }
            return JsonValue{std::move(array)};
        }
        if (input_.compare(position_, 4U, "true") == 0) {
            position_ += 4U;
            return JsonValue{true};
        }
        if (input_.compare(position_, 5U, "false") == 0) {
            position_ += 5U;
            return JsonValue{false};
        }
        if (input_.compare(position_, 4U, "null") == 0) {
            position_ += 4U;
            return JsonValue{nullptr};
        }
        if (input_[position_] == '-' || (input_[position_] >= '0' && input_[position_] <= '9')) {
            return parse_number();
        }
        fail("Unexpected value");
    }

    const std::string& input_;
    std::size_t position_ = 0U;
};

std::string json_escape(const std::string& value) {
    constexpr char hex[] = "0123456789abcdef";
    std::string escaped;
    escaped.reserve(value.size() + 2U);
    escaped.push_back('"');
    for (const unsigned char character : value) {
        switch (character) {
            case '"': escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (character < 0x20U) {
                    escaped += "\\u00";
                    escaped.push_back(hex[(character >> 4U) & 0x0fU]);
                    escaped.push_back(hex[character & 0x0fU]);
                } else {
                    escaped.push_back(static_cast<char>(character));
                }
        }
    }
    escaped.push_back('"');
    return escaped;
}

std::string download_registry_json() {
    const std::vector<ldm::DownloadJobSnapshot> jobs = http_download_registry.snapshot();
    std::string response = "{\"downloads\":[";
    bool first = true;
    for (const ldm::DownloadJobSnapshot& job : jobs) {
        if (!first) response.push_back(',');
        first = false;
        response += "{\"id\":" + json_escape(job.id)
            + ",\"status\":" + json_escape(job.status)
            + ",\"filename\":" + json_escape(job.filename)
            + ",\"phase\":" + json_escape(job.phase)
            + ",\"error\":" + json_escape(job.error)
            + ",\"bytes_downloaded\":" + std::to_string(job.bytes_downloaded)
            + ",\"bytes_processed\":" + std::to_string(job.bytes_processed)
            + ",\"total_bytes\":" + std::to_string(job.total_bytes)
            + ",\"percent_complete\":" + std::to_string(job.percent_complete)
            + ",\"bytes_per_second\":" + std::to_string(job.bytes_per_second)
            + ",\"created_at\":" + std::to_string(job.created_at)
            + ",\"updated_at\":" + std::to_string(job.updated_at)
            + "}";
    }
    response += "]}";
    return response;
}

std::string media_inspection_json(const ldm::MediaInspection& inspection) {
    std::string response = "{\"duration_seconds\":"
        + std::to_string(std::isfinite(inspection.duration_seconds) ? inspection.duration_seconds : 0.0)
        + ",\"streams\":[";
    bool first = true;
    for (const auto& stream : inspection.streams) {
        if (!first) response.push_back(',');
        first = false;
        response += "{\"index\":" + std::to_string(stream.index)
            + ",\"kind\":" + json_escape(stream.kind)
            + ",\"codec\":" + json_escape(stream.codec)
            + ",\"width\":" + std::to_string(stream.width)
            + ",\"height\":" + std::to_string(stream.height)
            + ",\"bit_rate\":" + std::to_string(stream.bit_rate)
            + ",\"language\":" + json_escape(stream.language)
            + ",\"is_default\":" + (stream.is_default ? "true" : "false")
            + ",\"program_ids\":[";
        for (std::size_t index = 0U; index < stream.program_ids.size(); ++index) {
            if (index > 0U) response.push_back(',');
            response += std::to_string(stream.program_ids[index]);
        }
        response += "]}";
    }
    response += "]}";
    return response;
}

const JsonValue* find_member(const JsonValue::Object& object, const std::string& key) {
    const auto found = object.find(key);
    return found == object.end() ? nullptr : &found->second;
}

std::string string_member(const JsonValue::Object& object,
    const std::string& key,
    const std::string& fallback = {}) {
    const JsonValue* value = find_member(object, key);
    if (value == nullptr) {
        return fallback;
    }
    const auto* string = std::get_if<std::string>(&value->value);
    if (string == nullptr) {
        throw std::invalid_argument("Request field '" + key + "' must be a string");
    }
    return *string;
}

std::size_t size_member(const JsonValue::Object& object,
    const std::string& key,
    std::size_t fallback) {
    const JsonValue* value = find_member(object, key);
    if (value == nullptr) {
        return fallback;
    }
    const auto* number = std::get_if<double>(&value->value);
    if (number == nullptr || *number < 1.0 || *number > 256.0 || *number != std::trunc(*number)) {
        throw std::invalid_argument("Request field '" + key + "' must be an integer from 1 to 256");
    }
    return static_cast<std::size_t>(*number);
}

bool bool_member(const JsonValue::Object& object, const std::string& key, bool fallback) {
    const JsonValue* value = find_member(object, key);
    if (value == nullptr) return fallback;
    const auto* boolean = std::get_if<bool>(&value->value);
    if (boolean == nullptr) throw std::invalid_argument("Request field '" + key + "' must be a boolean");
    return *boolean;
}

int stream_index_member(const JsonValue::Object& object, const std::string& key) {
    const JsonValue* value = find_member(object, key);
    if (value == nullptr) return -1;
    const auto* number = std::get_if<double>(&value->value);
    if (number == nullptr || !std::isfinite(*number) || *number < -1.0 || *number > 65535.0
        || *number != std::trunc(*number)) {
        throw std::invalid_argument("Request field '" + key + "' must be an integer from -1 to 65535");
    }
    return static_cast<int>(*number);
}

std::string url_scheme(const std::string& url) {
    const auto separator = url.find("://");
    std::string scheme = separator == std::string::npos ? "" : url.substr(0U, separator);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return scheme;
}

ldm::DownloadOptions parse_options(const JsonValue::Object& object, std::string& url,
    std::string& request_id, bool browser_request = false) {
    url = string_member(object, "url");
    if (url.empty()) {
        throw std::invalid_argument("Request field 'url' is required");
    }
    if (browser_request) {
        const auto scheme = url_scheme(url);
        if ((scheme != "http" && scheme != "https" && scheme != "ftp" && scheme != "ftps")
            || url.find_first_of("\r\n") != std::string::npos) {
            throw std::invalid_argument("Only HTTP, HTTPS, FTP and FTPS download URLs are supported");
        }
    }
    request_id = string_member(object, "id");

    ldm::DownloadOptions options;
    options.output_path = string_member(object, "output_path");
    options.manifest_format = string_member(object, "manifest_format");
    options.video_stream_index = stream_index_member(object, "video_stream_index");
    options.audio_stream_index = stream_index_member(object, "audio_stream_index");
    options.audio_only = bool_member(object, "audio_only", false);
    options.output_format = string_member(object, "output_format", "mp4");
    if (options.output_format != "mp4" && options.output_format != "mkv"
        && options.output_format != "m4a" && options.output_format != "mp3"
        && options.output_format != "opus") {
        throw std::invalid_argument("Unsupported output_format; choose mp4, mkv, m4a, mp3 or opus");
    }
    if (!options.audio_only && options.output_format != "mp4" && options.output_format != "mkv") {
        throw std::invalid_argument("Audio containers require audio_only=true");
    }
    if (options.manifest_format != "" && options.manifest_format != "hls"
        && options.manifest_format != "dash") {
        throw std::invalid_argument("Request field 'manifest_format' must be 'hls' or 'dash'");
    }
    if (browser_request && !options.output_path.empty()) {
        const std::filesystem::path requested_path(options.output_path);
        if (!requested_path.is_absolute() && requested_path.parent_path().empty()) {
            const char* configured_directory = std::getenv("LDM_DOWNLOAD_DIR");
            const char* home_directory = std::getenv("HOME");
            if (configured_directory != nullptr && configured_directory[0] != '\0') {
                const std::filesystem::path directory(configured_directory);
                if (!directory.is_absolute()) {
                    throw std::invalid_argument("LDM_DOWNLOAD_DIR must be an absolute folder path");
                }
                options.output_path = (directory / requested_path).string();
            } else if (home_directory != nullptr && home_directory[0] != '\0') {
                options.output_path = (std::filesystem::path(home_directory)
                    / "Downloads" / requested_path).string();
            }
        }
    }
    options.max_connections = size_member(object, "max_connections", options.max_connections);
    options.user_agent = string_member(object, "user_agent", options.user_agent);
    options.cookies = string_member(object, "cookies");
    options.referer = string_member(object, "referer");

    const JsonValue* headers = find_member(object, "headers");
    if (headers != nullptr) {
        const auto* header_object = std::get_if<JsonValue::Object>(&headers->value);
        if (header_object == nullptr) {
            throw std::invalid_argument("Request field 'headers' must be a JSON object of string values");
        }
        for (const auto& [name, value] : *header_object) {
            const auto* header_value = std::get_if<std::string>(&value.value);
            if (header_value == nullptr) {
                throw std::invalid_argument("Custom HTTP header values must be strings");
            }
            options.custom_headers.emplace_back(name, *header_value);
        }
    }
    return options;
}

bool send_all(int socket, const std::string& data) {
    std::size_t sent = 0U;
    while (sent < data.size()) {
        const ssize_t result = ::send(socket, data.data() + sent, data.size() - sent, kSendFlags);
        if (result < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (result == 0) {
            return false;
        }
        sent += static_cast<std::size_t>(result);
    }
    return true;
}

void configure_socket_for_send(int socket) {
    timeval send_timeout{};
    send_timeout.tv_sec = 2;
    if (::setsockopt(socket, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout)) < 0) {
        throw std::runtime_error("Unable to set IPC client send timeout");
    }
#ifdef SO_NOSIGPIPE
    int enabled = 1;
    if (::setsockopt(socket, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) < 0) {
        throw std::runtime_error("Unable to disable SIGPIPE for an IPC client socket");
    }
#else
    static_cast<void>(socket);
#endif
}

bool send_event(int socket, const std::string& event_json) {
    return send_all(socket, event_json + "\n");
}

void open_desktop_dashboard(std::uint16_t port) {
#ifdef __APPLE__
    constexpr const char* launcher = "open";
#else
    constexpr const char* launcher = "xdg-open";
#endif
    const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/";
    char* arguments[] = {
        const_cast<char*>(launcher),
        const_cast<char*>(url.c_str()),
        nullptr
    };
    pid_t child = 0;
    const int spawn_result = ::posix_spawnp(&child, launcher, nullptr, nullptr, arguments, environ);
    if (spawn_result != 0) {
        std::cerr << "Could not launch a browser. Open " << url << " manually.\n";
        return;
    }
    std::thread([child]() {
        int status = 0;
        while (::waitpid(child, &status, 0) < 0 && errno == EINTR) {
        }
    }).detach();
}

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return {};
    }
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1U);
}

std::string lowercase(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return value;
}

std::string read_request_line(int socket) {
    std::string request;
    request.reserve(1024U);
    while (request.size() <= kMaximumHttpHeaderBytes) {
        char character = '\0';
        const ssize_t received = ::recv(socket, &character, 1U, 0);
        if (received < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw std::runtime_error("Failed to read request from client");
        }
        if (received == 0) {
            break;
        }
        if (character == '\n') {
            if (!request.empty() && request.back() == '\r') {
                request.pop_back();
            }
            return request;
        }
        request.push_back(character);
    }
    if (request.empty()) {
        throw std::invalid_argument("Client closed connection without a request");
    }
    throw std::invalid_argument("Request line exceeds the 16 KiB limit");
}

struct HttpRequest {
    std::string method;
    std::string target;
    std::map<std::string, std::string> headers;
    std::string body;
};

HttpRequest read_http_request(int socket, const std::string& request_line) {
    HttpRequest request;
    const auto first_space = request_line.find(' ');
    const auto second_space = first_space == std::string::npos
        ? std::string::npos
        : request_line.find(' ', first_space + 1U);
    if (first_space == std::string::npos || second_space == std::string::npos) {
        throw std::invalid_argument("Malformed HTTP request line");
    }
    request.method = request_line.substr(0U, first_space);
    request.target = request_line.substr(first_space + 1U, second_space - first_space - 1U);

    std::size_t header_bytes = request_line.size();
    while (true) {
        const std::string line = read_request_line(socket);
        header_bytes += line.size() + 2U;
        if (header_bytes > kMaximumHttpHeaderBytes) {
            throw std::invalid_argument("HTTP headers exceed the 16 KiB limit");
        }
        if (line.empty()) {
            break;
        }
        const auto colon = line.find(':');
        if (colon == std::string::npos) {
            throw std::invalid_argument("Malformed HTTP header");
        }
        request.headers[lowercase(trim(line.substr(0U, colon)))] = trim(line.substr(colon + 1U));
    }

    const auto length_header = request.headers.find("content-length");
    std::size_t content_length = 0U;
    if (length_header != request.headers.end()) {
        const std::string& value = length_header->second;
        const auto parsed = std::from_chars(value.data(), value.data() + value.size(), content_length);
        if (parsed.ec != std::errc{} || parsed.ptr != value.data() + value.size()) {
            throw std::invalid_argument("Invalid HTTP Content-Length");
        }
    }
    if (content_length > kMaximumRequestBytes) {
        throw std::invalid_argument("Request exceeds the 1 MiB limit");
    }
    request.body.resize(content_length);
    std::size_t received_total = 0U;
    while (received_total < content_length) {
        const ssize_t received = ::recv(socket, request.body.data() + received_total,
            content_length - received_total, 0);
        if (received < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw std::runtime_error("Failed to read HTTP request body");
        }
        if (received == 0) {
            throw std::invalid_argument("HTTP request body ended before Content-Length");
        }
        received_total += static_cast<std::size_t>(received);
    }
    return request;
}

bool permitted_extension_origin(const std::string& origin) {
    const bool extension_scheme = origin.rfind("chrome-extension://", 0U) == 0U
        || origin.rfind("moz-extension://", 0U) == 0U;
    if (!extension_scheme) {
        return false;
    }
    const auto separator = origin.find("://");
    const std::string authority = origin.substr(separator + 3U);
    return !authority.empty()
        && authority.find_first_of("/?# \t\r\n") == std::string::npos;
}

bool permitted_browser_origin(const std::string& origin, std::uint16_t port) {
    if (permitted_extension_origin(origin)) {
        return true;
    }
    const std::string port_text = std::to_string(port);
    return origin == "http://127.0.0.1:" + port_text
        || origin == "http://localhost:" + port_text;
}

void send_http_headers(int socket, const std::string& origin, int status, const std::string& reason,
    bool streaming, const std::string& body = {},
    const std::string& content_type = "application/json; charset=utf-8") {
    std::string response = "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\n"
        + "Connection: close\r\n"
        + "X-Content-Type-Options: nosniff\r\n"
        + "Referrer-Policy: no-referrer\r\n"
        + "X-Frame-Options: DENY\r\n";
    if (!origin.empty()) {
        response += "Access-Control-Allow-Origin: " + origin + "\r\n"
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: content-type\r\n"
            "Access-Control-Allow-Private-Network: true\r\n"
            "Vary: Origin\r\n";
    }
    if (content_type == "text/html; charset=utf-8") {
        response += "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; "
            "frame-ancestors 'none'\r\n";
    }
    if (streaming) {
        response += "Content-Type: application/x-ndjson; charset=utf-8\r\n"
            "Transfer-Encoding: chunked\r\n\r\n";
    } else {
        response += "Content-Type: " + content_type + "\r\n"
            "Content-Length: " + std::to_string(body.size()) + "\r\n\r\n" + body;
    }
    static_cast<void>(send_all(socket, response));
}

bool send_http_event(int socket, const std::string& event_json) {
    const std::string payload = event_json + "\n";
    std::array<char, 32> length_buffer{};
    const auto result = std::to_chars(length_buffer.data(),
        length_buffer.data() + length_buffer.size(),
        payload.size(), 16);
    if (result.ec != std::errc{}) {
        return false;
    }
    const std::string chunk = std::string(length_buffer.data(), result.ptr)
        + "\r\n" + payload + "\r\n";
    return send_all(socket, chunk);
}

void finish_http_stream(int socket) {
    static_cast<void>(send_all(socket, "0\r\n\r\n"));
}

bool send_download_event(int socket, bool http, std::atomic_bool& writable, const std::string& event) {
    if (!writable.load(std::memory_order_relaxed)) return false;
    if (http ? send_http_event(socket, event) : send_event(socket, event)) return true;
    // A disconnected or stalled UI must not keep the download worker blocked.
    writable.store(false, std::memory_order_relaxed);
    static_cast<void>(::shutdown(socket, SHUT_WR));
    return false;
}

void handle_http_client(int socket, const std::string& request_line, std::uint16_t port) {
    bool stream_started = false;
    bool job_registered = false;
    std::string request_id;
    std::string response_origin;
    auto progress_writable = std::make_shared<std::atomic_bool>(true);
    try {
        const HttpRequest request = read_http_request(socket, request_line);
        const auto origin_header = request.headers.find("origin");
        if (origin_header != request.headers.end()
            && !origin_header->second.empty()
            && !permitted_browser_origin(origin_header->second, port)) {
            send_http_headers(socket, "", 403, "Forbidden", false,
                "{\"error\":\"Requests with browser origins must come from the LDM app or an extension\"}");
            return;
        }
        const std::string origin = origin_header == request.headers.end() ? "" : origin_header->second;
        response_origin = origin;
        if (request.method == "OPTIONS") {
            send_http_headers(socket, origin, 204, "No Content", false);
            return;
        }
        if (request.method == "GET") {
            if (request.target == "/") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kIndexHtml), "text/html; charset=utf-8");
            } else if (request.target == "/app.css") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kAppCss), "text/css; charset=utf-8");
            } else if (request.target == "/transfer-metrics.js") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kTransferMetricsJs), "application/javascript; charset=utf-8");
            } else if (request.target == "/media-options.js") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kMediaOptionsJs), "application/javascript; charset=utf-8");
            } else if (request.target == "/app.js") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kAppJs), "application/javascript; charset=utf-8");
            } else if (request.target == "/manifest.webmanifest") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kManifest), "application/manifest+json; charset=utf-8");
            } else if (request.target == "/service-worker.js") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kServiceWorker), "application/javascript; charset=utf-8");
            } else if (request.target == "/icon.svg") {
                send_http_headers(socket, origin, 200, "OK", false,
                    std::string(ldm::desktop_ui::kIconSvg), "image/svg+xml; charset=utf-8");
            } else if (request.target == "/api/health") {
                send_http_headers(socket, origin, 200, "OK", false,
                    "{\"status\":\"ok\",\"version\":\"0.1.0\"}");
            } else if (request.target == "/api/downloads") {
                send_http_headers(socket, origin, 200, "OK", false, download_registry_json());
            } else {
                send_http_headers(socket, origin, 404, "Not Found", false, "{\"error\":\"Not found\"}");
            }
            return;
        }
        if (request.method == "POST" && request.target == "/api/inspect") {
            const JsonValue value = JsonParser(request.body).parse();
            const auto* object = std::get_if<JsonValue::Object>(&value.value);
            if (object == nullptr) throw std::invalid_argument("Inspection request must be a JSON object");
            std::string url;
            std::string inspection_id;
            const auto options = parse_options(*object, url, inspection_id, true);
            const auto scheme = url_scheme(url);
            if (scheme != "http" && scheme != "https") {
                throw std::invalid_argument("Media inspection requires an HTTP or HTTPS URL");
            }
            if (active_inspections.fetch_add(1U, std::memory_order_relaxed) >= 2U) {
                active_inspections.fetch_sub(1U, std::memory_order_relaxed);
                send_http_headers(socket, origin, 429, "Too Many Requests", false,
                    "{\"error\":\"Two media inspections are already running. Try again shortly.\"}");
                return;
            }
            struct InspectionSlot {
                ~InspectionSlot() { active_inspections.fetch_sub(1U, std::memory_order_relaxed); }
            } inspection_slot;
            send_http_headers(socket, origin, 200, "OK", false,
                media_inspection_json(ldm::inspect_media(url, options)));
            return;
        }
        if (request.method == "POST" && (request.target == "/api/cancel"
                || request.target == "/api/pause" || request.target == "/api/resume")) {
            const JsonValue value = JsonParser(request.body).parse();
            const auto* object = std::get_if<JsonValue::Object>(&value.value);
            if (object == nullptr) {
                send_http_headers(socket, origin, 400, "Bad Request", false,
                    "{\"error\":\"Request must be a JSON object\"}");
                return;
            }
            const std::string id = string_member(*object, "id");
            if (id.empty()) {
                send_http_headers(socket, origin, 400, "Bad Request", false,
                    "{\"error\":\"Request field 'id' is required\"}");
                return;
            }
            const bool pause = request.target == "/api/pause";
            const bool resume = request.target == "/api/resume";
            const bool accepted = pause ? http_download_registry.request_pause(id)
                : (resume ? http_download_registry.request_resume(id) : http_download_registry.request_cancel(id));
            if (!accepted) {
                send_http_headers(socket, origin, 409, "Conflict", false,
                    "{\"error\":\"The requested control is not valid for this transfer state\"}");
                return;
            }
            send_http_headers(socket, origin, 200, "OK", false,
                "{\"status\":" + json_escape(pause ? "paused" : (resume ? "downloading" : "cancelling"))
                    + ",\"id\":" + json_escape(id) + "}");
            return;
        }
        if (request.method != "POST" || request.target != "/download") {
            send_http_headers(socket, origin, 404, "Not Found", false, "{\"error\":\"Not found\"}");
            return;
        }

        const JsonValue value = JsonParser(request.body).parse();
        const auto* object = std::get_if<JsonValue::Object>(&value.value);
        if (object == nullptr) {
            send_http_headers(socket, origin, 400, "Bad Request", false,
                "{\"error\":\"Request must be a JSON object\"}");
            return;
        }
        std::string url;
        ldm::DownloadOptions options = parse_options(*object, url, request_id, true);
        if (request_id.empty()) {
            request_id = "ldm-http-" + std::to_string(
                next_http_download_id.fetch_add(1U, std::memory_order_relaxed));
        }
        if (request_id.size() > 128U) {
            send_http_headers(socket, origin, 400, "Bad Request", false,
                "{\"error\":\"Download id is too long\"}");
            return;
        }
        if (!http_download_registry.begin(request_id)) {
            send_http_headers(socket, origin, 409, "Conflict", false,
                "{\"error\":\"A download with this id is already tracked\"}");
            return;
        }
        job_registered = true;
        options.cancellation_requested = http_download_registry.cancellation_token(request_id);
        options.pause_requested = http_download_registry.pause_token(request_id);
        send_http_headers(socket, origin, 200, "OK", true);
        stream_started = true;
        options.progress_callback = [socket, request_id, progress_writable](const ldm::DownloadProgress& progress) {
            http_download_registry.report(request_id, progress);
            std::string event = "{\"event\":\"progress\",\"id\":" + json_escape(request_id)
                + ",\"bytes_downloaded\":" + std::to_string(progress.bytes_downloaded)
                + ",\"bytes_processed\":" + std::to_string(progress.bytes_processed)
                + ",\"total_bytes\":" + std::to_string(progress.total_bytes)
                + ",\"percent_complete\":" + std::to_string(progress.percent_complete)
                + ",\"bytes_per_second\":" + std::to_string(progress.bytes_per_second)
                + ",\"phase\":" + json_escape(progress.phase);
            if (!progress.output_filename.empty()) {
                event += ",\"output_filename\":" + json_escape(progress.output_filename);
            }
            event += "}";
            static_cast<void>(send_download_event(socket, true, *progress_writable, event));
        };
        ldm::Downloader(std::move(options)).download(url);
        http_download_registry.complete(request_id);
        static_cast<void>(send_download_event(socket, true, *progress_writable,
            "{\"event\":\"completed\",\"id\":" + json_escape(request_id) + "}"));
        if (progress_writable->load(std::memory_order_relaxed)) finish_http_stream(socket);
    } catch (const ldm::DownloadCancelled&) {
        if (job_registered) http_download_registry.cancelled(request_id);
        if (stream_started) {
            static_cast<void>(send_download_event(socket, true, *progress_writable,
                "{\"event\":\"cancelled\",\"id\":" + json_escape(request_id) + "}"));
            if (progress_writable->load(std::memory_order_relaxed)) finish_http_stream(socket);
        } else {
            send_http_headers(socket, response_origin, 409, "Conflict", false,
                "{\"error\":\"Download cancelled\"}");
        }
    } catch (const std::exception& error) {
        if (job_registered) http_download_registry.fail(request_id, error.what());
        if (stream_started) {
            const std::string event = "{\"event\":\"error\",\"error\":" + json_escape(error.what()) + "}";
            static_cast<void>(send_download_event(socket, true, *progress_writable, event));
            if (progress_writable->load(std::memory_order_relaxed)) finish_http_stream(socket);
        } else {
            const std::string body = "{\"error\":" + json_escape(error.what()) + "}";
            send_http_headers(socket, response_origin, 400, "Bad Request", false, body);
        }
    } catch (...) {
        if (job_registered) http_download_registry.fail(request_id, "Unknown non-standard exception");
        if (stream_started) {
            static_cast<void>(send_download_event(socket, true, *progress_writable,
                "{\"event\":\"error\",\"error\":\"Unknown non-standard exception\"}"));
            if (progress_writable->load(std::memory_order_relaxed)) finish_http_stream(socket);
        } else {
            send_http_headers(socket, response_origin, 500, "Internal Server Error", false,
                "{\"error\":\"Unknown non-standard exception\"}");
        }
    }
}

void handle_client(int socket, std::uint16_t port) {
    auto progress_writable = std::make_shared<std::atomic_bool>(true);
    try {
        const std::string request = read_request_line(socket);
        if (request.rfind("GET ", 0U) == 0U
            || request.rfind("POST ", 0U) == 0U
            || request.rfind("OPTIONS ", 0U) == 0U) {
            handle_http_client(socket, request, port);
            return;
        }
        const JsonValue value = JsonParser(request).parse();
        const auto* object = std::get_if<JsonValue::Object>(&value.value);
        if (object == nullptr) {
            throw std::invalid_argument("Request must be a JSON object");
        }

        std::string url;
        std::string request_id;
        ldm::DownloadOptions options = parse_options(*object, url, request_id);
        options.progress_callback = [socket, request_id, progress_writable](const ldm::DownloadProgress& progress) {
            std::string event = "{\"event\":\"progress\",\"id\":" + json_escape(request_id)
                + ",\"bytes_downloaded\":" + std::to_string(progress.bytes_downloaded)
                + ",\"bytes_processed\":" + std::to_string(progress.bytes_processed)
                + ",\"total_bytes\":" + std::to_string(progress.total_bytes)
                + ",\"percent_complete\":" + std::to_string(progress.percent_complete)
                + ",\"bytes_per_second\":" + std::to_string(progress.bytes_per_second)
                + ",\"phase\":" + json_escape(progress.phase);
            if (!progress.output_filename.empty()) {
                event += ",\"output_filename\":" + json_escape(progress.output_filename);
            }
            event += "}";
            static_cast<void>(send_download_event(socket, false, *progress_writable, event));
        };

        ldm::Downloader(std::move(options)).download(url);
        const std::string event = "{\"event\":\"completed\",\"id\":" + json_escape(request_id) + "}";
        static_cast<void>(send_download_event(socket, false, *progress_writable, event));
    } catch (const std::exception& error) {
        const std::string event = "{\"event\":\"error\",\"error\":" + json_escape(error.what()) + "}";
        static_cast<void>(send_download_event(socket, false, *progress_writable, event));
    } catch (...) {
        static_cast<void>(send_download_event(socket, false, *progress_writable,
            "{\"event\":\"error\",\"error\":\"Unknown non-standard exception\"}"));
    }
}

}  // namespace

namespace ldm {

IpcServer::IpcServer(std::uint16_t port, bool open_desktop_app)
    : port_(port), open_desktop_app_(open_desktop_app) {
    if (port_ == 0U) {
        throw std::invalid_argument("IPC server port must be between 1 and 65535");
    }
}

void IpcServer::run() {
    SocketHandle listener(::socket(AF_INET, SOCK_STREAM, 0));
    if (listener.get() < 0) {
        throw std::runtime_error("Unable to create IPC listening socket");
    }

    int reuse_address = 1;
    if (::setsockopt(listener.get(), SOL_SOCKET, SO_REUSEADDR, &reuse_address, sizeof(reuse_address)) < 0) {
        throw std::runtime_error("Unable to configure IPC listening socket");
    }

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port_);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(listener.get(), reinterpret_cast<const sockaddr*>(&address), sizeof(address)) < 0) {
        throw std::runtime_error("Unable to bind IPC server to 127.0.0.1:" + std::to_string(port_));
    }
    if (::listen(listener.get(), 32) < 0) {
        throw std::runtime_error("Unable to listen for IPC clients");
    }
    if (open_desktop_app_) {
        std::cout << "Opening the LDM desktop dashboard at http://127.0.0.1:"
                  << port_ << "/\n";
        open_desktop_dashboard(port_);
    }

    struct Worker {
        std::atomic<bool> finished{false};
        std::thread thread;

        ~Worker() {
            if (thread.joinable()) {
                thread.join();
            }
        }
    };
    std::atomic<std::size_t> active_clients{0U};
    // Keep client state alive until every worker has joined, including on errors.
    std::vector<std::unique_ptr<Worker>> workers;

    while (true) {
        sockaddr_in client_address{};
        socklen_t client_address_length = sizeof(client_address);
        const int client_descriptor = ::accept(listener.get(),
            reinterpret_cast<sockaddr*>(&client_address),
            &client_address_length);
        if (client_descriptor < 0) {
            if (errno == EINTR) {
                continue;
            }
            throw std::runtime_error("Failed to accept IPC client");
        }
        try {
            configure_socket_for_send(client_descriptor);
        } catch (...) {
            ::close(client_descriptor);
            throw;
        }

        workers.erase(std::remove_if(workers.begin(), workers.end(), [](const std::unique_ptr<Worker>& worker) {
            return worker->finished.load(std::memory_order_acquire);
        }), workers.end());

        if (active_clients.fetch_add(1U, std::memory_order_relaxed) >= kMaximumActiveClients) {
            active_clients.fetch_sub(1U, std::memory_order_relaxed);
            static_cast<void>(send_event(client_descriptor,
                "{\"event\":\"error\",\"error\":\"Too many active IPC clients\"}"));
            ::close(client_descriptor);
            continue;
        }

        SocketHandle accepted_client(client_descriptor);
        auto worker = std::make_unique<Worker>();
        std::atomic<bool>* finished_pointer = &worker->finished;
        worker->thread = std::thread([client_descriptor = accepted_client.get(), finished_pointer, &active_clients,
                server_port = port_]() {
                SocketHandle client(client_descriptor);
                timeval timeout{};
                timeout.tv_sec = 15;
                static_cast<void>(::setsockopt(client.get(), SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)));
                handle_client(client.get(), server_port);
                active_clients.fetch_sub(1U, std::memory_order_relaxed);
                finished_pointer->store(true, std::memory_order_release);
            });
        static_cast<void>(accepted_client.release());
        workers.push_back(std::move(worker));
    }
}

}  // namespace ldm
