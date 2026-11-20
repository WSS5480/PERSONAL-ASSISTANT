// Reads environment variables once. Everything optional except SESSION_SECRET in production.
import crypto from 'node:crypto';

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (production) throw new Error('SESSION_SECRET is required in production');
    sessionSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] SESSION_SECRET not set - using a random one (dev only; sessions and stored secrets reset on restart)');
  }
  const appUrl = (env.APP_URL || '').replace(/\/+$/, '');
  return {
    production,
    port: Number(env.PORT) || 3000,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ASSISTANT_MODEL || 'claude-sonnet-5-5',
    databaseUrl: env.DATABASE_URL || '',
    sessionSecret,
    signupCode: env.SIGNUP_CODE || '',
    ownerEmail: (env.OWNER_EMAIL || '').trim().toLowerCase(),
    appUrl,
    secureCookies: production || appUrl.startsWith('https://'),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
    domoInstance: (env.DOMO_INSTANCE || '').replace(/\.domo\.com.*$/i, '').replace(/^https?:\/\//i, ''),
    githubToken: env.GITHUB_TOKEN || '',
    renderApiKey: env.RENDER_API_KEY || '',
  };
}
