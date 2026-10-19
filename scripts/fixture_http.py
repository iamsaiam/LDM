"""Local HTTP fixture servers with no reverse-DNS dependency during startup."""

from http.server import HTTPServer as StandardHTTPServer
from socketserver import TCPServer, ThreadingMixIn
import socket
import time


class HTTPServer(StandardHTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        return connection, address

    def server_bind(self):
        TCPServer.server_bind(self)
        # StandardHTTPServer calls getfqdn() here. A loopback fixture already has
        # an explicit address; reverse DNS can stall native macOS CI runners.
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def pace_transfer(started, transferred, bytes_per_second):
    """Keep a fixture's target rate without accumulating OS sleep overshoot."""
    delay = started + transferred / bytes_per_second - time.monotonic()
    if delay > 0:
        time.sleep(delay)
