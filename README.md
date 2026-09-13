# Deffen AI — Flask + YAML

A Python **Flask** web app serving the Deffen AI chat interface. All AI
configuration (API key, API URL, model, system prompt, timeout, …) is stored and
managed by the **backend** in [`config.yml`](config.yml) (or environment
variables). The frontend asks the backend for those settings via the minimal
`/api/config` endpoint and then performs the actual AI request **directly** from
the browser — no API setting is hardcoded in the frontend JavaScript.

## How it works

```
Browser ──GET /api/config──▶ Flask backend ──reads──▶ config.yml / env vars
Browser ──POST (API key, model)──────────────▶ AI provider (OpenRouter)
```

1. The backend owns the AI configuration and exposes only what the browser needs
   through `/api/config` (never cached, so backend edits apply immediately).
2. The frontend fetches that configuration at startup.
3. The frontend makes the chat request to the configured endpoint directly and
   renders the reply exactly as before.

## Project layout

```
.
├── app.py                  # Flask app (routes + AI config endpoint)
├── config.yml              # Backend-managed configuration (app, AI, server)
├── requirements.txt        # Python dependencies
├── templates/
│   ├── home.html           # Landing page
│   └── index.html          # Chat interface (Jinja2 template)
├── static/
│   ├── style.css           # UI styles
│   ├── script.js           # Frontend logic (fetches /api/config, calls provider)
│   └── media/img/...       # Logo + favicon
├── vercel.json             # Vercel project configuration
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

3. Provide the API key **without committing it**. Either export it:

   ```bat
   set OPENROUTER_API_KEY=sk-or-v1-your-key
   ```

   …or create an untracked `config.local.yml` next to `config.yml` (it is
   git-ignored and merged on top of `config.yml`):

   ```yaml
   ai:
     api_key: "sk-or-v1-your-key"
   ```

   The remaining settings (`endpoint`, `model`, `timeout_ms`, …) already have
   sensible defaults in [`config.yml`](config.yml).

   > **Only set the keys you want to override.** The override is deep-merged on
   > top of `config.yml`, so a blank value (a bare `ai:` line with only comments
   > beneath it, or a placeholder like `endpoint: ""`) is ignored instead of
   > wiping the real value. This used to be a real bug: an empty `ai:` section
   > parsed to `{"ai": None}` and replaced the whole `ai` block, silently
   > emptying `endpoint` and `model` even though `config.yml` defined them.

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
| `app`    | `max_history_messages`  | System prompt + max recent messages sent to the model.  |
| `ai`     | `api_key`               | Provider API key. Empty by default — set it via env or `config.local.yml`. |
| `ai`     | `endpoint` / `fallbacks`| Primary + fallback chat-completions URLs (all `openrouter.ai`). |
| `ai`     | `model`                 | Model identifier.                                       |
| `ai`     | `timeout_ms`            | Request timeout in milliseconds.                        |
| `ai`     | `system_prompt`         | Assistant persona prompt (sent with every request).     |
| `server` | `host`, `port`, `debug` | Flask dev server settings.                              |

The file is reloaded automatically when it changes, so editing it is enough to
update the configuration the frontend receives.

### Environment variable overrides

Every AI value can be overridden with an environment variable (recommended for
deployments). Environment variables take priority over `config.yml`:

| Variable                    | Overrides                         |
| --------------------------- | --------------------------------- |
| `OPENROUTER_API_KEY`        | `ai.api_key`                      |
| `OPENROUTER_API_URL`        | `ai.endpoint`                     |
| `OPENROUTER_MODEL`          | `ai.model`                        |
| `OPENROUTER_FALLBACKS`      | `ai.fallbacks` (comma-separated)  |
| `OPENROUTER_TIMEOUT_MS`     | `ai.timeout_ms`                   |
| `OPENROUTER_SYSTEM_PROMPT`  | `ai.system_prompt`                |
| `OPENROUTER_REFERER`        | `app.owner_website`               |
| `OPENROUTER_TITLE`          | `app.name`                        |
| `DEFFEN_CONFIG`             | Path to an alternative `config.yml`|
| `DEFFEN_LOCAL_CONFIG`       | Path to the local override file (default `config.local.yml`)|

## API

| Method | Route          | Description                                             |
| ------ | -------------- | ------------------------------------------------------- |
| `GET`  | `/`            | Serves the landing page.                                |
| `GET`  | `/chat`        | Serves the chat UI.                                     |
| `GET`  | `/api/health`  | Health check + **non-sensitive** config diagnostics.    |
| `GET`  | `/api/config`  | Returns the AI settings the frontend needs (no-store).  |

`GET /api/config` returns a deliberately narrow payload — only the settings
required for the browser to call the provider:

```json
{
  "endpoint": "https://openrouter.ai/api/v1/chat/completions",
  "fallbacks": [],
  "api_key": "sk-or-...",
  "model": "...",
  "timeout_ms": 120000,
  "system_prompt": "You are Deffen AI...",
  "referer": "https://muntahi.devs.surf/",
  "title": "Deffen AI",
  "max_history_messages": 31,
  "configured": true
}
```

No server paths, file names or unrelated configuration are included, and the
response is sent with `Cache-Control: no-store`.

## Deploying on Vercel

- `app.py` exposes a module-level `app = create_app()`, which Vercel uses as the
  WSGI entrypoint. Config is resolved relative to `app.py`, so the working
  directory does not matter.
- Set the AI settings as **project environment variables**
  (**Project → Settings → Environment Variables**):

  | Variable               | Value                                                    |
  | ---------------------- | -------------------------------------------------------- |
  | `OPENROUTER_API_KEY`   | `sk-or-v1-...` (paste the **key only**)                  |
  | `OPENROUTER_API_URL`   | `https://openrouter.ai/api/v1/chat/completions`          |
  | `OPENROUTER_MODEL`     | e.g. `inclusionai/ling-3.0-flash-sante:free`             |

  Also set `OPENROUTER_REFERER` to your deployed URL if you want the
  `HTTP-Referer` header sent for OpenRouter attribution.

