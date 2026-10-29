export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_API_TOKEN: string;
  GITHUB_TOKEN: string;
  ADMIN_TOKEN: string;
  GITHUB_OWNER?: string;
  DISPATCH_TOKEN: string;
  SYNC_REPOSITORY: string;
  SYNC_REF: string;
}
export interface Evidence {
  kind: 'homepage' | 'pages-github' | 'CNAME' | 'config';
  repository: string;
  confidence: 'high';
}
export interface Candidate {
  hostname: string;
  sources: Set<string>;
  deployments: Set<string>;
  unsafe: boolean;
}
export interface Site {
  hostname: string;
  title: string | null;
  description: string | null;
  favicon_url: string | null;
  og_image_url: string | null;
  repository_url: string | null;
  repository_verified_at: string | null;
  repository_created_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  last_online_at: string | null;
  current_status: 'unknown' | 'online' | 'offline' | 'blocked';
  discovery_sources: string;
  matching_evidence: string;
  archived: number;
  visibility: 'auto' | 'public' | 'private';
  auto_public: number;
}
export type Fetch = typeof fetch;
