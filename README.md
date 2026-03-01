# second-brain-starter

A template for building a personal AI knowledge base that connects to Claude via MCP. Fork it, set it up, and your AI remembers you across every conversation.

**Cost: $0.** Everything runs on free tiers.

## What You Get

- **Cloud knowledge base** — markdown documents stored in Supabase, searchable from any Claude conversation
- **6 MCP tools** — list, get, search, add, remove, and commit-to-GitHub
- **GitHub backup** — version-controlled history of every document
- **Starter documents** — activity log, learning log, knowledge tracker, mentor prompt
- **Setup script** — interactive setup with auto and guided modes

## Quick Start

**Option A: Let Claude walk you through it (recommended)**

1. Fork this repo
2. Open a new Claude conversation
3. Paste the contents of [SETUP_PROMPT.md](./SETUP_PROMPT.md)
4. Follow along — Claude handles the rest

**Option B: Run the setup script**

```bash
git clone https://github.com/YOUR-USERNAME/second-brain-starter.git
cd second-brain-starter
./setup.sh
```

**Option C: Manual setup** — see [Architecture](#architecture) below, then follow the steps in the setup prompt yourself.

## Prerequisites

Free accounts on:
- [GitHub](https://github.com) — you probably have this
- [Supabase](https://supabase.com) — sign up with GitHub for easy linking
- [Claude](https://claude.ai) — Pro subscription recommended but free works

You'll also need:
- Node.js 18+ ([download](https://nodejs.org))
- Supabase CLI (`npm install -g supabase` or `brew install supabase/tap/supabase`)

## Architecture

```
You ↔ Claude ↔ MCP Protocol ↔ Edge Function ↔ Supabase (Postgres DB)
                                             ↔ GitHub (backup)
```

| Component | What it does | Free tier limit |
|-----------|-------------|-----------------|
| **Supabase** | Database + edge function hosting | 500MB DB, 500K function calls/month |
| **Edge Function** | MCP server — the bridge between Claude and your data | Runs on Supabase free tier |
| **GitHub** | Version-controlled backup of your documents | Unlimited private repos |
| **Claude** | Your AI assistant that reads/writes the knowledge base | Free tier or Pro |

## MCP Tools

Once connected, Claude has these tools:

| Tool | What it does |
|------|-------------|
| `list_docs` | See all documents with names and sizes |
| `get_doc` | Read a specific document |
| `search_docs` | Find documents by keyword |
| `add_doc` | Save a new document or update an existing one |
| `remove_doc` | Delete a document |
| `commit_doc` | Push a document to GitHub as a real git commit |

## Starter Documents

| Document | Purpose |
|----------|---------|
| `tid.md` | **Things I Did** — activity log. Claude updates this as you work. |
| `til.md` | **Today I Learned** — knowledge log for new concepts. |
| `learn.md` | **Learning tracker** — Queue → Active → Solid progression. |
| `mentor.md` | **Mentor prompt** — defines how Claude behaves with your knowledge base. Customize this. |

## Connecting to Claude

After setup, you'll have an MCP server URL like `https://abc123.supabase.co/functions/v1/mcp`.

### Claude.ai (Web)
Settings → MCP Servers → Add your server URL

### Claude Code (Terminal)
Add to `.mcp.json` in your project:
```json
{
  "mcpServers": {
    "second-brain": {
      "type": "http",
      "url": "https://YOUR-PROJECT-REF.supabase.co/functions/v1/mcp"
    }
  }
}
```

### Claude Desktop
Add to your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "second-brain": {
      "type": "http",
      "url": "https://YOUR-PROJECT-REF.supabase.co/functions/v1/mcp"
    }
  }
}
```

## Security

Your MCP server URL is effectively a password. Anyone who has it can read, write, and delete documents in your knowledge base. **Don't share it publicly.**

The server runs without JWT verification (`--no-verify-jwt`) so Claude can call it without auth tokens. This is the right tradeoff for a personal knowledge base — simplicity over access control. But it means:

- Don't post your URL in public repos, blog posts, or tweets
- Don't include it in client-side code that gets shipped to browsers
- If you suspect it's been exposed, rotate your Supabase project (or redeploy to a new project)

For a personal KB with a few dozen markdown files, this is fine. If you're storing anything sensitive, consider adding authentication.

## Troubleshooting

**Claude can't find the MCP server**
- Check the URL is exact — copy from Supabase dashboard → Edge Functions
- Make sure the function was deployed with `--no-verify-jwt`

**Search isn't finding documents**
- Search uses case-insensitive substring matching. Partial words work.
- Verify the doc was saved: use `list_docs`

**GitHub commits aren't working**
- Check your PAT has Contents → Read and Write permission
- Make sure it's scoped to the correct repo
- Check the token hasn't expired

**Edge function errors**
- Check logs: Supabase dashboard → Edge Functions → Logs
- Common cause: secrets not set. Re-run `supabase secrets set` commands.

## Customizing

### The Mentor Prompt
Edit `mentor.md` in your knowledge base to change how Claude works with you. The default is a collaborative teacher — change it to whatever fits your style.

### Adding Documents
Just tell Claude: "Save this as notes/meeting.md in my knowledge base." Or use `add_doc` directly.

### Organizing
Document names are just strings — use path-style names for organization:
- `projects/my-app/plan.md`
- `notes/meeting-2026-03-01.md`
- `recipes/pasta.md`

## License

MIT

---

*Built by [Gabe](https://gabrielis.me). Read the full story: [How to Build a Second Brain for Your AI](https://gabrielis.me/blog/second-brain).*