- **Environment scope matters.** A variable added under the wrong scope (e.g.
  Preview only) is `undefined` in Production. After changing an env var you must
  **redeploy** — existing deployments keep the old values.
- Keep `server.debug` disabled in production.

### "User not found." after deploying

OpenRouter returns `User not found.` when the `Authorization: Bearer <key>`
header does **not** contain a valid key. It is **not** a network or model error.
Check, in order:

1. **Diagnose from the health endpoint** (no key is exposed):

   ```bash
   curl https://<your-app>.vercel.app/api/health
   ```

   ```json
   { "configured": true, "key_source": "env:OPENROUTER_API_KEY",
     "key_format_ok": true, "issues": [] }
   ```

   - `key_source: "none"` → no key was found (env var empty/missing, or the
     wrong environment scope). Re-add it and redeploy. `config-file` means it
     came from a config file (`config.yml`/`config.local.yml`).
   - `key_format_ok: false` → the value is not an OpenRouter key
     (must start with `sk-or-`).
   - `issues` lists any concrete problem (empty key, localhost endpoint, …).

2. **The backend auto-corrects the most common cause.** A key pasted as
   `Bearer sk-or-...`, wrapped in quotes, split across lines, or with a stray
   `Authorization:` prefix is **normalized at request time**, so the browser
   only ever sends a single `Bearer <key>`. The Vercel function log shows:

   ```
   [deffen] AI config: normalized API key (fixes 'User not found'): removed 'Bearer' prefix
   ```

   The log also reports the masked key
   (`sk-or-v…f4b2 (len=73)`), the source and the endpoint host — never the full
   key.

3. **Confirm the key itself.** Verify it works outside the app:

   ```bash
   curl https://openrouter.ai/api/v1/chat/completions ^
     -H "Authorization: Bearer sk-or-v1-..." ^
     -H "Content-Type: application/json" ^
     -d "{\"model\":\"nex-agi/nex-n2.5-pro:free\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
   ```

   **Interpreting the response.** OpenRouter distinguishes the two failure modes
   clearly, which is how you tell a formatting bug from a dead key:

   | Request                     | Response                                    | Meaning                     |
   | --------------------------- | ------------------------------------------- | --------------------------- |
   | No `Authorization` header   | `401 {"message":"Missing Authentication header"}` | Header not sent at all |
   | Malformed/other key         | `401 {"message":"User not found."}`         | OpenRouter does not know this key |
   | A working key               | `200 { "choices": [ ... ] }`                | Authenticated               |

   If a valid-looking key returns exactly the same `User not found.` as a
   random fake key, the credential is **not active** — it was mistyped, deleted
   or **auto-revoked because it was committed to the repository**. Create a new
   key at <https://openrouter.ai/keys> and don't paste the old one back in.
   A key that was ever committed to a public repo must be treated as
   compromised and rotated immediately.

### Checking the key, URL and model independently

`GET /api/health` reports the three values (masked where sensitive):

```bat
curl -s http://127.0.0.1:5000/api/health
```

They fail for different reasons, so check them separately:

- **URL** — `endpoint` should be
  `https://openrouter.ai/api/v1/chat/completions`. A wrong URL produces a
  network/`404`/CORS error, **never** `User not found.`.
- **Model** — verify the id exists with
  `GET https://openrouter.ai/api/v1/models` (a public, unauthenticated list).
  An unknown model returns a `model`/`400` error, **never** `User not found.`
  (e.g. `nex-agi/nex-n2.5-pro:free` is present in the list).
- **API key** — the only value that produces `User not found.`. If it does, the
  URL and model are irrelevant: the key is dead. A blank key (the default)
  yields `configured: false` and the
  "The AI assistant is not configured yet." message instead.

For a Vercel deployment, set `OPENROUTER_API_KEY` in
**Project → Settings → Environment Variables** (Production scope) and redeploy;
the local `config.local.yml` is not deployed.

## Security notes

- The browser calls the AI provider directly, so the API key is delivered to the
  client at runtime via `/api/config` and will be visible in the browser's
  network tab. Use a **restricted, revocable** key and never commit a real key to
  a public repository — prefer environment variables with a `config.yml` that
  contains no secrets.
- The AI requests originate from the user's browser; make sure the provider
  allows browser (CORS) requests from your deployed origin.
- The system prompt and history cap are still supplied by the backend, so the
  assistant's behaviour stays centrally controlled.
- The backend continues to block access to `config.yml`, source files, and every
  non-asset path over HTTP.
