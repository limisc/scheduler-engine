export type StepStatus = 'running' | 'completed' | 'failed';

export interface Step {
  id: string;
  status: StepStatus;

  run_id: string;
  name: string;
  attempt: number;

  output: unknown;
  error: string | null;

  started_at: Date;
  completed_at: Date | null;
}
