# LDM local HTTP benchmark

Recorded: 2026-10-17T00:27:18.274139+00:00

This is a synthetic loopback comparison of LDM connection counts. It does not
measure Internet performance or establish that LDM is faster than IDM/XDM.

Payload: 32 MiB; SHA-256 `c5febe7f44faea048a51663faa8228bb80c76b606644caf5accc5c04b858fdf9`.
Per-response throttle: 8 MiB/s (0 means uncapped).
Trials per connection count: 3; timing includes HTTP setup, transfer and output assembly; hash verification is outside timing.

| Connections requested | Median seconds | Median MiB/s | All hashes correct |
| --- | ---: | ---: | --- |
| 1 | 4.120 | 7.77 | True |
| 8 | 1.635 | 19.58 | True |

A throttle on each response deliberately favors multiple connections. Uncapped
results are limited by the local HTTP fixture, CPU, disk and OS caches. Real
servers can impose a total bandwidth cap or disable range downloads.

Environment: Linux-7.0.0-38-generic-x86_64-with-glibc2.43; 4 logical CPUs; Python 3.14.4.
Executable SHA-256: `dc0babdbc68b6a2f576c39dae54c62a356592e1864706c514a5c7ea521668032`.

Installed comparison tools were only discovered, not executed: {"xdman": "/usr/bin/xdman", "xdm": null, "idman": null}.
