-- Add head_scripts column to tests table for custom script injection in proxy mode
ALTER TABLE tests ADD COLUMN IF NOT EXISTS head_scripts TEXT;
