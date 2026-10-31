/** Provider failures reduced to fixed, credential-free categories. */

import type { CloudConnectionErrorCode } from './types.ts'

const MESSAGES: Record<CloudConnectionErrorCode, string> = {
  'authorization-failed': 'Cloud authorization failed. Try connecting again.',
  'connection-failed': 'The cloud service could not be reached. Try connecting again.',
  'session-expired': 'The cloud session is no longer valid. Sign in again.',
  'aws-cli-required': 'Install or update to the latest AWS CLI v2, version 2.32.0 or newer, on the Harness Host.',
  'aws-login-failed': 'AWS CLI sign-in failed. Check the selected profile and try again.',
  'aws-permission-required': 'The AWS identity needs permission to create an AWS MCP access token.',
}

/** A safe public message with no provider response, command output, or error cause. */
export class CloudConnectionError extends Error {
  constructor(readonly code: CloudConnectionErrorCode) {
    super(MESSAGES[code])
    this.name = 'CloudConnectionError'
  }
}
