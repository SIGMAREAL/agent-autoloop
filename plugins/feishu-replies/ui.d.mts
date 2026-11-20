export function renderA2ui(view: unknown, options?: { image?: (url: string) => Promise<string | null> }): Promise<any>;
export function loadView(stateDir: string | undefined, ref: string): any;
export function saveView(stateDir: string, view: unknown): string;
export function pullRequestViews(result: any): any[];
export function pullRequestNotice(pr: {
  repo: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt?: string | null;
  avatarUrl?: string | null;
  state?: string;
  mergedAt?: string | null;
}): any;
export function issueCreatedView(repository: string, issue: any): any;
