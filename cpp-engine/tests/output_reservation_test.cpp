#include "downloader.h"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace {

struct TemporaryDirectory {
    explicit TemporaryDirectory(std::filesystem::path value) : path(std::move(value)) {
        std::filesystem::create_directories(path);
    }

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }

    std::filesystem::path path;
};

std::string download_to(const std::string& url, const std::filesystem::path& target) {
    std::mutex filename_mutex;
    std::string actual_filename;
    ldm::DownloadOptions options;
    options.output_path = target.string();
    options.progress_callback = [&filename_mutex, &actual_filename](const ldm::DownloadProgress& progress) {
        if (progress.output_filename.empty()) return;
        std::lock_guard<std::mutex> lock(filename_mutex);
        actual_filename = progress.output_filename;
    };
    ldm::Downloader(std::move(options)).download(url);
    return actual_filename;
}

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::string read_file(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Unable to read a test download output");
    return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

}  // namespace

int main() {
    const auto unique_suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary_directory(
        std::filesystem::temp_directory_path() / ("ldm-output-reservation-" + std::to_string(unique_suffix)));
    const std::filesystem::path source = temporary_directory.path / "source.bin";
    const std::string payload(2U * 1024U * 1024U, 'L');
    {
        std::ofstream output(source, std::ios::binary);
        output.write(payload.data(), static_cast<std::streamsize>(payload.size()));
        if (!output) throw std::runtime_error("Unable to create the test source file");
    }
    const std::string url = source.generic_string().starts_with('/')
        ? "file://" + source.generic_string()
        : std::filesystem::absolute(source).generic_string();

    const std::filesystem::path duplicate_target = temporary_directory.path / "duplicate.bin";
    require(download_to(url, duplicate_target) == "duplicate.bin",
        "First download did not retain the requested filename");
    require(download_to(url, duplicate_target) == "duplicate (1).bin",
        "Existing output was not assigned a numbered filename");
    require(read_file(duplicate_target) == payload, "First output contents changed");
    require(read_file(temporary_directory.path / "duplicate (1).bin") == payload,
        "Second output contents changed");

    const std::filesystem::path concurrent_target = temporary_directory.path / "parallel.bin";
    std::string first_filename;
    std::string second_filename;
    std::exception_ptr first_error;
    std::exception_ptr second_error;
    std::thread first([&]() {
        try {
            first_filename = download_to(url, concurrent_target);
        } catch (...) {
            first_error = std::current_exception();
        }
    });
    std::thread second([&]() {
        try {
            second_filename = download_to(url, concurrent_target);
        } catch (...) {
            second_error = std::current_exception();
        }
    });
    first.join();
    second.join();
    if (first_error) std::rethrow_exception(first_error);
    if (second_error) std::rethrow_exception(second_error);

    require(std::set<std::string>{first_filename, second_filename}
            == std::set<std::string>{"parallel.bin", "parallel (1).bin"},
        "Concurrent downloads did not reserve distinct output names");
    require(read_file(temporary_directory.path / "parallel.bin") == payload,
        "First concurrent output contents changed");
    require(read_file(temporary_directory.path / "parallel (1).bin") == payload,
        "Second concurrent output contents changed");
}
