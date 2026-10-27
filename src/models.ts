/** Доменные типы приложения. */

export type VacancyStatus =
  | "new"
  | "analyzed"
  | "approved"
  | "rejected"
  | "applied";

export type ApplicationStatus =
  | "pending"
  | "sent"
  | "failed"
  | "viewed"
  | "rejected"
  | "invited";

export interface ParsedVacancy {
  platform: string;
  externalId: string;
  url: string;
  title: string;
  description?: string;
  companyName?: string;
  companyUrl?: string;
  salaryFrom?: number | null;
  salaryTo?: number | null;
  salaryCurrency?: string;
  location?: string;
  isRemote?: boolean;
  experience?: string;
  employmentType?: string;
  skills?: string[];
}

export interface Vacancy {
  id: number;
  platform: string;
  externalId: string;
  url: string;
  title: string;
  description: string | null;
  salaryFrom: number | null;
  salaryTo: number | null;
  salaryCurrency: string | null;
  location: string | null;
  isRemote: boolean;
  workFormat: "remote" | "hybrid" | "office" | null;
  experience: string | null;
  employmentType: string | null;
  skills: string | null;
  companyId: number | null;
  companyName?: string | null;
  status: VacancyStatus;
  score: number | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Application {
  id: number;
  vacancyId: number;
  platform: string;
  coverLetter: string | null;
  status: ApplicationStatus;
  errorMessage: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  vacancyTitle?: string | null;
  vacancyUrl?: string | null;
}

export interface RecruiterMessage {
  id: number;
  vacancyId: number | null;
  platform: string;
  senderName: string | null;
  senderCompany: string | null;
  text: string;
  isRead: boolean;
  externalThreadId: string | null;
  createdAt: string;
}

export interface NegotiationStatus {
  tab: "invitations" | "discard" | "pending";
  title: string;
  company: string;
  status: string;
  threadId?: string;
  topicUrl?: string;
  vacancyId?: string;
}

export type ApplyResult = true | "already" | false;

export interface ApplyOutcome {
  result: ApplyResult;
  error?: string;
  status?: number;
  data?: unknown;
  captcha?: boolean;
}

export interface AnalyzeResult {
  score: number;
  reason: string;
  isRelevant: boolean;
  seniority: string;
  redFlags: string[];
  stackMatch: number;
}

export interface CaptchaErrorInfo {
  url: string;
  requestId?: string;
}

export interface Stats {
  totalVacancies: number;
  newVacancies: number;
  analyzedVacancies: number;
  approvedVacancies: number;
  avgScore: number | null;
  sentToday: number;
  failedToday: number;
  sentTotal: number;
  messages: number;
  byPlatform: Array<{
    platform: string;
    vacancies: number;
    sentToday: number;
    sentTotal: number;
    messages: number;
  }>;
}
