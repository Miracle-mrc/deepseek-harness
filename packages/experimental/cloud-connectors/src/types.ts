/** JSON-only connection state shared by the Host, Plugins UI, and CLI. */
import type { CloudProvider } from './catalog.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one private authorization prompt, invalidated when that prompt settles. */
export type CloudPromptId = Branded<'cloud-prompt'>

/** One admitted authorization operation, used to cancel only the initiating caller's login. */
export type CloudAttemptId = Branded<'cloud-attempt'>

/** Private browser response or explicit permission to replace an AWS profile login. */
export type CloudConnectionPrompt =
  | { id: CloudPromptId; kind: 'secret' }
  | { id: CloudPromptId; kind: 'select'; purpose: 'replace-aws-login' }

/** Official AWS CLI authentication route selected by the person connecting. */
export type AwsLoginMethod = 'login' | 'sso' | 'existing'

/** Non-secret AWS CLI selectors; credentials remain in the CLI's own store. */
export interface CloudStartOptions {
  /** Named AWS CLI profile to authenticate or reuse. */
  awsProfile?: string
  /** Browser login, an existing Identity Center profile, or previously configured credentials. */
  awsMethod?: AwsLoginMethod
}

/** Safe failure categories that clients translate without rendering provider error bodies. */
export type CloudConnectionErrorCode =
  | 'authorization-failed'
  | 'connection-failed'
  | 'session-expired'
  | 'aws-cli-required'
  | 'aws-login-failed'
  | 'aws-permission-required'

/** No OAuth token, provider registration or authorization code can enter this value. */
export interface CloudConnectionView {
  provider: CloudProvider
  status: 'not-connected' | 'authorizing' | 'choose-permissions' | 'connected' | 'failed'
  tools: Array<{ name: string; description: string }>
  enabledTools: string[]
  /** Safe failure category; provider messages and credentials are never exposed. */
  errorCode?: CloudConnectionErrorCode
  /** Browser destination retained for reconnecting or popup-blocked clients. */
  authorizationUrl?: string
  /** Public verification code to enter at the provider, when its device flow supplies one. */
  code?: string
  /** A response returned by the browser must travel only through complete(), never model tools. */
  prompt?: CloudConnectionPrompt
  /** Present only while this provider has an admitted sign-in operation. */
  attemptId?: CloudAttemptId
  /** Non-secret AWS CLI profile selected for this connection. */
  awsProfile?: string
  /** AWS authentication method selected for this connection. */
  awsMethod?: AwsLoginMethod
}

/** Browser hand-off for an authorization flow started on the Host. */
export interface CloudSignIn {
  /** Ownership of the admitted operation; its URL and prompt arrive through list(). */
  attemptId: CloudAttemptId
  /** May arrive later through list(); reusing an AWS CLI profile needs no browser URL. */
  url?: string
}
