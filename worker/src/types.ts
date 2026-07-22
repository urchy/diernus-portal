// Shared types — Diernus Portal

export type Role = 'studio' | 'client';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'pending' | 'active' | 'suspended';
  created_at: string;
  last_seen_at: string | null;
}

export interface Project {
  id: string;
  client_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'completed' | 'archived';
  hourly_rate: number | null;
  budget_hours: number | null;
  due_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface KanbanColumn {
  id: string;
  project_id: string;
  name: string;
  position: number;
}

export type CardPriority = 'low' | 'medium' | 'high';

export interface Card {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string | null;
  position: number;
  priority: CardPriority;
  due_date: string | null;
  estimated_hours: number | null;
  actual_hours: number;
  assignee_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  card_id: string;
  user_id: string;
  body: string;
  created_at: string;
}

export interface FileRecord {
  id: string;
  project_id: string;
  card_id: string | null;
  filename: string;
  r2_key: string;
  size: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  name: string;
  role: Role;
  token: string;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  SESSIONS: KVNamespace;
  JWT_SECRET: string;
  RESEND_KEY: string;
  EMAIL_FROM: string;
  PUBLIC_URL: string;
  ENVIRONMENT: string;
  MAX_UPLOAD_MB: string;
}

// Variables/Helpers exported by Hono context
export type AppVariables = {
  user: User;
};
