"""Minimal COROS MCP client (OAuth 2.0 + PKCE, stateless JSON-RPC)."""

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlencode, urlparse

DEFAULT_ISSUER = "https://mcpcn.coros.com"
REDIRECT_URI = "http://127.0.0.1:43123/callback"
SCOPES = "openid offline_access mcp.tools"
CLIENT_NAME = "coros-health-sync"
TOKEN_PATH = os.path.expanduser(
    os.getenv("COROS_MCP_TOKEN", "~/.coros-mcp-sync/health-token.json")
)
BACKOFF = [5, 15, 30, 45, 60, 90]


class MCPError(RuntimeError):
    pass


class TransientError(MCPError):
    pass


class RangeError(MCPError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _request(url, method="GET", json_body=None, form=None, follow=False, timeout=60):
    data = None
    headers = {"User-Agent": "coros-health-sync/1.0"}
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
        headers["Accept"] = "application/json"
    elif form is not None:
        data = urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    opener = urllib.request.build_opener()
    if not follow:
        opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()
    except urllib.error.URLError as exc:
        raise TransientError(f"{method} {url} failed: {exc.reason}")


def _post_json(url, payload):
    status, _, body = _request(url, "POST", json_body=payload)
    if status not in (200, 201):
        raise MCPError(f"POST {url} failed ({status}): {body[:300]!r}")
    return json.loads(body)


def _pkce_pair():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).decode().rstrip("=")


def write_token(token):
    os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
    with open(TOKEN_PATH, "w") as f:
        json.dump(token, f)
    os.chmod(TOKEN_PATH, 0o600)


def read_token():
    try:
        with open(TOKEN_PATH) as f:
            return json.load(f)
    except Exception:
        return None


def login(issuer, account, password):
    client_info = _post_json(
        f"{issuer}/connect/register",
        {
            "client_name": CLIENT_NAME,
            "redirect_uris": [REDIRECT_URI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "scope": SCOPES,
            "token_endpoint_auth_method": "none",
        },
    )
    client_id = client_info["client_id"]
    verifier, challenge = _pkce_pair()
    state = secrets.token_urlsafe(24)
    authorize_url = f"{issuer}/oauth2/authorize?" + urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "resource": f"{issuer}/mcp",
            "state": state,
        }
    )
    status, headers, _ = _request(authorize_url)
    coros_url = headers.get("Location") or headers.get("location")
    if status not in (302, 303) or not coros_url:
        raise MCPError("MCP gateway did not redirect to the COROS login page")

    query = parse_qs(urlparse(coros_url).query)
    login_form = {
        "client_id": (query.get("client_id") or [""])[0],
        "redirect_uri": (query.get("redirect_uri") or [""])[0],
        "state": (query.get("state") or [""])[0],
        "scope": (query.get("scope") or [""])[0],
        "response_type": (query.get("response_type") or ["code"])[0],
        "activityType": "",
        "language": "zh",
        "country": "CN",
        "userName": account,
        "password": password,
        "checkStatus": "1",
        "getAllHistoryIn24Hours": "0",
    }
    status, headers, _ = _request(coros_url, "POST", form=login_form)
    callback_url = headers.get("Location") or headers.get("location")
    if status not in (302, 303) or not callback_url:
        raise MCPError("COROS login failed (check account/password)")

    status, headers, _ = _request(callback_url)
    resume_url = headers.get("Location") or headers.get("location")
    if status not in (302, 303) or not resume_url:
        raise MCPError("MCP gateway did not resume authorization")

    status, headers, _ = _request(resume_url)
    final_url = headers.get("Location") or headers.get("location")
    if status not in (302, 303) or not final_url:
        raise MCPError("MCP gateway did not return to the client callback")

    params = parse_qs(urlparse(final_url).query)
    code = (params.get("code") or [None])[0]
    returned_state = (params.get("state") or [None])[0]
    if not code or returned_state != state:
        raise MCPError("OAuth code/state missing or mismatched")

    status, _, body = _request(
        f"{issuer}/oauth2/token",
        "POST",
        form={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    if status != 200:
        raise MCPError(f"token exchange failed ({status}): {body[:300]!r}")
    payload = json.loads(body)
    token = {
        "access_token": payload["access_token"],
        "refresh_token": payload.get("refresh_token"),
        "expires_at": int(time.time()) + int(payload.get("expires_in") or 3600) - 60,
        "issuer": issuer,
    }
    write_token(token)
    return token


def refresh(token):
    issuer = token.get("issuer") or DEFAULT_ISSUER
    if not token.get("refresh_token"):
        return None
    status, _, body = _request(
        f"{issuer}/oauth2/token",
        "POST",
        form={
            "grant_type": "refresh_token",
            "refresh_token": token["refresh_token"],
        },
    )
    if status != 200:
        return None
    payload = json.loads(body)
    fresh = {
        "access_token": payload["access_token"],
        "refresh_token": payload.get("refresh_token"),
        "expires_at": int(time.time()) + int(payload.get("expires_in") or 3600) - 60,
        "issuer": issuer,
    }
    write_token(fresh)
    return fresh


def get_token(issuer, account, password):
    token = read_token()
    if token and token.get("access_token"):
        if token.get("expires_at", 0) > time.time():
            return token
        fresh = refresh(token)
        if fresh:
            return fresh
    return login(issuer, account, password)


def _call_once(token, tool, arguments):
    issuer = token.get("issuer") or DEFAULT_ISSUER
    headers = {
        "Authorization": f"Bearer {token['access_token']}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    body = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    req = urllib.request.Request(
        f"{issuer}/mcp", data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code in (429, 500, 502, 503, 504):
            raise TransientError(f"MCP {tool} HTTP {exc.code}")
        raise MCPError(f"MCP {tool} HTTP {exc.code}: {exc.read()[:200]!r}")
    if "error" in payload:
        raise MCPError(f"MCP {tool} error: {payload['error']}")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise MCPError(f"MCP {tool} returned no result")
    text = "\n".join(
        item.get("text", "")
        for item in result.get("content", [])
        if item.get("type") == "text"
    )
    if result.get("isError"):
        raise MCPError(f"MCP {tool} reported an error: {text[:300]}")
    if text.startswith('"') and text.endswith('"'):
        try:
            decoded = json.loads(text)
            if isinstance(decoded, str):
                text = decoded
        except ValueError:
            pass
    return text


def call_tool(token, tool, arguments, retries=6):
    """Call a tool, retrying the gateway's transient 'unavailable' answers."""
    last = None
    for attempt in range(retries):
        try:
            text = _call_once(token, tool, arguments)
        except TransientError as exc:
            last = exc
            wait = BACKOFF[min(attempt, len(BACKOFF) - 1)]
            print(f"[mcp] {tool}: {exc}; retrying in {wait}s", flush=True)
            time.sleep(wait)
            continue
        low = text.lower()
        if "temporarily unavailable" in low:
            last = TransientError(text.strip())
            wait = BACKOFF[min(attempt, len(BACKOFF) - 1)]
            print(f"[mcp] {tool}: unavailable; retrying in {wait}s", flush=True)
            time.sleep(wait)
            continue
        if "date is out of range" in low:
            raise RangeError(text.strip())
        return text
    raise TransientError(str(last) if last else f"{tool} failed")
