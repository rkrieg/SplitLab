CREATE OR REPLACE FUNCTION update_integration_tokens(
  p_integration_id uuid,
  p_access_token   text,
  p_refresh_token  text,
  p_expires_at     text
)
RETURNS void AS $$
BEGIN
  UPDATE workspace_integrations
  SET config = config
    || jsonb_build_object(
         'access_token',  p_access_token,
         'refresh_token', p_refresh_token,
         'expires_at',    p_expires_at
       )
  WHERE id = p_integration_id;
END;
$$ LANGUAGE plpgsql;
