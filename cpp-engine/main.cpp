#include "downloader.h"
#include "ipc_server.h"

#include <charconv>
#include <cstdint>
#include <iostream>
#include <string>
#include <iomanip>

int main(int argc, char* argv[]) {
    const bool requested_server = argc >= 2 && std::string(argv[1]) == "--server";
    bool open_desktop_app = argc >= 2 && std::string(argv[1]) == "--app";
#if defined(LDM_MACOS_APP_BUNDLE)
    // Launch Services opens the app bundle without command-line arguments.
    if (argc == 1) {
        open_desktop_app = true;
    }
#endif
    if (requested_server || open_desktop_app) {
        std::uint16_t port = 12345U;
        if (argc >= 3) {
            unsigned int parsed_port = 0U;
            const std::string port_argument(argv[2]);
            const auto result = std::from_chars(
                port_argument.data(), port_argument.data() + port_argument.size(), parsed_port);
            if (result.ec != std::errc{} || result.ptr != port_argument.data() + port_argument.size()
                || parsed_port == 0U || parsed_port > 65535U) {
                std::cerr << "Invalid server port. Expected an integer from 1 to 65535.\n";
                return 1;
            }
            port = static_cast<std::uint16_t>(parsed_port);
        }

        try {
            std::cout << "LDM local IPC server listening on 127.0.0.1:" << port << "\n";
            if (open_desktop_app) {
                std::cout << "Launching the local desktop dashboard.\n";
            }
            ldm::IpcServer server(port, open_desktop_app);
            server.run();
        } catch (const std::exception& error) {
            std::cerr << "IPC server error: " << error.what() << "\n";
            return 1;
        }
        return 0;
    }

    if (argc < 2) {
        std::cerr << "Usage: " << argv[0] << " <URL> [output_path]\n"
                  << "       " << argv[0] << " --server [port]\n"
                  << "       " << argv[0] << " --app [port]\n"
                  << "IPC accepts one newline-delimited JSON task per TCP connection on 127.0.0.1:12345.\n";
        return 1;
    }

    std::string url = argv[1];
    ldm::DownloadOptions options;
    
    if (argc >= 3) {
        options.output_path = argv[2];
    }

    // রিয়েল-টাইম প্রোগ্রেস ও স্পিড দেখানোর জন্য কলব্যাক ফাংশন
    options.progress_callback = [](const ldm::DownloadProgress& progress) {
        if (progress.phase == "hls" || progress.phase == "dash") {
            const char* format = progress.phase == "dash" ? "DASH" : "HLS";
            std::cout << "\r[" << format << "] ";
            if (progress.percent_complete > 0.0) {
                std::cout << std::fixed << std::setprecision(1)
                          << progress.percent_complete << "% | ";
            } else {
                std::cout << "processing | ";
            }
            std::cout << std::fixed << std::setprecision(2)
                      << (static_cast<double>(progress.bytes_processed) / (1024.0 * 1024.0))
                      << " MB muxed"
                      << std::flush;
            return;
        }

        int bar_width = 40;
        double progress_fraction = progress.percent_complete / 100.0;
        int filled_width = static_cast<int>(bar_width * progress_fraction);

        std::cout << "\r[";
        for (int i = 0; i < bar_width; ++i) {
            if (i < filled_width) std::cout << "=";
            else if (i == filled_width) std::cout << ">";
            else std::cout << " ";
        }
        std::cout << "] " 
                  << std::fixed << std::setprecision(1) << progress.percent_complete << "% "
                  << "(" << (progress.bytes_downloaded / (1024 * 1024)) << " MB / " 
                  << (progress.total_bytes / (1024 * 1024)) << " MB) - "
                  << std::setprecision(2) << (progress.bytes_per_second / (1024 * 1024)) << " MB/s"
                  << std::flush;
    };

    try {
        std::cout << "Starting download from: " << url << "\n";
        ldm::Downloader downloader(options);
        downloader.download(url);
        std::cout << "\nDownload completed successfully!\n";
    } catch (const std::exception& e) {
        std::cerr << "\nError: " << e.what() << "\n";
        return 1;
    }

    return 0;
}
