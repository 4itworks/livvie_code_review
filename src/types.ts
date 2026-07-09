export interface ReviewFinding {
  severity: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  description: string;
  suggestion: string | null;
}

export interface StructuredReview {
  summary: string;
  findings: ReviewFinding[];
}

export interface DiffFile {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}
