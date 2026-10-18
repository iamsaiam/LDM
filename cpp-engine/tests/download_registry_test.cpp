#include "download_registry.h"

#include <algorithm>
#include <stdexcept>
#include <string>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() {
    ldm::DownloadRegistry registry;
    require(!registry.begin(""), "An empty id must not create a tracked job");
    require(registry.begin("download-1"), "A new job should be registered");
    require(!registry.begin("download-1"), "An active id must not be registered twice");

    ldm::DownloadProgress progress;
    progress.output_filename = "movie (1).mp4";
    progress.phase = "hls";
    progress.bytes_downloaded = 1024U;
    progress.bytes_processed = 768U;
    progress.total_bytes = 4096U;
    progress.percent_complete = 25.0;
    progress.bytes_per_second = 512.0;
    registry.report("download-1", progress);

    auto jobs = registry.snapshot();
    require(jobs.size() == 1U, "The active job should appear in a snapshot");
    require(jobs[0].status == "downloading", "The registered job should be active");
    require(jobs[0].filename == progress.output_filename, "The selected output name should be tracked");
    require(jobs[0].phase == "hls", "The processing phase should be tracked");
    require(jobs[0].bytes_downloaded == 1024U && jobs[0].bytes_processed == 768U,
        "Download and processing byte counts should be tracked");
    require(jobs[0].total_bytes == 4096U && jobs[0].percent_complete == 25.0,
        "Transfer totals and percentage should be tracked");
    require(jobs[0].bytes_per_second == 512.0, "Transfer speed should be tracked");

    require(registry.begin("download-2"), "A second job should be registered");
    registry.fail("download-2", "connection lost");
    registry.complete("download-1");
    jobs = registry.snapshot();
    require(jobs.size() == 2U, "Both terminal and active records should remain available");
    require(jobs[0].id == "download-2" && jobs[0].status == "failed",
        "Newest failures should appear first with their final status");
    require(jobs[0].error == "connection lost", "The failure reason should be retained");
    require(jobs[1].id == "download-1" && jobs[1].status == "completed",
        "The completed record should be retained");
    require(jobs[1].percent_complete == 100.0, "Completed jobs should report full progress");
    require(!registry.request_cancel("download-1"), "A completed job must not accept cancellation");

    require(registry.begin("download-3"), "A cancellable job should be registered");
    registry.report("download-3", progress);
    const auto cancellation = registry.cancellation_token("download-3");
    require(cancellation && !cancellation->load(), "A new job should have a clear cancellation token");
    const auto pause = registry.pause_token("download-3");
    require(pause && !pause->load(), "A new job should have a clear pause token");
    require(registry.request_pause("download-3"), "A running worker should accept pause");
    require(pause->load(), "Pause should notify the worker");
    registry.report("download-3", progress);
    jobs = registry.snapshot();
    require(jobs[0].status == "paused" && jobs[0].bytes_per_second == 0.0,
        "Late progress must not erase the paused state or show an active rate");
    require(jobs[0].bytes_downloaded == 1024U, "Pausing must preserve downloaded bytes");
    require(registry.request_resume("download-3"), "A paused worker should resume in place");
    require(!pause->load(), "Resuming should clear the worker pause flag");
    require(!registry.request_resume("download-3"), "An already running worker cannot resume again");
    require(registry.request_pause("download-3"), "The running worker can pause again");
    require(registry.request_cancel("download-3"), "An active job should accept cancellation");
    require(cancellation->load(), "Cancellation should notify the active worker");
    require(!pause->load(), "Cancelling a paused worker must release its pause wait");
    jobs = registry.snapshot();
    require(jobs[0].id == "download-3" && jobs[0].status == "cancelling",
        "An accepted cancellation should be visible while the worker stops");
    require(jobs[0].phase == "hls", "Stopping must preserve the media phase for transfer details");
    registry.cancelled("download-3");
    jobs = registry.snapshot();
    require(jobs[0].status == "cancelled", "A stopped job should retain its cancelled state");
    require(jobs[0].phase == "hls" && jobs[0].bytes_processed == 768U,
        "Cancelled stream history should retain its output byte meaning");
    require(!registry.request_cancel("download-3"), "A cancelled job must not accept cancellation twice");

    ldm::DownloadRegistry busy_registry;
    require(busy_registry.begin("stopping"), "The oldest job should be registered");
    require(busy_registry.request_cancel("stopping"), "The oldest job should be stopping");
    require(busy_registry.begin("paused"), "A paused fixture should register");
    require(busy_registry.request_pause("paused"), "A paused fixture should stop reading");
    for (int index = 0; index < 101; ++index) {
        require(busy_registry.begin("active-" + std::to_string(index)), "Active fixture should register");
    }
    const auto busy_jobs = busy_registry.snapshot();
    require(std::any_of(busy_jobs.begin(), busy_jobs.end(), [](const auto& job) {
        return job.id == "stopping" && job.status == "cancelling";
    }), "History pruning must not remove a worker that is still stopping");
    require(std::any_of(busy_jobs.begin(), busy_jobs.end(), [](const auto& job) {
        return job.id == "paused" && job.status == "paused";
    }), "History pruning must retain paused workers");

    return 0;
}
