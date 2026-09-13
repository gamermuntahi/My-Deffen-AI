"""
Deffen AI — Flask application.

All runtime configuration is owned by the backend. The AI settings (API key,
API URL, model, timeout, system prompt, ...) are read from config.yml and/or
environment variables and handed to the browser through the tiny, no-cache
``/api/config`` endpoint. The browser then performs the actual AI request
itself, so no AI setting is hardcoded in the frontend JavaScript and no
server-side file is ever exposed to the client.

Production (Vercel) configuration
---------------------------------
Set the following project environment variables (Production scope!):

    OPENROUTER_API_KEY   = sk-or-v1-...        (required)
    OPENROUTER_API_URL   = https://openrouter.ai/api/v1/chat/completions
    OPENROUTER_MODEL     = <model id>

Never commit a real key. For local development you can either export the same
variables or put them in an untracked ``config.local.yml`` file, which is
merged on top of config.yml.
"""

import logging
import os
from urllib.parse import unquote, urlparse

import yaml
from flask import Flask, abort, jsonify, render_template, request

# Resolve config files next to this file so the app works regardless of the
# current working directory (local dev and Vercel serverless share this).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("DEFFEN_CONFIG") or os.path.join(BASE_DIR, "config.yml")
# Optional, untracked local override (never committed; local development only).
LOCAL_CONFIG_PATH = (
    os.environ.get("DEFFEN_LOCAL_CONFIG")
    or os.path.join(BASE_DIR, "config.local.yml")
)

# ---------------------------------------------------------------------------
# Logging.
#
# Serverless platforms only surface logs that are actually emitted. We attach a
# stdout handler and default to INFO so configuration problems are visible in
# the Vercel function logs — without ever printing the API key itself.
# ---------------------------------------------------------------------------
log = logging.getLogger("deffen")
if not log.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s [deffen] %(message)s")
    )
    log.addHandler(_handler)
try:
    log.setLevel(os.environ.get("DEFFEN_LOG_LEVEL", "INFO").upper())
except ValueError:  # pragma: no cover - defensive
    log.setLevel(logging.INFO)
log.propagate = False


# ---------------------------------------------------------------------------
# Security: HTTP requests must never be able to read server-side files.
# ---------------------------------------------------------------------------
# Files that must never be reachable over HTTP, regardless of location.
BLOCKED_FILENAMES = {
    "config.yml", "config.yaml", "config.local.yml", "config.local.yaml",
    "config.json", "config.ini", "config.cfg",
    "settings.py", "secrets.yml", "secrets.yaml", "secret.txt", "secrets.txt",
    "app.py", "database.py", "db.py", "models.py", "manage.py", "wsgi.py",
    "asgi.py", "requirements.txt", "pipfile", "pipfile.lock", "poetry.lock",
    "users.db", "database.db", "app.db", "data.db", "db.sqlite", "db.sqlite3",
    ".env", ".env.local", ".env.production", "dockerfile",
    "docker-compose.yml", "makefile", "procfile", "id_rsa", "id_dsa",
}

# Dangerous file extensions that are never public assets.
BLOCKED_EXTENSIONS = {
    ".yml", ".yaml", ".env", ".py", ".pyc", ".pyd", ".pyo", ".json",
    ".db", ".sqlite", ".sqlite3", ".sql", ".log", ".bak", ".backup", ".old",
    ".orig", ".ini", ".cfg", ".conf", ".toml", ".pem", ".key", ".crt", ".cer",
    ".p12", ".pfx", ".lock", ".sh", ".bat", ".ps1", ".rb", ".php",
}

# Directories that must never be browsable/served.
BLOCKED_PATH_SEGMENTS = {
    "templates", ".git", ".env", ".venv", "venv", "__pycache__",
    "node_modules", ".ssh", "instance", "migrations",
}

# Only these asset types may EVER be served from /static.
ALLOWED_STATIC_EXTENSIONS = {
    ".css", ".js", ".mjs", ".map",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".webm", ".ogg", ".wav",
}

# The only backend endpoint the browser may call to obtain AI settings.
AI_CONFIG_ROUTE = "/api/config"

# The exact keys the browser is allowed to receive from /api/config. Anything a
# deployment adds for diagnostics is stripped before the response is sent.
CLIENT_CONFIG_KEYS = (
    "endpoint",
    "fallbacks",
    "api_key",
    "model",
    "timeout_ms",
    "system_prompt",
    "referer",
    "title",
    "max_history_messages",
    "configured",
)


