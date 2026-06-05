CREATE TABLE form_leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id       uuid NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  variant_id    uuid REFERENCES test_variants(id) ON DELETE SET NULL,
  visitor_hash  text,

  -- fixed metadata
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  ip_address    text,
  user_agent    text,
  utm_source    text,
  utm_medium    text,
  utm_content   text,
  utm_term      text,
  utm_campaign  text,
  gclid         text,

  -- dynamic form fields (whatever fields the form had)
  form_fields   jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX form_leads_test_id_idx ON form_leads(test_id);
CREATE INDEX form_leads_variant_id_idx ON form_leads(variant_id);
CREATE INDEX form_leads_submitted_at_idx ON form_leads(submitted_at);
