#include "download_registry.h"

#include <algorithm>
#include <chrono>
#include <utility>

namespace ldm {
namespace {

constexpr std::size_t kMaximumRetainedJobs = 100U;

}  // namespace

std::uint64_t DownloadRegistry::now_milliseconds() {
    const auto elapsed = std::chrono::system_clock::now().time_since_epoch();
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
    return milliseconds > 0 ? static_cast<std::uint64_t>(milliseconds) : 0U;
}

bool DownloadRegistry::begin(const std::string& id) {
    if (id.empty()) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (jobs_.contains(id)) return false;

    const std::uint64_t now = now_milliseconds();
    DownloadJobSnapshot job;
    job.id = id;
    job.status = "downloading";
    job.phase = "http";
    job.created_at = now;
    job.updated_at = now;
    jobs_.emplace(id, std::move(job));
    cancellation_tokens_.emplace(id, std::make_shared<std::atomic_bool>(false));
    pause_tokens_.emplace(id, std::make_shared<std::atomic_bool>(false));
    order_.push_back(id);
    prune_locked();
    return true;
}

bool DownloadRegistry::request_pause(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    const auto token = pause_tokens_.find(id);
    if (found == jobs_.end() || token == pause_tokens_.end()
        || found->second.status != "downloading") return false;
    token->second->store(true, std::memory_order_relaxed);
    found->second.status = "paused";
    found->second.bytes_per_second = 0.0;
    found->second.updated_at = now_milliseconds();
    return true;
}

bool DownloadRegistry::request_resume(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    const auto token = pause_tokens_.find(id);
    if (found == jobs_.end() || token == pause_tokens_.end()
        || found->second.status != "paused") return false;
    token->second->store(false, std::memory_order_relaxed);
    found->second.status = "downloading";
    found->second.bytes_per_second = 0.0;
    found->second.updated_at = now_milliseconds();
    return true;
}

bool DownloadRegistry::request_cancel(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    const auto token = cancellation_tokens_.find(id);
    if (found == jobs_.end() || token == cancellation_tokens_.end()
        || (found->second.status != "downloading" && found->second.status != "paused")) {
        return false;
    }
    token->second->store(true, std::memory_order_relaxed);
    pause_tokens_.at(id)->store(false, std::memory_order_relaxed);
    found->second.status = "cancelling";
    found->second.updated_at = now_milliseconds();
    return true;
}

std::shared_ptr<std::atomic_bool> DownloadRegistry::cancellation_token(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = cancellation_tokens_.find(id);
    return found == cancellation_tokens_.end() ? nullptr : found->second;
}

std::shared_ptr<std::atomic_bool> DownloadRegistry::pause_token(const std::string& id) const {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = pause_tokens_.find(id);
    return found == pause_tokens_.end() ? nullptr : found->second;
}

void DownloadRegistry::report(const std::string& id, const DownloadProgress& progress) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) return;

    DownloadJobSnapshot& job = found->second;
    if (job.status != "downloading") return;
    if (!progress.output_filename.empty()) job.filename = progress.output_filename;
    job.phase = progress.phase;
    job.bytes_downloaded = progress.bytes_downloaded;
    job.bytes_processed = progress.bytes_processed;
    job.total_bytes = progress.total_bytes;
    job.percent_complete = progress.percent_complete;
    job.bytes_per_second = progress.bytes_per_second;
    job.updated_at = now_milliseconds();
}

void DownloadRegistry::complete(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) return;

    found->second.status = "completed";
    found->second.percent_complete = 100.0;
    found->second.updated_at = now_milliseconds();
    prune_locked();
}

void DownloadRegistry::cancelled(const std::string& id) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) return;

    found->second.status = "cancelled";
    found->second.error.clear();
    found->second.updated_at = now_milliseconds();
    prune_locked();
}

void DownloadRegistry::fail(const std::string& id, const std::string& error) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto found = jobs_.find(id);
    if (found == jobs_.end()) return;

    if (found->second.status == "cancelling") {
        found->second.status = "cancelled";
        found->second.error.clear();
    } else {
        found->second.status = "failed";
        found->second.error = error;
    }
    found->second.updated_at = now_milliseconds();
    prune_locked();
}

std::vector<DownloadJobSnapshot> DownloadRegistry::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<DownloadJobSnapshot> result;
    result.reserve(order_.size());
    for (auto iterator = order_.rbegin(); iterator != order_.rend(); ++iterator) {
        const auto found = jobs_.find(*iterator);
        if (found != jobs_.end()) result.push_back(found->second);
    }
    return result;
}

void DownloadRegistry::prune_locked() {
    while (order_.size() > kMaximumRetainedJobs) {
        const auto finished = std::find_if(order_.begin(), order_.end(), [this](const std::string& id) {
            const auto found = jobs_.find(id);
            return found != jobs_.end() && found->second.status != "downloading"
                && found->second.status != "paused" && found->second.status != "cancelling";
        });
        if (finished == order_.end()) return;
        jobs_.erase(*finished);
        cancellation_tokens_.erase(*finished);
        pause_tokens_.erase(*finished);
        order_.erase(finished);
    }
}

}  // namespace ldm