def _fully_unquote(value, rounds=4):
    """Decode percent-encoding repeatedly to catch double-encoded traversal."""
    result = value or ""
    for _ in range(rounds):
        try:
            decoded = unquote(result)
        except Exception:  # pragma: no cover - defensive
            return result
        if decoded == result:
            break
        result = decoded
    return result


def is_blocked_path(raw_path):
    """Return True when a request path targets a non-public/sensitive file."""
    path = _fully_unquote(raw_path)
    if not path:
        return False
    if "\x00" in path:
        return True

    # The config API is an intentional, safe exception.
    if path.rstrip("/") == AI_CONFIG_ROUTE:
        return False

    normalized = path.replace("\\", "/")
    if ".." in normalized:
        return True

    for segment in normalized.split("/"):
        if not segment:
            continue
        name = segment.lower()
        if name in BLOCKED_PATH_SEGMENTS:
            return True
        if name.startswith(".") and name != ".well-known":
            return True
        if name in BLOCKED_FILENAMES:
            return True
        _, ext = os.path.splitext(name)
        if ext and ext in BLOCKED_EXTENSIONS:
            return True
    return False


def is_allowed_static_request(path):
    """Only allow /static/ requests for explicitly whitelisted asset types."""
    prefix = "/static/"
    if not path.startswith(prefix):
        return False
    filename = _fully_unquote(path[len(prefix):]).replace("\\", "/")
    if not filename or filename.endswith("/") or ".." in filename:
        return False
    if is_blocked_path(filename):
        return False
    _, ext = os.path.splitext(filename.lower())
    return ext in ALLOWED_STATIC_EXTENSIONS


# ---------------------------------------------------------------------------
# Configuration loading (cached, reloaded when a file changes on disk so it
# stays editable from the backend without a manual restart).
# ---------------------------------------------------------------------------
_config_cache = {"config": None, "stamp": None}


def _merge(base, override):
    """Recursively merge ``override`` on top of ``base`` (returns a new dict).

    Blank override values are ignored:

    * ``None`` - produced by a bare ``key:`` line, e.g. a section like ``ai:``
      that is left with only comments underneath it.
    * an empty/whitespace string - e.g. a placeholder ``api_key: ""``.

    Without this, an empty ``config.local.yml`` (or one with a commented-out
    section) would overwrite real values from ``config.yml`` with ``None`` and
    silently break the AI configuration (empty endpoint/model/key). An override
    file must only replace keys it actually sets to a meaningful value.
    """
    merged = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict):
            merged[key] = _merge(merged.get(key) or {}, value)
        elif value is None or (isinstance(value, str) and not value.strip()):
            continue
        else:
            merged[key] = value
    return merged


def load_config(path=CONFIG_PATH):
    """Load config.yml, then merge the optional untracked local override."""
    cfg = {}
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}

    if LOCAL_CONFIG_PATH and os.path.exists(LOCAL_CONFIG_PATH):
        try:
            with open(LOCAL_CONFIG_PATH, "r", encoding="utf-8") as fh:
                cfg = _merge(cfg, yaml.safe_load(fh) or {})
        except (OSError, yaml.YAMLError) as exc:
            log.warning("Ignoring local config override: %s", exc)
    return cfg


def _config_stamp():
    """Fingerprint the config files (path + mtime) for cache invalidation."""
    stamp = []
    for path in (CONFIG_PATH, LOCAL_CONFIG_PATH):
        if not path or not os.path.exists(path):
            continue
        try:
            stamp.append((path, os.path.getmtime(path)))
        except OSError:  # pragma: no cover - defensive
            continue
    return tuple(stamp)


def get_config():
    """Return the current config, reloading it when the files change."""
    stamp = _config_stamp()
    if _config_cache["config"] is not None and _config_cache["stamp"] == stamp:
        return _config_cache["config"]

    try:
        cfg = load_config()
    except (OSError, yaml.YAMLError) as exc:
        log.error("Could not load configuration: %s", exc)
        return _config_cache["config"] or {}

    _config_cache["config"] = cfg
    _config_cache["stamp"] = stamp
    return cfg


