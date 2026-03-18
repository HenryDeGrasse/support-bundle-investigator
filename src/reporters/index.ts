export type {
  SpecRecommendation,
  SpecRecommendationType,
  ReportFormat,
  ReportOptions,
  InvestigationReport,
} from './types.js';

export { generateSpecRecommendations } from './spec-recommender.js';
export { generateJsonReport, writeJsonReport } from './json-reporter.js';
export { generateMarkdownReport, writeMarkdownReport } from './markdown-reporter.js';
export { generateHtmlReport, writeHtmlReport } from './html-reporter.js';
export { buildReport } from './report-builder.js';
export {
  cleanEvidencePath,
  humanizeTitle,
  humanizeReasoning,
  collapseEvidence,
  formatSummaryCard,
} from './display-helpers.js';
