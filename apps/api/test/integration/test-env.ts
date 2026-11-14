/**
 * Authentication settings for integration tests. Throwaway values, generated here so no
 * secret is ever needed to run the suite.
 *
 * Used by: every integration test that calls loadEnv().
 */
export const TEST_AUTH_ENV = {
  AUTH_TOKEN_SECRET: 'integration-test-token-secret-0123456789',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
} as const;
