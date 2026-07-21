-- Capture the page the form was submitted from, so HubSpot form submissions can
-- report a Conversion Page instead of "Unavailable" (context.pageUri / context.pageName).
-- Nullable: leads captured before this migration, and any cached tracker.js still
-- running the old payload, simply leave these null.
ALTER TABLE form_leads ADD COLUMN page_url text;
ALTER TABLE form_leads ADD COLUMN page_title text;
