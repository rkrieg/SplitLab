-- Allow pages to be created as drafts (no HTML yet) before the first build
ALTER TABLE pages ALTER COLUMN html_url DROP NOT NULL;
