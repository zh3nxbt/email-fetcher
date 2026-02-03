/**
 * QuickBooks Integration Module
 *
 * Provides access to QuickBooks Desktop via Conductor.is API
 */

export { ConductorClient, default as createConductorClient } from "./conductor-client.js";
export { createCustomerMatcher } from "./customer-matcher.js";
export type { MatchResult, CustomerMatcher } from "./customer-matcher.js";
export {
  getTrustedDomains,
  isDomainTrusted,
  extractDomain,
  filterTrustedEmails,
  getTrustedDomainsStats,
} from "./trusted-domains.js";
export {
  getCustomerJobDocuments,
  findMatchingSalesOrder,
  findMatchingEstimate,
  getJobDocumentsSummary,
} from "./job-documents.js";
export type {
  CustomerJobDocuments,
  GetJobDocumentsOptions,
  JobDocumentsSummary,
} from "./job-documents.js";
export * from "./types.js";
