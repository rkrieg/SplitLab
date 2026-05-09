// ============================================================
// SplitLab – Core TypeScript Types
// ============================================================

export type UserRole = 'admin' | 'manager' | 'viewer' | 'super_admin';
export type UserStatus = 'active' | 'inactive';
export type ClientStatus = 'active' | 'archived';
export type WorkspaceStatus = 'active' | 'archived';
export type TestStatus = 'draft' | 'active' | 'paused' | 'completed';
export type GoalType = 'form_submit' | 'button_click' | 'url_reached' | 'call_click';
export type ScriptType = 'gtm' | 'meta_pixel' | 'ga4' | 'custom';
export type ScriptPlacement = 'head' | 'body_end';
export type EventType = 'pageview' | 'conversion';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface Client {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  status: ClientStatus;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  client_id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  created_at: string;
  updated_at: string;
}

export interface Test {
  id: string;
  workspace_id: string;
  name: string;
  url_path: string;
  status: TestStatus;
  created_at: string;
  updated_at: string;
}

export interface TestVariant {
  id: string;
  test_id: string;
  name: string;
  redirect_url: string | null;
  proxy_mode: boolean;
  traffic_weight: number;
  is_control: boolean;
  variant_type: string | null;
  hosted_url: string | null;
  created_at: string;
}

export interface ConversionGoal {
  id: string;
  test_id: string;
  name: string;
  type: GoalType;
  selector: string | null;
  url_pattern: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface Event {
  id: string;
  test_id: string;
  variant_id: string;
  goal_id: string | null;
  visitor_hash: string;
  type: EventType;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface Script {
  id: string;
  workspace_id: string;
  page_id: string | null;
  name: string;
  type: ScriptType;
  content: string;
  placement: ScriptPlacement;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Page {
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

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface Invite {
  id: string;
  email: string;
  role: UserRole;
  workspace_id: string | null;
  token: string;
  expires_at: string;
  created_at: string;
}
