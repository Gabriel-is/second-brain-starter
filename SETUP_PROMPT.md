# Setup Prompt

Copy everything below the line and paste it into a new Claude conversation. Claude will walk you through the entire setup.

---

I want to set up a "second brain" — a personal knowledge base that connects to you (Claude) so you can remember things about me across conversations. I'm following the guide from the second-brain-starter repo.

Here's what I need to end up with:
- A Supabase project with a database table for storing documents
- An MCP server (edge function on Supabase) that gives you 6 tools: list_docs, get_doc, search_docs, add_doc, remove_doc, commit_doc
- My GitHub repo as a backup destination
- You connected to the MCP server so you can use these tools

I've already forked the repo from https://github.com/Entropy-Vibe/second-brain-starter

Walk me through the setup step by step. At each step:
1. Tell me what we're doing and why (I want to understand, not just copy-paste)
2. Give me the exact commands or UI steps
3. Wait for me to confirm before moving on
4. If something goes wrong, help me troubleshoot

Here's what I know about the architecture:
- The MCP server is a Deno TypeScript edge function that runs on Supabase
- It uses the MCP SDK to expose tools that Claude can call
- Documents are stored in a Postgres table with a name, content, and metadata
- The server is stateless — each request creates a fresh instance (correct for serverless)
- GitHub backup works via the GitHub Contents API (base64-encoded file content)
- The server is deployed with --no-verify-jwt so Claude can call it without auth tokens

The setup steps are:
1. Create free accounts (GitHub, Supabase) — I may already have these
2. Fork the repo and clone it locally
3. Install prerequisites (Node.js 18+, Supabase CLI)
4. Link my Supabase project (`supabase link`)
5. Create the database table (`supabase db push`)
6. Set secrets on Supabase (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_PAT, GITHUB_OWNER, GITHUB_REPO)
7. Deploy the MCP server (`supabase functions deploy mcp --no-verify-jwt`)
8. Seed the starter documents (tid.md, til.md, learn.md, mentor.md)
9. Connect you (Claude) to the MCP server URL
10. Verify it works by listing documents

OR I can run `./setup.sh` which does steps 4-8 automatically. Help me decide which path is right for me.

Let's start. What do I need to have ready before we begin?
