import { hashPassword, verifyPassword } from './password.js';

export interface PlayerProfile {
  readonly id: string;
  readonly displayName: string;
}

export interface PlayerCredentials {
  findCredentialByUsername(
    username: string,
  ): Promise<{ readonly player: PlayerProfile; readonly passwordHash: string } | null>;
  createPlayerWithCredential(
    username: string,
    displayName: string,
    passwordHash: string,
  ): Promise<PlayerProfile>;
}

export type AuthenticationResult =
  | { readonly status: 'authenticated'; readonly player: PlayerProfile }
  | { readonly status: 'invalid_credentials' };

/** No session or transport context is created here. */
export async function authenticatePlayer(
  repository: Pick<PlayerCredentials, 'findCredentialByUsername'>,
  username: string,
  password: string,
): Promise<AuthenticationResult> {
  const credential = await repository.findCredentialByUsername(username);
  if (!credential || !(await verifyPassword(credential.passwordHash, password))) {
    return { status: 'invalid_credentials' };
  }
  return { status: 'authenticated', player: credential.player };
}

/** Controlled internal/test provisioning only; no public registration endpoint. */
export async function provisionPlayer(
  repository: Pick<PlayerCredentials, 'createPlayerWithCredential'>,
  username: string,
  displayName: string,
  password: string,
): Promise<PlayerProfile> {
  const passwordHash = await hashPassword(password);
  return repository.createPlayerWithCredential(username, displayName, passwordHash);
}
