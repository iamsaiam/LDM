#ifndef LDM_DOWNLOAD_REGISTRY_H
#define LDM_DOWNLOAD_REGISTRY_H

#include "downloader.h"

#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace ldm {

struct DownloadJobSnapshot {
    std::string id;
    std::string status;
    std::string filename;
    std::string phase;
    std::string error;
    std::uint64_t bytes_downloaded = 0U;
    std::uint64_t bytes_processed = 0U;
    std::uint64_t total_bytes = 0U;
    double percent_complete = 0.0;
    double bytes_per_second = 0.0;
    std::uint64_t created_at = 0U;
    std::uint64_t updated_at = 0U;
};

class DownloadRegistry {
public:
    bool begin(const std::string& id);
    bool request_pause(const std::string& id);
    bool request_resume(const std::string& id);
    bool request_cancel(const std::string& id);
    std::shared_ptr<std::atomic_bool> cancellation_token(const std::string& id) const;
    std::shared_ptr<std::atomic_bool> pause_token(const std::string& id) const;
    void report(const std::string& id, const DownloadProgress& progress);
    void complete(const std::string& id);
    void cancelled(const std::string& id);
    void fail(const std::string& id, const std::string& error);
    std::vector<DownloadJobSnapshot> snapshot() const;

private:
    static std::uint64_t now_milliseconds();
    void prune_locked();

    mutable std::mutex mutex_;
    std::deque<std::string> order_;
    std::unordered_map<std::string, DownloadJobSnapshot> jobs_;
    std::unordered_map<std::string, std::shared_ptr<std::atomic_bool>> cancellation_tokens_;
    std::unordered_map<std::string, std::shared_ptr<std::atomic_bool>> pause_tokens_;
};

}  // namespace ldm

#endif  // LDM_DOWNLOAD_REGISTRY_H
