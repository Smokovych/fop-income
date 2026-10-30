"""Мінімальний HTTP-клієнт на стандартній бібліотеці."""
import json
import urllib.error
import urllib.parse
import urllib.request


class ApiError(Exception):
    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def request(method, url, headers=None, params=None, body=None, timeout=60):
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(
            {k: v for k, v in params.items() if v is not None})
    data = None
    headers = dict(headers or {})
    headers.setdefault("User-Agent", "fop-income/1.0")
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            charset = resp.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as e:
        raw = e.read()
        text = raw.decode("utf-8", "replace")
        try:
            msg = json.loads(text)
            msg = msg.get("errorDescription") or msg.get("message") or msg.get("error") or text
        except ValueError:
            msg = text
        raise ApiError(f"HTTP {e.code}: {str(msg)[:300]}", e.code, text) from None
    except urllib.error.URLError as e:
        raise ApiError(f"Немає з'єднання: {e.reason}") from None
    if charset.lower() in ("cp1251", "windows-1251"):
        text = raw.decode("cp1251", "replace")
    else:
        text = raw.decode("utf-8", "replace")
    if not text.strip():
        return None
    try:
        return json.loads(text)
    except ValueError:
        raise ApiError(f"Некоректна відповідь API: {text[:200]}") from None
