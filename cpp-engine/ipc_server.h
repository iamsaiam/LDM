#ifndef LDM_IPC_SERVER_H
#define LDM_IPC_SERVER_H

#include <cstdint>

namespace ldm {

class IpcServer {
public:
    explicit IpcServer(std::uint16_t port = 12345, bool open_desktop_app = false);

    // Serves raw newline-delimited JSON and browser HTTP tasks on loopback.
    // HTTP download status remains queryable while this server process is alive.
    void run();

private:
    std::uint16_t port_;
    bool open_desktop_app_;
};

}  // namespace ldm

#endif  // LDM_IPC_SERVER_H
