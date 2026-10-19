"""Local HTTP fixture servers with no reverse-DNS dependency during startup."""

from http.server import HTTPServer as StandardHTTPServer
from socketserver import TCPServer, ThreadingMixIn


class HTTPServer(StandardHTTPServer):
    def server_bind(self):
        TCPServer.server_bind(self)
        # StandardHTTPServer calls getfqdn() here. A loopback fixture already has
        # an explicit address; reverse DNS can stall native macOS CI runners.
        self.server_name = self.server_address[0]
        self.server_port = self.server_address[1]


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
