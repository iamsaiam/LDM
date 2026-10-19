import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixture_http import ThreadingHTTPServer

parser = argparse.ArgumentParser(description='Run generated localhost media and an isolated LDM engine for live extension checks.')
parser.add_argument('--engine', type=Path, required=True)
parser.add_argument('--state-file', type=Path, required=True)
parser.add_argument('--keep-files', action='store_true', help='Keep generated fixtures and engine logs for diagnosis')
parser.add_argument('--stop-file', type=Path, help='Gracefully stop when this file is created')
args = parser.parse_args()
engine = str(args.engine.resolve())
if not args.engine.is_file(): parser.error('Engine binary does not exist')
root = Path(tempfile.mkdtemp(prefix='ldm-browser-fixture-'))
(root / 'downloads').mkdir()
def generate(command):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *command], check=True, timeout=30)
generate(['-f','lavfi','-i','testsrc2=size=640x360:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
          '-t','3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',str(root/'video.mp4')])
for height in (180,360):
    generate(['-f','lavfi','-i',f'color=c=blue:s={height*16//9}x{height}:r=12',
              '-f','lavfi','-i',f'sine=frequency={440 if height==180 else 880}:sample_rate=48000',
              '-t','3','-c:v','libx264','-preset','ultrafast','-g','12','-c:a','aac',
              '-f','hls','-hls_time','1','-hls_list_size','0','-hls_segment_filename',str(root/f'{height}-%d.ts'),str(root/f'{height}.m3u8')])
(root/'master.m3u8').write_text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\n180.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n360.m3u8\n')
video = (root/'video.mp4').read_bytes()
slow_size = 64 * 1024 * 1024
requests = []
class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*_args): pass
    def do_HEAD(self): self.respond(False)
    def do_GET(self): self.respond(True)
    def respond(self, body):
        path=self.path.split('?',1)[0]
        requests.append({'path':path,'method':self.command,'cookie':self.headers.get('Cookie',''),
                         'referer':self.headers.get('Referer',''),'agent':self.headers.get('User-Agent','')})
        if path.startswith('/watch'):
            source='/protected.mp4' if path=='/watch' else '/slow.mp4' if path=='/watch-slow' else '/master.m3u8'
            page=(f'<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>LDM real extension fixture</title><style>body{{background:#edf3fc;font:16px sans-serif;padding:40px}}.player{{width:640px;position:relative}}video{{width:640px;height:360px}}h1{{color:#183452}}</style><h1>LDM browser verification</h1><p>Generated local media · no external streaming site</p><div class="player"><video id="fixture-video" controls muted autoplay preload="auto" src="{source}"></video></div>').encode()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length',str(len(page)))
            self.send_header('Set-Cookie','ldm_fixture=authorized; HttpOnly; SameSite=Lax; Path=/'); self.end_headers()
            if body:self.wfile.write(page)
            return
        if path=='/protected.mp4' and ('ldm_fixture=authorized' not in self.headers.get('Cookie','') or '/watch' not in self.headers.get('Referer','')):
            self.send_response(403);self.send_header('Content-Length','0');self.end_headers();return
        if path in ('/protected.mp4','/slow.mp4','/opaque'):
            data=video; length=slow_size if path=='/slow.mp4' else len(data); kind='video/mp4'
        else:
            item=root/path.lstrip('/')
            if not item.is_file() or item.parent!=root:
                self.send_response(404);self.send_header('Content-Length','0');self.end_headers();return
            data=item.read_bytes(); length=len(data);kind='application/vnd.apple.mpegurl' if item.suffix=='.m3u8' else 'video/mp2t'
        start,end,status=0,length-1,200
        match=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers.get('Range',''))
        if match:
            start=int(match[1]);end=min(int(match[2]) if match[2] else end,end);status=206
        if start>=length or end<start:
            self.send_response(416);self.send_header('Content-Length','0');self.end_headers();return
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(end-start+1));self.send_header('Accept-Ranges','bytes')
        self.send_header('ETag','"ldm-generated-fixture-v1"')
        if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{length}')
        self.end_headers()
        if not body:return
        try:
            for offset in range(start,end+1,32768):
                count=min(32768,end-offset+1)
                if path=='/slow.mp4':
                    prefix=data[offset:min(len(data),offset+count)] if offset<len(data) else b''
                    piece=prefix+bytes(count-len(prefix))
                else:piece=data[offset:offset+count]
                self.wfile.write(piece);self.wfile.flush()
                if path=='/slow.mp4':time.sleep(.125)
        except (OSError,ConnectionResetError):pass
    def handle(self):
        try:super().handle()
        except (ConnectionResetError,BrokenPipeError):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
with socket.socket() as reservation:reservation.bind(('127.0.0.1',12345))
environment=os.environ.copy();environment['LDM_DOWNLOAD_DIR']=str(root/'downloads')
log=(root/'engine.log').open('w')
process=subprocess.Popen([engine,'--server','12345'],cwd=root,env=environment,stdout=log,stderr=log,start_new_session=True)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    for _ in range(100):
        try:opener.open('http://127.0.0.1:12345/api/health',timeout=.2).close();break
        except OSError:time.sleep(.03)
    else:raise RuntimeError('Isolated LDM engine did not start')
    info={'root':str(root),'download_dir':str(root/'downloads'),'source':f'http://127.0.0.1:{server.server_port}',
          'engine':'http://127.0.0.1:12345','video_sha256':hashlib.sha256(video).hexdigest()}
    args.state_file.write_text(json.dumps(info))
    print(json.dumps(info),flush=True)
    while not args.stop_file or not args.stop_file.exists():time.sleep(.5)
except KeyboardInterrupt:pass
finally:
    (root/'requests.json').write_text(json.dumps(requests,indent=2))
    os.killpg(process.pid,signal.SIGTERM)
    try:process.wait(timeout=4)
    except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
    log.close();server.shutdown();server.server_close()
    args.state_file.unlink(missing_ok=True)
    if not args.keep_files:
        import shutil
        shutil.rmtree(root)
