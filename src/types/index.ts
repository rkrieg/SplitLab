// ============================================================
// SplitLab – Core TypeScript Types
// ============================================================

export type UserRole = 'admin' | 'manager' | 'viewer';
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
  client?: Client;
}

export interface Domain {
  id: string;
  workspace_id: string;
  domain: string;
  cname_target: string | null;
  verified: boolean;
  verified_at: string | null;
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'manager' | 'viewer';
  created_at: string;
  user?: User;
}

export interface Page {
  id: string;
  workspace_id: string;
  name: string;
  slug: string | null;
  html_url: string;
  html_content: string | null;
  tags: string[];
  status: 'active' | 'archived';
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
  variants?: TestVariant[];
  goals?: ConversionGoal[];
}

export interface TestVariant {
  id: string;
  test_id: string;
  name: string;
  page_id: string | null;
  redirect_url: string | null;
  proxy_mode: boolean;
  traffic_weight: number;
  is_control: boolean;
  created_at: string;
  page?: Page;
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

// ---- Analytics types ----

export interface VariantStats {
  variant: TestVariant;
  views: number;
  conversions: number;
  cvr: number;
  confidence: number | null;
  isWinner: boolean;
}

export interface TestAnalytics {
  test: Test;
  variants: VariantStats[];
  totalViews: number;
  totalConversions: number;
}

// ---- NextAuth session extension ----
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: UserRole;
    };
  }
  interface User {
    id: string;
    email: string;
    name: string;
    role: UserRole;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string;
    role: UserRole;
  }
}
