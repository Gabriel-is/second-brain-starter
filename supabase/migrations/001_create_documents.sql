-- Second Brain — documents table
-- Stores markdown documents that make up your knowledge base.
-- Documents can be added directly via Claude (add_doc tool) or
-- committed to GitHub for backup (commit_doc tool).

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  name text not null,          -- Document identifier, e.g. "til.md" or "notes/meeting.md"
  repo text not null,          -- Source tag: "direct" for docs added via Claude
  path text not null,          -- File path (same as name for direct docs)
  content text not null,       -- The actual markdown content
  token_estimate int,          -- Approximate token count (content length / 4)
  updated_at timestamptz default now()
);

-- Fast lookups by document name (used by get_doc, remove_doc, commit_doc)
create index if not exists idx_documents_name on documents(name);

-- Upsert support — add_doc uses onConflict: "name" to update existing docs
alter table documents add constraint uq_documents_name unique (name);
