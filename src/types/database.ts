// Database row types — one interface per table, covering every column.
// These are the raw shapes returned from the db client.
// Application-level interfaces (without internal fields like password_hash)
// live in src/types/index.ts.

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  invite_token: string | null;
  invite_expires_at: string | null;
  created_at: string;
}

export interface ClientRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: string;
  client_id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMemberRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface DomainRow {
  id: string;
  workspace_id: string;
  domain: string;
  cname_target: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export interface PageRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string | null;
  html_url: string;
  html_content: string | null;
  tags: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface TestRow {
  id: string;
  workspace_id: string;
  name: string;
  url_path: string;
  status: string;
  head_scripts: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestVariantRow {
  id: string;
  test_id: string;
  name: string;
  page_id: string | null;
  redirect_url: string | null;
  proxy_mode: boolean;
  traffic_weight: number;
  is_control: boolean;
  variant_type: string | null;
  hosted_url: string | null;
  created_at: string;
}

export interface ConversionGoalRow {
  id: string;
  test_id: string;
  name: string;
  type: string;
  selector: string | null;
  url_pattern: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface EventRow {
  id: string;
  test_id: string;
  variant_id: string;
  goal_id: string | null;
  visitor_hash: string;
  type: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ScriptRow {
  id: string;
  workspace_id: string;
  page_id: string | null;
  name: string;
  type: string;
  content: string;
  placement: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface VariantPageRow {
  id: string;
  variant_id: string;
  html_storage_path: string;
  version: number;
  status: string;
  created_at: string;
}

export interface ScrapedPageRow {
  id: string;
  url: string;
  html_content: string | null;
  scraped_at: string;
}

export interface InviteTokenRow {
  id: string;
  user_id: string;
  token: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

// Map from table name → row type. Used by the db client for type inference.
export interface TableSchema {
  users: UserRow;
  clients: ClientRow;
  workspaces: WorkspaceRow;
  workspace_members: WorkspaceMemberRow;
  domains: DomainRow;
  pages: PageRow;
  tests: TestRow;
  test_variants: TestVariantRow;
  conversion_goals: ConversionGoalRow;
  events: EventRow;
  scripts: ScriptRow;
  variant_pages: VariantPageRow;
  scraped_pages: ScrapedPageRow;
  invite_tokens: InviteTokenRow;
}
