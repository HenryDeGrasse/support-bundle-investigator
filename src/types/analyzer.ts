export type AnalyzerSeverity = 'error' | 'warn' | 'pass' | 'info';

export interface AnalyzerResult {
  name: string;
  title: string;
  message: string;
  severity: AnalyzerSeverity;
  iconKey?: string;
  iconUri?: string;
  isPass: boolean;
  isFail: boolean;
  isWarn: boolean;
  uri?: string;
}
