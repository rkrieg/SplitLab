export type Vertical = 'legal' | 'real_estate_financial' | 'saas' | 'local_services';

export interface BrandSettings {
  company_name?: string;
  primary_color?: string;
  secondary_color?: string;
  logo_url?: string;
  phone?: string;
  tone?: 'professional' | 'friendly' | 'urgent' | 'luxury' | 'casual';
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  score: number;
  detail: string;
}

export interface QualityResult {
  score: number;
  details: QualityCheck[];
}

export interface PageGenerationRequest {
  workspace_id: string;
  client_id: string;
  prompt: string;
  vertical: Vertical;
  brand_settings?: BrandSettings;
}

export interface UnsplashImage {
  url: string;
  alt: string;
  credit: string;
}

export type BuilderStep = 'prompt' | 'generating' | 'preview' | 'published';
