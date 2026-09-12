# Deffen AI — Flask + YAML

A Python **Flask** web app serving the Deffen AI chat interface. All configuration
lives in a single [`config.yml`](config.yml) file, and AI requests are proxied
**server-side**, so the API key is never exposed to the browser.

## Project layout

```
.
├── app.py                  # Flask app (routes + AI proxy)
├── config.yml              # All configuration (app, AI, server)
├── requirements.txt        # Python dependencies
├── templates/
│   └── index.html          # Jinja2 template (config injected)
├── static/
│   ├── style.css           # UI styles
│   ├── script.js           # Frontend logic (calls /api/chat)
│   └── media/img/...        # Logo + favicon
└── README.md
```

## Requirements

- Python 3.9+

## Setup

1. (Optional) Create and activate a virtual environment:

   ```bat
   python -m venv .venv
   .venv\Scripts\activate
   ```

2. Install dependencies:

   ```bat
   pip install -r requirements.txt
   ```

3. Edit [`config.yml`](config.yml) and set your `ai.api_key` and other settings.

## Run

```bat
python app.py
```

Then open <http://127.0.0.1:5000> in your browser.</br>
The host, port, and debug flag are read from the `server` section of `config.yml`.

## Configuration (`config.yml`)

| Section  | Key                     | Description                                             |
| -------- | ----------------------- | ------------------------------------------------------- |
| `app`    | `name`, `tagline`, ...  | Branding and UI strings injected into the template.     |
| `app`    | `max_history_messages`  | System prompt + max recent messages sent upstream.      |
| `ai`     | `api_key`               | Provider API key (**server-side only**).                |
| `ai`     | `endpoint` / `fallbacks`| Primary + fallback chat-completions URLs.               |
| `ai`     | `model`                 | Model identifier.                                       |
| `ai`     | `timeout_ms`            | Upstream request timeout in milliseconds.               |
| `ai`     | `system_prompt`         | Assistant persona prompt (injected server-side).        |
| `server` | `host`, `port`, `debug` | Flask dev server settings.                              |

Restart the server after editing `config.yml` to apply changes.

## API

| Method | Route         | Description                                            |
| ------ | ------------- | ------------------------------------------------------ |
| `GET`  | `/`           | Serves the chat UI.                                    |
| `GET`  | `/api/health` | Health check; reports whether the AI key is configured.|
| `POST` | `/api/chat`   | Accepts `{ "messages": [...] }`, returns `{ "content" }`.|

## Security notes

- The API key is stored in `config.yml` and used only by the server. It is never
  sent to the browser.
- The system prompt is injected server-side, so clients cannot override it.
- Do not commit a real API key to a public repository. Consider using an
  environment-specific copy of `config.yml` and adding it to `.gitignore`.
