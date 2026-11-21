export type CheckId = 'deps' | 'node' | 'env' | 'prisma-client' | 'migrations';

export interface Issue {
  id: CheckId;
  title: string;
  details: string[];
  fix?: string;
}

export interface Report {
  ok: boolean;
  issues: Issue[];
  skipped: { id: CheckId; reason: string }[];
}
