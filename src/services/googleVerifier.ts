import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { config } from '../config';

const client = new OAuth2Client();

// Isolated in its own module so tests can stub it without network access.
export async function verifyGoogleIdToken(idToken: string): Promise<TokenPayload | undefined> {
  if (!config.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is not configured');
  const ticket = await client.verifyIdToken({ idToken, audience: config.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
}
