-- Add fbclid (Facebook Click ID) capture to form leads — mirrors gclid
ALTER TABLE form_leads ADD COLUMN fbclid text;
