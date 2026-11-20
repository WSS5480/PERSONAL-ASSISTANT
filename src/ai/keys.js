// Which Anthropic API key a user's chat runs on. Owner: env ANTHROPIC_API_KEY.
// Everyone else: their own assigned key; the env key only if the owner switched on "may use house key".
// No silent fallback.
export const NO_KEY_MESSAGE = 'No AI key assigned — ask the admin.';
export const OWNER_NO_KEY_MESSAGE = 'The AI key is not set up yet. Add ANTHROPIC_API_KEY in the Render environment settings.';

export function selectApiKey(user, config, secrets) {
  if (user.role === 'owner') {
    return config.anthropicApiKey ? { apiKey: config.anthropicApiKey, source: 'house' } : { error: OWNER_NO_KEY_MESSAGE };
  }
  if (user.ai_key_enc) {
    try { return { apiKey: secrets.decrypt(user.ai_key_enc), source: 'own' }; } catch { return { error: 'Your AI key could not be read — ask the admin to set it again.' }; }
  }
  if (user.house_key_allowed && config.anthropicApiKey) return { apiKey: config.anthropicApiKey, source: 'house' };
  return { error: NO_KEY_MESSAGE };
}
