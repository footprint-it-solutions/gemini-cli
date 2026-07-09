/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SSOClient, GetRoleCredentialsCommand } from '@aws-sdk/client-sso';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { debugLogger } from '../../utils/debugLogger.js';

/**
 * Robustly resolve the correct AWS configuration/credentials home directory.
 */
function getAwsHomeDir(): string {
  const testHome = os.homedir();
  if (fs.existsSync(path.join(testHome, '.aws'))) {
    return testHome;
  }
  try {
    const realHome = os.userInfo().homedir;
    if (fs.existsSync(path.join(realHome, '.aws'))) {
      return realHome;
    }
  } catch {
    // Ignore and fallback
  }
  return testHome;
}

/**
 * Robustly resolve SSO credentials by manually parsing the AWS config file.
 * This provides a shared utility for all Bedrock-hosted model providers.
 */
export async function resolveSsoCredentials(profileName: string) {
  const awsHome = getAwsHomeDir();
  let configPath =
    process.env['AWS_CONFIG_FILE'] || path.join(awsHome, '.aws', 'config');
  if (configPath.startsWith('~/')) {
    configPath = path.join(awsHome, configPath.slice(2));
  }
  const configFile = configPath;

  if (!fs.existsSync(configFile)) {
    throw new Error(`AWS Config file does not exist at ${configFile}`);
  }

  const content = fs.readFileSync(configFile, 'utf-8');
  const profiles: Record<string, any> = {};
  const sessions: Record<string, any> = {};

  let currentSection: any = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[profile ') && trimmed.endsWith(']')) {
      const name = trimmed.substring(9, trimmed.length - 1);
      currentSection = profiles[name] = {};
    } else if (trimmed.startsWith('[sso-session ') && trimmed.endsWith(']')) {
      const name = trimmed.substring(13, trimmed.length - 1);
      currentSection = sessions[name] = {};
    } else if (currentSection && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=');
      currentSection[key.trim()] = valueParts.join('=').trim();
    }
  }

  const profile = profiles[profileName];
  if (!profile) {
    throw new Error(`Profile ${profileName} not found in ${configFile}`);
  }

  const sessionName = profile['sso_session'];
  const startUrl = sessionName
    ? sessions[sessionName]?.['sso_start_url']
    : profile['sso_start_url'];

  if (!startUrl) {
    throw new Error(`startUrl not found for profile ${profileName}`);
  }

  const ssoRegion =
    (sessionName ? sessions[sessionName]?.['sso_region'] : undefined) ||
    profile['sso_region'] ||
    profile['region'] ||
    'us-east-1';
  const accountId = profile['sso_account_id'];
  const roleName = profile['sso_role_name'];

  if (!accountId || !roleName) {
    throw new Error(
      `Profile ${profileName} is missing required SSO fields (sso_account_id, sso_role_name)`,
    );
  }

  const cacheDir = path.join(awsHome, '.aws', 'sso', 'cache');
  if (!fs.existsSync(cacheDir)) {
    throw new Error(`AWS SSO cache directory not found at ${cacheDir}`);
  }

  const cacheKey = sessionName || startUrl;
  const cacheFileName =
    crypto.createHash('sha1').update(cacheKey).digest('hex') + '.json';
  const cacheFilePath = path.join(cacheDir, cacheFileName);

  if (!fs.existsSync(cacheFilePath)) {
    throw new Error(`SSO cache file not found for ${profileName}`);
  }

  let tokenData: any;
  try {
    tokenData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
  } catch (e) {
    throw new Error(`Failed to read SSO cache file for ${profileName}`);
  }

  const accessToken = tokenData.accessToken;
  const expiresAt = tokenData.expiresAt;

  if (!accessToken) {
    throw new Error(
      `No valid SSO access token found in cache for ${profileName}`,
    );
  }

  if (expiresAt && new Date(expiresAt) < new Date()) {
    throw new Error(`SSO access token for ${profileName} has expired`);
  }

  debugLogger.log(
    `[AWS SSO] Fetching role credentials for ${profileName} (Account: ${accountId}, Role: ${roleName})`,
  );

  const ssoClient = new SSOClient({ region: ssoRegion });
  const response = await ssoClient.send(
    new GetRoleCredentialsCommand({
      accountId,
      roleName,
      accessToken,
    }),
  );

  if (
    !response.roleCredentials?.accessKeyId ||
    !response.roleCredentials?.secretAccessKey
  ) {
    throw new Error('SSO service returned invalid credentials');
  }

  return {
    accessKeyId: response.roleCredentials.accessKeyId,
    secretAccessKey: response.roleCredentials.secretAccessKey,
    sessionToken: response.roleCredentials.sessionToken,
    expiration: response.roleCredentials.expiration
      ? new Date(response.roleCredentials.expiration)
      : undefined,
  };
}
