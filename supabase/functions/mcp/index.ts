/**
 * Second Brain — MCP Server on Supabase Edge Functions
 *
 * This edge function implements the Model Context Protocol (MCP) using
 * Streamable HTTP transport. It's stateless — each request creates a
 * fresh server instance, which is the correct pattern for serverless.
 *
 * MCP is the protocol that lets Claude (and other AI assistants) discover
 * and use external tools. This server gives Claude six tools to manage
 * your personal knowledge base:
 *
 *   list_docs   — see everything in the knowledge base
 *   get_doc     — read a specific document
 *   search_docs — find documents by keyword
 *   add_doc     — save a new document (or update an existing one)
 *   remove_doc  — delete a document
 *   commit_doc  — push a document to GitHub for version control
 *
 * Key behaviors:
 *   - add_doc auto-injects a <!-- doc-id: {uuid} --> header on new documents.
 *     This enables collision detection if the same doc name is committed to
 *     GitHub from multiple sources.
 *   - Content size checks use byte length (not JS string length) so multi-byte
 *     characters like emoji and CJK text are measured correctly.
 *
 * Architecture:
 *   Claude <-> MCP Protocol <-> This Edge Function <-> Supabase (Postgres DB)
 *                                                   <-> GitHub (backup)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// --- Supabase client ---
// These env vars are set as Supabase secrets during setup.
// SUPABASE_URL: your project's API endpoint (e.g., https://abc123.supabase.co)
// SUPABASE_SERVICE_ROLE_KEY: full database access key (never expose to clients)
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CORS headers ---
// Required for browser-based MCP clients. Claude Desktop uses HTTP directly
// so it doesn't strictly need these, but they don't hurt.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
};

/**
 * Creates a fresh MCP server with all tools registered.
 * Called once per HTTP request — stateless pattern for serverless.
 *
 * Why stateless? Supabase Edge Functions can run on any server in any region.
 * There's no guarantee two requests hit the same instance. So each request
 * gets its own server, reads from the database, and responds. No sessions,
 * no in-memory state.
 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "second-brain",
    version: "1.0.0",
  });

  // ─── Tool: list_docs ───────────────────────────────────────────
  // Returns a summary of all documents — name, repo tag, and token estimate.
  // Claude calls this first to know what's in the knowledge base before
  // fetching specific content.
  //
  // Token estimate is approximate (content length / 4). It helps Claude
  // decide whether to fetch a doc or if it's too large for the context.
  server.tool(
    "list_docs",
    "List all available documents with their names, repos, and token estimates",
    {},
    async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("name, repo, token_estimate")
        .order("name");

      if (error) {
        return {
          content: [{ type: "text", text: `Error listing docs: ${error.message}` }],
          isError: true,
        };
      }

      if (data.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No documents yet. Use add_doc to save your first document.",
          }],
        };
      }

      const listing = data
        .map((d) => `${d.name} (${d.repo}, ~${d.token_estimate} tokens)`)
        .join("\n");

      return {
        content: [{
          type: "text",
          text: `Available documents (${data.length}):\n\n${listing}`,
        }],
      };
    },
  );

  // ─── Tool: get_doc ─────────────────────────────────────────────
  // Returns the full markdown content of a specific document.
  // The "name" field is what list_docs shows — treat it like a file path.
  //
  // Zod schemas define parameters. The MCP SDK converts them to JSON Schema
  // for the protocol, and validates arguments at runtime. If Claude sends
  // a bad argument, Zod catches it before your code runs.
  server.tool(
    "get_doc",
    "Get the full content of a specific document by name",
    {
      name: z.string().describe('Document name as shown by list_docs, e.g. "til.md" or "projects/my-app.md"'),
    },
    async ({ name }) => {
      const { data, error } = await supabase
        .from("documents")
        .select("name, content, token_estimate, updated_at")
        .eq("name", name)
        .single();

      if (error) {
        return {
          content: [{
            type: "text",
            text: `Document not found: "${name}". Use list_docs to see available documents.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `# ${data.name}\n_~${data.token_estimate} tokens | updated ${data.updated_at}_\n\n${data.content}`,
        }],
      };
    },
  );

  // ─── Tool: search_docs ─────────────────────────────────────────
  // Keyword search across all documents using Postgres ILIKE.
  // Returns matching document names with a snippet of context.
  //
  // ILIKE is case-insensitive pattern matching. The % wildcards mean
  // "match anything before/after the query". Simple but effective for
  // small datasets. For thousands of documents you'd upgrade to
  // tsvector (full-text search) or pgvector (semantic search).
  server.tool(
    "search_docs",
    "Search across all documents by keyword. Returns matching document names and snippets.",
    {
      query: z.string().describe("Search keyword or phrase"),
    },
    async ({ query }) => {
      // Escape ILIKE special characters so user input is literal text.
      // Without this, searching for "100%" or "user_name" gives wrong results
      // because % and _ are ILIKE wildcards.
      const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const { data, error } = await supabase
        .from("documents")
        .select("name, repo, content, token_estimate")
        .ilike("content", `%${escaped}%`);

      if (error) {
        return {
          content: [{ type: "text", text: `Search error: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text", text: `No documents found matching "${query}".` }],
        };
      }

      // Build snippets — show ~200 chars of context around the match.
      // Note: ILIKE can match where JS indexOf doesn't (whitespace/newline
      // handling differs). If indexOf returns -1, show the doc without a snippet.
      const results = data.map((doc) => {
        const idx = doc.content.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) {
          return `**${doc.name}** (${doc.repo}, ~${doc.token_estimate} tokens)`;
        }
        const start = Math.max(0, idx - 100);
        const end = Math.min(doc.content.length, idx + query.length + 100);
        const snippet =
          (start > 0 ? "..." : "") +
          doc.content.slice(start, end) +
          (end < doc.content.length ? "..." : "");

        return `**${doc.name}** (${doc.repo}, ~${doc.token_estimate} tokens)\n> ${snippet}`;
      });

      return {
        content: [{
          type: "text",
          text: `Found ${data.length} document(s) matching "${query}":\n\n${results.join("\n\n")}`,
        }],
      };
    },
  );

  // ─── Tool: add_doc ─────────────────────────────────────────────
  // Creates or updates a document in the knowledge base.
  // "Upsert" means: if a document with this name exists, overwrite it.
  // If it doesn't exist, create it.
  //
  // Documents added this way get tagged with repo="direct" to distinguish
  // them from documents that were synced from GitHub.
  //
  // Auto-injects a <!-- doc-id: {uuid} --> header on new documents.
  // This invisible HTML comment enables collision detection — if the same
  // document name is committed to GitHub from multiple sources, the doc-id
  // lets you tell them apart. Documents that already have a doc-id header
  // (e.g., re-saves of existing docs) keep their original ID.
  server.tool(
    "add_doc",
    "Add or update a document in the knowledge base. Upserts by name — if a document with that name exists, it gets overwritten.",
    {
      name: z.string().describe('Document name/path, e.g. "notes/meeting-2026-02-27.md" or "recipes/pasta.md"'),
      content: z.string().describe("The full markdown content of the document"),
    },
    async ({ name, content }) => {
      // Guard against oversized documents. This endpoint is public (no JWT
      // verification), so without a size limit anyone with the URL could
      // fill your free-tier database (500MB).
      const MAX_CONTENT_BYTES = 512_000; // 500KB — generous for markdown

      // Use TextEncoder to get actual byte length, not JS string length.
      // String.length counts UTF-16 code units — emoji and CJK chars would
      // slip past a naive .length check because they're multi-byte in UTF-8.
      // Example: "Hello" is 5 bytes, but a single emoji like 🎉 is 4 bytes
      // while String.length reports it as 2 (a surrogate pair).
      const contentBytes = new TextEncoder().encode(content).length;
      if (contentBytes > MAX_CONTENT_BYTES) {
        return {
          content: [{
            type: "text",
            text: `Content too large (${(contentBytes / 1024).toFixed(0)}KB). Maximum is ${MAX_CONTENT_BYTES / 1024}KB.`,
          }],
          isError: true,
        };
      }

      // Auto-inject doc-id if not already present.
      // The doc-id is an invisible HTML comment at the top of the document.
      // It survives markdown rendering (HTML comments are stripped by renderers)
      // and provides a stable identity for the document content, independent
      // of the filename. If a user re-saves a document that already has a
      // doc-id, we preserve the existing one.
      let finalContent = content;
      if (!content.startsWith("<!-- doc-id:")) {
        const docId = crypto.randomUUID();
        finalContent = `<!-- doc-id: ${docId} -->\n${content}`;
      }

      // Rough token estimate: ~4 characters per token for English text.
      // Not exact, but good enough for Claude to gauge document size.
      // We estimate on finalContent (after doc-id injection) so the header
      // is included in the count.
      const token_estimate = Math.ceil(finalContent.length / 4);

      const { error } = await supabase
        .from("documents")
        .upsert(
          {
            name,
            repo: "direct",
            path: name,
            content: finalContent,
            token_estimate,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "name" },
        );

      if (error) {
        return {
          content: [{ type: "text", text: `Error saving document: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Saved "${name}" (~${token_estimate} tokens). Use get_doc to retrieve it.`,
        }],
      };
    },
  );

  // ─── Tool: remove_doc ──────────────────────────────────────────
  // Deletes a document from the database by exact name match.
  // Uses a single delete-and-return query instead of select-then-delete.
  // This avoids a TOCTOU race (another request could delete between
  // the check and the delete) and is simpler code.
  server.tool(
    "remove_doc",
    "Remove a document from the knowledge base by name. Use list_docs to see available names.",
    {
      name: z.string().describe('Exact document name to remove, e.g. "mentor.md" or "notes/old-notes.md"'),
    },
    async ({ name }) => {
      const { data, error } = await supabase
        .from("documents")
        .delete()
        .eq("name", name)
        .select("name");

      if (error) {
        return {
          content: [{ type: "text", text: `Error removing document: ${error.message}` }],
          isError: true,
        };
      }

      if (!data || data.length === 0) {
        return {
          content: [{
            type: "text",
            text: `Document "${name}" not found. Use list_docs to see available documents.`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text",
          text: `Removed "${name}" from the knowledge base.`,
        }],
      };
    },
  );

  // ─── Tool: commit_doc ──────────────────────────────────────────
  // Pushes a document from the knowledge base to your GitHub repo.
  // Uses the GitHub Contents API to create or update a file with a real
  // git commit. This gives you version history and a backup outside Supabase.
  //
  // How it works:
  // 1. Fetch the document content from Supabase
  // 2. Check if the file already exists on GitHub (need its SHA to update)
  // 3. Base64-encode the content (GitHub API requirement)
  // 4. PUT to the GitHub Contents API to create/update the file
  server.tool(
    "commit_doc",
    "Push a document from the knowledge base to GitHub for version control. Defaults to unsorted/ if no path is specified.",
    {
      name: z.string().describe('Document name in knowledge base, e.g. "mentor.md" or "docs/curl.md"'),
      path: z.string().optional().describe('File path in the repo, e.g. "notes/mentor.md". Defaults to unsorted/{name}'),
      message: z.string().optional().describe("Commit message. Defaults to a generated one."),
    },
    async ({ name, path, message }) => {
      // These are set as Supabase secrets during setup
      const githubToken = Deno.env.get("GITHUB_PAT");
      const githubOwner = Deno.env.get("GITHUB_OWNER");
      const githubRepo = Deno.env.get("GITHUB_REPO");

      if (!githubToken || !githubOwner || !githubRepo) {
        return {
          content: [{
            type: "text",
            text: "GitHub not configured. Run setup.sh or set GITHUB_PAT, GITHUB_OWNER, and GITHUB_REPO as Supabase secrets.",
          }],
          isError: true,
        };
      }

      // Fetch the document from the database
      const { data: doc, error: fetchError } = await supabase
        .from("documents")
        .select("name, content")
        .eq("name", name)
        .single();

      if (fetchError || !doc) {
        return {
          content: [{
            type: "text",
            text: `Document "${name}" not found. Use list_docs to see available documents.`,
          }],
          isError: true,
        };
      }

      // Default path: unsorted/{filename}
      const fileName = name.includes("/") ? name.split("/").pop()! : name;
      const targetPath = path || `unsorted/${fileName}`;

      // Basic path validation — prevent directory traversal attacks.
      // Without this, a path like "../../.github/workflows/evil.yml" could
      // write to unexpected locations in the repo.
      if (targetPath.includes("..") || targetPath.startsWith("/")) {
        return {
          content: [{
            type: "text",
            text: `Invalid path: "${targetPath}". Paths cannot contain ".." or start with "/".`,
          }],
          isError: true,
        };
      }

      const commitMessage = message || `Update ${targetPath} via second-brain`;

      // Check if the file already exists on GitHub.
      // The GitHub Contents API requires the file's current SHA to update it.
      // If the file doesn't exist yet, we omit the SHA to create it.
      const existingRes = await fetch(
        `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${targetPath}`,
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );

      let sha: string | undefined;
      if (existingRes.ok) {
        const existing = await existingRes.json();
        sha = existing.sha;
      }

      // Base64-encode the content. The GitHub Contents API only accepts
      // base64-encoded file content — it doesn't take raw text.
      const encodedContent = btoa(
        new TextEncoder().encode(doc.content).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          "",
        ),
      );

      // Create or update the file on GitHub
      const putRes = await fetch(
        `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${targetPath}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: commitMessage,
            content: encodedContent,
            ...(sha ? { sha } : {}),
          }),
        },
      );

      if (!putRes.ok) {
        const err = await putRes.text();
        return {
          content: [{ type: "text", text: `GitHub API error (${putRes.status}): ${err}` }],
          isError: true,
        };
      }

      const result = await putRes.json();
      const action = sha ? "Updated" : "Created";

      return {
        content: [{
          type: "text",
          text: `${action} ${targetPath} in ${githubOwner}/${githubRepo}\nCommit: ${result.commit.sha.slice(0, 7)} — ${commitMessage}`,
        }],
      };
    },
  );

  return server;
}

// --- Main HTTP handler ---
// Deno.serve is the standard way to create an HTTP server in Deno.
// Supabase Edge Functions use this under the hood.
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // MCP endpoint — this is where Claude sends tool calls
  if (url.pathname.endsWith("/mcp") && req.method === "POST") {
    // Stateless pattern: fresh server + transport per request.
    // sessionIdGenerator: undefined means we don't track sessions.
    // Correct for serverless — no shared state between invocations.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    const server = createMcpServer();
    await server.connect(transport);

    // handleRequest parses the JSON-RPC message, routes it to the right
    // tool handler, and returns the HTTP response.
    const response = await transport.handleRequest(req);

    // Merge CORS headers into the response
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      headers.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  // Health check / info endpoint (GET requests)
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        name: "second-brain",
        version: "1.0.0",
        description: "Personal AI knowledge base — MCP server",
        mcp_endpoint: "/mcp",
      }),
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: CORS_HEADERS,
  });
});
