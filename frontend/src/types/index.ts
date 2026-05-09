export interface Workspace {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  title: string;
  shell?: string;
  cwd?: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
