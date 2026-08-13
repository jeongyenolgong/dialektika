#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
#  디알렉티카 — 현장의 컴퓨터 한 대
#
#  진행자 노트북에서 이것 하나만 켜면 됩니다. 같은 와이파이의 폰들이 여기로 들어옵니다.
#  하는 일은 둘입니다.
#    ① 화면 파일을 나눠 준다 (지금까지 python -m http.server 가 하던 일)
#    ② 장부를 한 권 들고, 바뀔 때마다 접속한 기기 전부에 알린다
#
#  파이썬 기본 기능만 씁니다 — 설치할 것도 계정도 없습니다.
#      python3 server.py
# ─────────────────────────────────────────────────────────────────────────────
import json, os, queue, socket, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8000
ROOT = os.path.dirname(os.path.abspath(__file__))

# 장부 — 지금 판의 전부입니다 (bus.js의 book과 같은 것)
book = {"press": 0, "players": []}
notes = {"text": ""}          # 검사판이 남기는 기록 — 장부와 섞이면 진행자 화면이 덮어씁니다
lock = threading.Lock()
listeners = []                      # 접속해 있는 기기마다 편지함 하나


def broadcast(envelope):
    line = json.dumps(envelope, ensure_ascii=False)
    for box in list(listeners):
        box.put(line)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    # 화면을 고쳐 가며 보는 중이라 브라우저가 옛 파일을 붙들지 않게 합니다
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass                        # 접속할 때마다 줄이 쏟아지면 정작 볼 것을 못 봅니다

    # ── 장부가 바뀌면 알려 주는 통로 ────────────────────────────────
    def do_GET(self):
        path = self.path.split("?")[0]

        if path == "/log":                        # 검사 기록을 읽어 간다
            body = notes["text"].encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/state":                      # 장부를 한 번 읽어 간다
            body = json.dumps(book, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path != "/events":
            return super().do_GET()

        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        box = queue.Queue()
        listeners.append(box)
        with lock:
            # 늦게 들어와도 지금 판을 곧바로 받는다
            box.put(json.dumps({"book": book}, ensure_ascii=False))
        try:
            while True:
                try:
                    line = box.get(timeout=15)
                    self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")          # 조용하면 중간에서 끊는 곳이 있다
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass                                             # 폰이 화면을 옮기면 여기로 온다
        finally:
            if box in listeners:
                listeners.remove(box)

    # ── 기기가 보내는 것 둘 — 장부(book)와 스쳐 가는 한마디(say) ──────
    def do_POST(self):
        global book
        length = int(self.headers.get("Content-Length") or 0)
        try:
            sent = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            sent = None
        path = self.path.split("?")[0]

        if path == "/log":
            notes["text"] = json.dumps(sent, ensure_ascii=False) if not isinstance(sent, str) else sent
            self.send_response(204); self.send_header("Content-Length","0"); self.end_headers(); return

        if path == "/say":
            broadcast({"say": sent})              # 남기지 않고 그대로 나눠 준다
        elif path in ("/book", "/state") and isinstance(sent, dict):
            with lock:
                book = sent                       # 장부는 진행자 화면이 통째로 적어 보낸다
            broadcast({"book": book})

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


def my_address():
    """폰이 찾아올 주소. 인터넷이 끊겨 있어도 같은 와이파이면 잡힙니다."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.0.1", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = my_address()
    print()
    print("  디알렉티카가 켜졌습니다. 이 창을 닫으면 꺼집니다.")
    print()
    print(f"  진행자 (이 노트북)   http://localhost:{PORT}/host.html")
    print(f"  스크린 (프로젝터)    http://localhost:{PORT}/screen-01-entry.html")
    print(f"  참가자 (폰)          http://{ip}:{PORT}/")
    print()
    print("  폰은 노트북과 같은 와이파이여야 합니다.")
    print()
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