# ---------------------------------------------------------------------------
# Environment / value normalization.
# ---------------------------------------------------------------------------
def _env_raw(*names):
    """Return (value, name) for the first non-blank environment variable."""
    for name in names:
        value = os.environ.get(name)
        if value is not None and value.strip():
            return value, name
    return "", ""


def _clean_str(value):
    """Coerce a value into a trimmed string, dropping stray quotes/newlines."""
    if value is None:
        return ""
    text = str(value).replace("\r", "").replace("\n", "").strip()
    # Strip one layer of matching surrounding quotes (common copy/paste result).
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"', "`"):
        text = text[1:-1].strip()
    return text


def _normalize_api_key(value):
    """Return ``(key, notes)`` after removing common deployment mistakes.

    This is the fix for OpenRouter's "User not found." error. A key that is
    pasted into a dashboard often arrives as ``Bearer sk-or-...``, wrapped in
    quotes, split across lines, or with a stray ``Authorization:`` prefix.
    Those forms all make OpenRouter reject the request. We normalize the value
    so the browser always sends exactly one ``Bearer <key>`` header.
    """
    notes = []
    raw = "" if value is None else str(value)
    key = _clean_str(raw)
    if key != raw.strip():
        notes.append("stripped whitespace/newlines/quotes")

    # A pasted whole header value: "Authorization: Bearer sk-or-...".
    if ":" in key:
        head, _, tail = key.partition(":")
        if head.strip().lower() == "authorization":
            key = _clean_str(tail)
            notes.append("removed 'Authorization:' prefix")

    # A pasted scheme without the header name: "Bearer sk-or-...".
    if key[:6].lower() == "bearer":
        stripped = _clean_str(key[6:])
        if stripped:
            key = stripped
            notes.append("removed 'Bearer' prefix")

    # A URL-encoded key (e.g. a trailing %0A newline from a CI variable).
    if "%" in key:
        decoded = unquote(key)
        if decoded != key:
            key = _clean_str(decoded)
            notes.append("url-decoded")

    return key, notes


def _resolve_value(env_names, file_value):
    """Environment variable takes priority, then the config file value."""
    raw, _ = _env_raw(*env_names)
    if raw:
        return _clean_str(raw)
    return _clean_str(file_value)


def _mask_secret(value):
    """A safe, non-reversible fingerprint for logs (never the full secret)."""
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return "*" * len(value)
    return "%s...%s (len=%d)" % (value[:7], value[-4:], len(value))


def _looks_local(url):
    """True when a URL points at localhost / a local-only host."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return True
    if not host:
        return True
    return host in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or host.endswith(
        ".local"
    )


def _to_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


_last_diag_signature = None


def _log_diagnostics(diag):
    """Log a masked, actionable summary whenever the AI config changes."""
    global _last_diag_signature
    signature = (
        diag["key_source"],
        _mask_secret(diag["api_key"]),
        diag["endpoint"],
        diag["model"],
        tuple(diag["fallbacks"]),
        tuple(diag["issues"]),
        tuple(diag["key_notes"]),
    )
    if signature == _last_diag_signature:
        return
    _last_diag_signature = signature

    log.info(
        "AI config: key_source=%s key=%s endpoint=%s model=%s fallbacks=%d configured=%s",
        diag["key_source"],
        _mask_secret(diag["api_key"]),
        diag["endpoint"] or "(empty)",
        diag["model"] or "(empty)",
        len(diag["fallbacks"]),
        diag["configured"],
    )
    if diag["key_notes"]:
        log.info(
            "AI config: normalized API key (fixes 'User not found'): %s",
            "; ".join(diag["key_notes"]),
        )
    for issue in diag["issues"]:
        log.warning("AI config problem: %s", issue)


def resolve_ai_config(cfg, referer=None):
    """Build the AI settings the browser needs to call the provider.

    Environment variables take priority over config.yml so a Vercel deployment
    (where the file may be read-only) is fully configurable through project
    environment variables. Values are normalized and validated here so the
    frontend never receives an empty, malformed or double-prefixed key.
    """
    ai = cfg.get("ai") or {}
    app_cfg = cfg.get("app") or {}

    # --- API key: env first, then the config file, then normalized ---
    raw_key, env_key_name = _env_raw("OPENROUTER_API_KEY", "DEFFEN_API_KEY")
    if raw_key:
        api_key, key_notes = _normalize_api_key(raw_key)
        key_source = "env:%s" % env_key_name
    else:
        api_key, key_notes = _normalize_api_key(ai.get("api_key"))
        key_source = "config-file" if api_key else "none"

    endpoint = _resolve_value(
        ("OPENROUTER_API_URL", "OPENROUTER_ENDPOINT"), ai.get("endpoint")
    )
    model = _resolve_value(("OPENROUTER_MODEL", "DEFFEN_MODEL"), ai.get("model"))

    # --- Fallback endpoints (never localhost on a deployment) ---
    fallbacks = []
    env_fallbacks, _ = _env_raw("OPENROUTER_FALLBACKS", "DEFFEN_FALLBACKS")
    if env_fallbacks:
        candidates = env_fallbacks.split(",")
    else:
        candidates = ai.get("fallbacks") or []
    seen = {endpoint}
    for url in candidates:
        cleaned = _clean_str(url)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            fallbacks.append(cleaned)

    timeout_ms = _to_int(
        _resolve_value(("OPENROUTER_TIMEOUT_MS", "DEFFEN_TIMEOUT_MS"), ai.get("timeout_ms")),
        120000,
    )

    system_prompt = _resolve_value(
        ("OPENROUTER_SYSTEM_PROMPT", "DEFFEN_SYSTEM_PROMPT"), ai.get("system_prompt")
    )

    referer = _resolve_value(
        ("OPENROUTER_REFERER",), app_cfg.get("owner_website") or referer
    )
    title = _resolve_value(("OPENROUTER_TITLE",), app_cfg.get("name")) or "Deffen AI"

    # --- Validation: explains a real problem instead of masking the error ---
    issues = []
    if not api_key:
        issues.append(
            "api_key is empty - set OPENROUTER_API_KEY (Vercel env) or ai.api_key "
            "in config.local.yml"
        )
    elif not api_key.startswith("sk-or-"):
        issues.append(
            "api_key does not start with 'sk-or-' - it is likely not a real "
            "OpenRouter key (currently from %s)" % key_source
        )
    if not endpoint:
        issues.append("endpoint is empty - set OPENROUTER_API_URL")
    elif _looks_local(endpoint):
        issues.append(
            "endpoint points at localhost (%s) - production must use "
            "https://openrouter.ai/api/v1/chat/completions" % endpoint
        )
    if not model:
        issues.append("model is empty - set OPENROUTER_MODEL")

    diag = {
        "endpoint": endpoint,
        "fallbacks": fallbacks,
        "api_key": api_key,
        "model": model,
        "timeout_ms": timeout_ms,
        "system_prompt": system_prompt,
        "referer": referer,
        "title": title,
        "max_history_messages": _to_int(app_cfg.get("max_history_messages"), 31),
        "configured": bool(api_key and endpoint and model),
        # Diagnostics (never sent to the browser via /api/config).
        "key_source": key_source,
        "key_notes": key_notes,
        "key_format_ok": bool(api_key) and api_key.startswith("sk-or-"),
        "issues": issues,
    }
    _log_diagnostics(diag)
    return diag


def create_app(config=None):
    """Application factory that builds and returns the Flask app."""
    fixed_cfg = config

    def current_cfg():
        return fixed_cfg if fixed_cfg is not None else get_config()

    app = Flask(
        __name__,
        template_folder="templates",
        static_folder="static",
        static_url_path="/static",
    )
    app.config["SECRET_KEY"] = (
        current_cfg().get("server", {}).get("secret_key") or "dev-only-insecure-secret"
    )
    app.config["JSON_SORT_KEYS"] = False

    # Ensure Vercel's proxy headers are honoured (https + host).
    try:  # pragma: no cover - depends on werkzeug version
        from werkzeug.middleware.proxy_fix import ProxyFix

        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    except Exception:  # pragma: no cover - defensive
        pass

    # ------------------------------------------------------------------
    # Security: keep server-side files unreachable and only serve an
    # explicit allowlist of public asset types from /static.
    # ------------------------------------------------------------------
    @app.before_request
    def _block_sensitive_requests():
        raw_uri = request.environ.get("RAW_URI") or request.path
        if is_blocked_path(raw_uri) or is_blocked_path(request.path):
            abort(404)
        if request.path.startswith("/static/") and not is_allowed_static_request(
            request.path
        ):
            abort(404)

    @app.after_request
    def _apply_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault(
            "Referrer-Policy", "strict-origin-when-cross-origin"
        )
        response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
        return response

    def _render_error(code, title, message):
        """Render a generic error that never leaks paths or internals."""
        if request.path.startswith("/api/"):
            return jsonify({"error": title}), code
        return (
            render_template(
                "error.html",
                error_code=code,
                error_title=title,
                error_message=message,
            ),
            code,
        )

    @app.errorhandler(400)
    def _handle_400(error):
        return _render_error(
            400, "Bad request", "The request could not be processed."
        )

    @app.errorhandler(403)
    def _handle_403(error):
        return _render_error(
            403, "Access denied", "You do not have permission to view this resource."
        )

    @app.errorhandler(404)
    def _handle_404(error):
        return _render_error(
            404, "Page not found", "The page you were looking for is not available."
        )

    @app.errorhandler(405)
    def _handle_405(error):
        return _render_error(
            405, "Method not allowed", "That request method is not supported here."
        )

    @app.errorhandler(500)
    def _handle_500(error):
        log.exception("Unhandled server error")
        return _render_error(
            500, "Something went wrong", "An unexpected error occurred. Please try again later."
        )

    @app.context_processor
    def inject_config():
        """Inject sanitized config values into templates."""
        app_config = current_cfg().get("app", {}) or {}
        public = {
            "app_name": app_config.get("name", "Deffen AI"),
            "app_tagline": app_config.get("tagline", ""),
            "app_title": app_config.get("title", "Deffen AI"),
            "app_description": app_config.get("description", ""),
            "theme_color": app_config.get("theme_color", "#0f1115"),
            "favicon": app_config.get("favicon", "media/img/fav/favicon.png"),
            "logo": app_config.get("logo", "media/img/fav/favicon.png"),
            "loading_text": app_config.get("loading_text", "Loading..."),
            "welcome_title": app_config.get("welcome_title", "Deffen AI"),
            "welcome_sub": app_config.get("welcome_sub", ""),
            "composer_placeholder": app_config.get("composer_placeholder", ""),
            "sidebar_new_chat": app_config.get("sidebar_new_chat", "New chat"),
            "brand_note": app_config.get("brand_note", ""),
            "owner_website": app_config.get("owner_website", ""),
        }
        endpoint = request.endpoint or ""
        active_page = "chat" if endpoint == "chat_page" else "home"
        return {"app_cfg": public, "active_page": active_page}

    @app.route("/")
    def home():
        """Premium welcome / landing page."""
        return render_template("home.html")

    @app.route("/chat")
    def chat_page():
        """The existing Deffen AI chat interface."""
        return render_template("index.html")

    @app.route("/api/health")
    def health():
        """Liveness check plus non-sensitive configuration diagnostics.

        Deliberately exposes no key material — only where the key came from,
        whether its format is acceptable and what (if anything) was wrong.
        """
        ai_cfg = resolve_ai_config(current_cfg(), referer=request.url_root)
        app_config = current_cfg().get("app", {}) or {}
        return jsonify(
            {
                "status": "ok",
                "app": app_config.get("name", "Deffen AI"),
                "configured": ai_cfg["configured"],
                "key_source": ai_cfg["key_source"],
                "key_format_ok": ai_cfg["key_format_ok"],
                "key_notes": ai_cfg["key_notes"],
                "endpoint": ai_cfg["endpoint"],
                "model": ai_cfg["model"],
                "issues": ai_cfg["issues"],
            }
        )

    @app.route(AI_CONFIG_ROUTE)
    def client_config():
        """Return only the AI settings the browser needs for its own request.

        Deliberately narrow: no server paths, secrets, diagnostics or unrelated
        config are exposed. The response is never cached so backend edits take
        effect immediately.
        """
        resolved = resolve_ai_config(current_cfg(), referer=request.url_root)
        payload = {key: resolved[key] for key in CLIENT_CONFIG_KEYS}
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response

    return app


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    server = get_config().get("server", {}) or {}
    host = server.get("host", "127.0.0.1")
    port = int(server.get("port", 5000))
    debug = bool(server.get("debug", False))
    print(" * Deffen AI running at http://%s:%s" % (host, port))
    app.run(host=host, port=port, debug=debug)
