-- Add is_published flag for AI pages (clean separation from status column)
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;

-- Add created_by to track which user generated the page
ALTER TABLE pages ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- Reset any rows with draft/published status BEFORE adding the constraint
UPDATE pages SET status = 'active' WHERE status IN ('draft', 'published');

-- Revert status constraint back to original meaning (active/archived only)
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_status_check;
ALTER TABLE pages ADD CONSTRAINT pages_status_check
  CHECK (status IN ('active', 'archived'));
