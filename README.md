# OCR MCP Server

An MCP (Model Context Protocol) server that transcribes Spanish children's books stored as PDFs in Google Drive, using Claude Haiku for OCR. Exposes tools and an interactive UI you can use directly from Claude Desktop chat.

---

## Prerequisites

- **Node.js 20+** — [nodejs.org](https://nodejs.org)
- **npm 10+** (bundled with Node.js)
- **Claude Desktop** — [claude.ai/download](https://claude.ai/download)
- An **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- A **Google Cloud project** with OAuth 2.0 credentials (see below)
- A **Google Drive folder** containing the PDF books

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-username/your-repo.git
cd your-repo

# 2. Install dependencies
npm install

# 3. Configure your environment
cp .env.example .env
# Edit .env with your API keys and folder ID (see Configuration below)

# 4. Build the UI and server
npm run build:all
```

Then [add the server to Claude Desktop](#adding-to-claude-desktop) and restart.

---

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```env
ANTHROPIC_API_KEY=sk-ant-...

GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback

GOOGLE_DRIVE_FOLDER_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs

DATABASE_PATH=./data/books.db
CREDENTIALS_PATH=./credentials
```

The `.env` file lives in the project folder alongside the server. It is gitignored and never committed. The `data/` and `credentials/` directories are created automatically on first run.

---

## Google Cloud Setup

You need OAuth 2.0 credentials so the server can read your Google Drive.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create or select a project.

2. Enable the **Google Drive API** under **APIs & Services → Library**.

3. Create credentials:
   - **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/oauth/callback`
   - Copy the **Client ID** and **Client Secret** into `.env`

4. Configure the consent screen:
   - **APIs & Services → OAuth consent screen → External**
   - Fill in app name and email, add scope `.../auth/drive.readonly`
   - Add your Google account as a **Test user**

5. Find your **Drive folder ID** from the URL:
   `https://drive.google.com/drive/folders/`**`1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs`**

---

## Adding to Claude Desktop

Edit the Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ocr-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/your-repo/dist/index.js"]
    }
  }
}
```

The server reads its API keys from the `.env` file in the project directory — no need to duplicate them in the Claude Desktop config. Use the full absolute path to `dist/index.js`.

Restart Claude Desktop after saving.

---

## First Run & Google Auth

The first time you trigger any Google Drive operation (e.g. `list_books`), the server will:

1. Start a local web server on port 3000
2. Open your browser to the Google OAuth consent screen
3. Store the granted token in `credentials/oauth-token.json`

Subsequent runs reuse and auto-refresh the token.

---

## Usage

Once connected in Claude Desktop you can use these tools in chat, or open the interactive viewer:

### Interactive UI

```
Open the transcription viewer
```

Opens the **Transcription Viewer** — a UI embedded directly in chat where you can:
- Browse your book library with transcription status
- Trigger transcription on un-transcribed books
- Click into any book to read its transcription page by page
- Inline-edit individual pages to fix OCR errors
- Tag pages with narrative labels (inciting incident, climax, etc.)

### Chat Tools

| Tool | Description |
|------|-------------|
| `list_books` | List Drive PDFs and their transcription status |
| `transcribe_books` | Download and OCR one or more books |
| `check_batch` | Poll an Anthropic Batch API job |
| `get_transcription` | Retrieve stored transcription text |
| `update_page` | Manually correct a specific page |
| `tag_page` | Set narrative tags on a page |

**Transcribe a book:**
```
Transcribe "Lina tiene dos mamás.pdf"
```

**Transcribe all books via Batch API (cheaper, async):**
```
Transcribe all books using the batch API
```

**Get a transcription:**
```
Show me pages 1–5 of "El monstruo de colores"
```

---

## Build Commands

```bash
npm run build       # Build MCP server → dist/
npm run build:app   # Build web app → app/dist/
npm run build:all   # Both server + web app
npm run dev         # Run MCP server directly with tsx
npm run dev:server  # Run the local HTTP backend (for the web app)
npm run dev:app     # Run backend + Vite dev server together → http://localhost:5173
npm start           # Run compiled dist/index.js
```

---

## Project Structure

```
.
├── src/
│   ├── index.ts              # MCP stdio server entry, all tool registrations
│   ├── core/                 # Shared business logic (used by MCP + HTTP)
│   │   ├── book-service.ts   # Public facade for non-MCP consumers
│   │   ├── database.ts       # SQLite/Postgres adapter
│   │   ├── google-drive.ts   # OAuth2 + Drive list/download
│   │   ├── ocr.ts            # Claude OCR (single + Batch API)
│   │   └── render-pdf.ts     # PDF page rendering (pdfjs-dist + canvas)
│   ├── tools/                # One file per MCP tool
│   └── http/                 # Local HTTP backend for the web app
│       ├── server.ts         # Express app factory
│       ├── start.ts          # Standalone Node entry
│       └── routes/           # REST routes (delegate to core/book-service)
├── app/                      # React web app (Vite)
│   ├── index.html
│   ├── main.tsx
│   ├── App.tsx
│   └── dist/                 # Built web app (gitignored)
├── dist/                     # Compiled MCP server JS
├── data/                     # SQLite database (gitignored)
├── credentials/              # OAuth token (gitignored)
├── .env                      # Your API keys (gitignored)
├── .env.example              # Copy this to .env
├── vite.config.ts            # Web app build config
├── tsconfig.json             # MCP server TypeScript config
├── tsconfig.app.json         # Web app TypeScript config
└── package.json
```

---

## Database

`data/books.db` (SQLite) stores:

- **books** — one row per Drive PDF: title, file ID, page count, status
- **pages** — one row per page: transcription, illustration flag, edit history, tags
- **batch_jobs** — Anthropic Batch API job tracking

The schema migrates automatically on startup — safe to run after pulling updates.

---

## License

MIT
