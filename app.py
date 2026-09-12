"""
Deffen AI — Flask application.

Loads all configuration from config.yml and serves the chat UI while proxying
AI requests to the configured OpenRouter endpoint server-side, so the API key
never leaves the server.
"""

import logging
import os
from urllib.parse import unquote

import requests
import yaml
from flask import Flask, abort, jsonify, render_template, request
from werkzeug.exceptions import BadRequest

CONFIG_PATH = "config.yml"

log = logging.getLogger("deffen")


# ---------------------------------------------------------------------------
# Security: HTTP requests must never be able to read server-side files.
# ---------------------------------------------------------------------------
# Files that must never be reachable over HTTP, regardless of location.
BLOCKED_FILENAMES = {
    "config.yml", "config.yaml", "config.json", "config.ini", "config.cfg",
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


def load_config(path=CONFIG_PATH):
    """Load the YAML configuration file."""
    with open(path, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    return cfg


CONFIG = load_config()


class AIResponseError(Exception):
    """Raised when the upstream AI service returns an error."""

    def __init__(self, message, status=None):
        super().__init__(message)
        self.message = message
        self.status = status


def extract_content(data):
    """Pull the reply text out of an OpenRouter-compatible response."""
    if not isinstance(data, dict):
        return None
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content
            delta = choice.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                return delta["content"]
            if isinstance(choice.get("text"), str):
                return choice["text"]
    if isinstance(data.get("content"), str):
        return data["content"]
    return None


def create_app(config=None):
    """Application factory that builds and returns the Flask app."""
    cfg = config or CONFIG

    app = Flask(
        __name__,
        template_folder="templates",
        static_folder="static",
        static_url_path="/static",
    )
    app.config["SECRET_KEY"] = (
        cfg.get("server", {}).get("secret_key") or "dev-only-insecure-secret"
    )
    app.config["JSON_SORT_KEYS"] = False

    app_config = cfg.get("app", {}) or {}
    ai_config = cfg.get("ai", {}) or {}

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

    def build_messages(raw_messages):
        """Validate/normalize incoming messages, prepending the system prompt."""
        if not isinstance(raw_messages, list) or not raw_messages:
            raise BadRequest("No messages provided.")

        system_prompt = (ai_config.get("system_prompt") or "").strip()

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        for item in raw_messages:
            if not isinstance(item, dict):
                continue
            role = str(item.get("role", "")).strip().lower()
            content = str(item.get("content", "")).strip()
            if role not in ("user", "assistant") or not content:
                continue
            messages.append({"role": role, "content": content})

        if len(messages) <= 1:  # only the system prompt was kept
            raise BadRequest("No valid user or assistant messages provided.")

        # Keep the system prompt plus at most N most recent messages.
        max_history = int(app_config.get("max_history_messages", 31))
        if len(messages) > max_history:
            messages = [messages[0], *messages[-(max_history - 1):]]
        return messages

    def fetch_once(url, api_key, model, messages, timeout, referer):
        """POST one request to the AI endpoint and parse the reply."""
        headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
            "HTTP-Referer": referer,
            "X-Title": app_config.get("name", "Deffen AI"),
        }
        payload = {"model": model, "messages": messages}

        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        if not resp.ok:
            detail = ""
            try:
                body = resp.json()
                err = body.get("error") if isinstance(body, dict) else None
                if isinstance(err, dict):
                    detail = str(err.get("message") or detail)
            except ValueError:
                pass
            if not detail:
                detail = resp.text[:240]
            raise AIResponseError(
                detail or ("The AI service responded with HTTP %s." % resp.status_code),
                status=resp.status_code,
            )

        try:
            data = resp.json()
        except ValueError as exc:
            raise AIResponseError(
                "The AI service returned a malformed response."
            ) from exc

        if isinstance(data, dict) and data.get("error"):
            err = data["error"]
            raise AIResponseError(
                err.get("message")
                if isinstance(err, dict)
                else "The AI service returned an error.",
                status=err.get("code") if isinstance(err, dict) else None,
            )

        content = extract_content(data)
        if content is None:
            raise AIResponseError("The AI service returned an unexpected response.")
        return content

    def call_ai(messages):
        """Call the primary endpoint, then any fallbacks on network errors."""
        api_key = (ai_config.get("api_key") or "").strip()
        model = ai_config.get("model") or ""
        timeout_ms = int(ai_config.get("timeout_ms", 120000) or 120000)
        timeout = timeout_ms / 1000.0

        primary = (ai_config.get("endpoint") or "").strip()
        fallbacks = [
            u.strip()
            for u in (ai_config.get("fallbacks") or [])
            if isinstance(u, str) and u.strip() and u.strip() != primary
        ]

        if not api_key:
            raise RuntimeError("AI service is not configured (missing API key).")
        if not model:
            raise RuntimeError("AI service is not configured (missing model).")
        if not primary.startswith(("http://", "https://")):
            raise RuntimeError("AI service endpoint is not configured correctly.")

        referer = app_config.get("owner_website") or request.url_root

        last_error = None
        for url in [primary] + fallbacks:
            try:
                return fetch_once(url, api_key, model, messages, timeout, referer)
            except requests.RequestException as exc:
                # Only fall through to the next endpoint on network-level errors.
                last_error = exc
                log.warning("Network error hitting %s: %s", url, exc)
            except AIResponseError:
                raise  # A real API error (auth/rate limit/model) — don't mask it.
        raise RuntimeError(
            "Could not reach the AI service. "
            "Please check your connection and try again."
        ) from last_error

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
        return jsonify(
            {
                "status": "ok",
                "app": app_config.get("name", "Deffen AI"),
                "configured": bool((ai_config.get("api_key") or "").strip()),
            }
        )

    @app.route("/api/chat", methods=["POST"])
    def chat():
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise BadRequest("Expected a JSON body.")

        messages = build_messages(payload.get("messages"))
        try:
            reply = call_ai(messages)
        except AIResponseError as exc:
            status = exc.status if isinstance(exc.status, int) else 502
            return jsonify({"error": exc.message}), status
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502
        except requests.Timeout:
            return (
                jsonify(
                    {
                        "error": (
                            "The request timed out. The model may be busy — "
                            "please try again."
                        )
                    }
                ),
                504,
            )

        if not reply.strip():
            return jsonify({"error": "The AI returned an empty response."}), 502
        return jsonify({"content": reply})

    return app


app = create_app()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    server = CONFIG.get("server", {})
    host = server.get("host", "127.0.0.1")
    port = int(server.get("port", 5000))
    debug = bool(server.get("debug", False))
    print(" * Deffen AI running at http://%s:%s" % (host, port))
    app.run(host=host, port=port, debug=debug)
