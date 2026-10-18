#include "downloader.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

int main(int argc, char** argv) {
    if (argc < 3) return 64;
    ldm::DownloadOptions options;
    options.cancellation_requested = std::make_shared<std::atomic_bool>(false);
    options.pause_requested = std::make_shared<std::atomic_bool>(false);
    options.max_retries = 0;
    if (const char* timeout = std::getenv("LDM_TEST_TRANSFER_TIMEOUT")) options.transfer_timeout_seconds = std::stol(timeout);
    if (std::string(argv[1]) == "inspect") {
        try {
            const auto media = ldm::inspect_media(argv[2], options);
            std::cout << "duration=" << media.duration_seconds << '\n';
            for (const auto& stream : media.streams) {
                std::cout << "stream=" << stream.index << '|' << stream.kind << '|' << stream.codec
                    << '|' << stream.width << '|' << stream.height << '|' << stream.bit_rate << '|';
                for (int program : stream.program_ids) std::cout << program << ',';
                std::cout << '\n';
            }
            return 0;
        } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
    }
    if (argc != 11 || std::string(argv[1]) != "download") return 64;
    options.output_path = argv[3];
    options.manifest_format = std::string(argv[4]) == "-" ? "" : argv[4];
    options.video_stream_index = std::stoi(argv[5]);
    options.audio_stream_index = std::stoi(argv[6]);
    options.audio_only = std::string(argv[7]) == "1";
    options.output_format = argv[8];
    options.max_connections = static_cast<std::size_t>(std::stoul(argv[9]));
    const std::string control_path = argv[10];
    std::mutex print_mutex;
    options.progress_callback = [&](const ldm::DownloadProgress& progress) {
        std::lock_guard<std::mutex> lock(print_mutex);
        std::cout << "progress=" << progress.bytes_downloaded << '|' << progress.bytes_processed
            << '|' << progress.percent_complete << '|' << progress.output_filename << '|' << progress.total_bytes << std::endl;
    };
    std::atomic_bool finished{false};
    std::thread controls([&]() {
        std::string previous;
        while (!finished.load()) {
            std::ifstream input(control_path);
            std::string command;
            input >> command;
            if (!command.empty() && command != previous) {
                if (command == "pause") options.pause_requested->store(true);
                else if (command == "resume") options.pause_requested->store(false);
                else if (command == "cancel") options.cancellation_requested->store(true);
                previous = command;
                std::lock_guard<std::mutex> lock(print_mutex);
                std::cout << "control=" << command << std::endl;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
    });
    int status = 0;
    try { ldm::Downloader(options).download(argv[2]); }
    catch (const ldm::DownloadCancelled&) { std::cerr << "cancelled\n"; status = 3; }
    catch (const std::exception& error) { std::cerr << error.what() << '\n'; status = 1; }
    finished.store(true);
    controls.join();
    return status;
}
