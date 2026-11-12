import { hashPassword, verifyPassword } from './password.js';
import { canonicalUsername, validateDisplayName } from './player-identity.js';

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
  verify = verifyPassword,
): Promise<AuthenticationResult> {
  const credential = await repository.findCredentialByUsername(canonicalUsername(username));
  // A non-user dummy hash uses the same cost/salt encoding as provisioning.
  const valid = await verify(credential?.passwordHash ?? (await dummyHash()), password);
  if (!credential || !valid) {
    return { status: 'invalid_credentials' };
  }
  return { status: 'authenticated', player: credential.player };
}

let dummy: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword('non-user dummy verification input'));
}

/** Trusted account creation; public registration adds validation and bounded admission. */
export async function provisionPlayer(
  repository: Pick<PlayerCredentials, 'createPlayerWithCredential'>,
  username: string,
  displayName: string,
  password: string,
): Promise<PlayerProfile> {
  username = canonicalUsername(username);
  validateDisplayName(displayName);
  const passwordHash = await hashPassword(password);
  return repository.createPlayerWithCredential(username, displayName, passwordHash);
}
