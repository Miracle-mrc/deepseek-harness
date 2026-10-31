/** Credential parsing for OAuth connections and AWS CLI-backed MCP sessions. */

import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { parseAwsCliGrant, type AwsCliGrant } from './aws-grant.ts'
import type { CloudProvider } from './catalog.ts'
import { parseCloudGrant, type CloudGrant } from './oauth-provider.ts'

/** The private durable authorization forms accepted by the cloud connection owner. */
export type CloudConnectionGrant = CloudGrant | AwsCliGrant

/**
 * Validate a provider's durable session without interpreting malformed CLI grants as legacy OAuth.
 * @param provider - Provider whose credential record is being read.
 * @param record - Stored record, or undefined after disconnection.
 * @returns The matching validated grant, or undefined for missing or invalid records.
 */
export function parseConnectionGrant(provider: CloudProvider, record: CredentialRecord | undefined): CloudConnectionGrant | undefined {
  if (record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null && 'authMethod' in record.payload) {
    return provider === 'aws' ? parseAwsCliGrant(record) : undefined
  }
  return parseCloudGrant(provider, record)
}
