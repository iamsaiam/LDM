from flask import Flask, request, jsonify
import yt_dlp
import threading
import os
from urllib.parse import urlsplit

app = Flask(__name__)
download_slots = threading.BoundedSemaphore(2)

@app.route('/download', methods=['POST'])
def download_video():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"status": "error", "message": "Expected a JSON object"}), 400

    video_url = data.get('url')
    if not isinstance(video_url, str) or not video_url.strip():
        return jsonify({"status": "error", "message": "No URL provided"}), 400
    video_url = video_url.strip()
    try:
        parsed_url = urlsplit(video_url)
    except ValueError:
        return jsonify({"status": "error", "message": "Invalid URL"}), 400
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.hostname:
        return jsonify({"status": "error", "message": "Only HTTP and HTTPS URLs are supported"}), 400

    if not download_slots.acquire(blocking=False):
        return jsonify({"status": "error", "message": "The download queue is full"}), 429

    app.logger.info("Received experimental yt-dlp request for %s", parsed_url.hostname)

    def start_download():
        try:
            download_folder = os.path.expanduser('~/Downloads')
            os.makedirs(download_folder, exist_ok=True)
            ydl_opts = {
                'outtmpl': os.path.join(download_folder, '%(title)s.%(ext)s'),
                'format': 'bestvideo+bestaudio/best',
                'external_downloader': 'aria2c',
                'external_downloader_args': [
                    '--min-split-size=1M',
                    '--max-connection-per-server=16',
                    '--split=16'
                ],
                'quiet': False
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([video_url])
            app.logger.info("Experimental yt-dlp download completed")
        except Exception as e:
            app.logger.exception("Experimental yt-dlp download failed: %s", e)
        finally:
            download_slots.release()

    threading.Thread(target=start_download, name="ldm-ytdlp-download", daemon=True).start()

    return jsonify({"status": "success", "message": "Download started in background!"})

if __name__ == '__main__':
    print(" LDM experimental backend listening on http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
