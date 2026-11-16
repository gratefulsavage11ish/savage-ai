import { OpenAICompatibleAdapter } from './openai-compatible.js';
// Venice AI exposes an OpenAI-compatible API. Adapter exists so Venice-specific
// defaults/refusal handling can diverge without touching other providers.
export class VeniceAdapter extends OpenAICompatibleAdapter {
  id = 'venice'; label = 'Venice AI';
  constructor() { super({ defaultBaseUrl: 'https://api.venice.ai/api/v1', name: 'Venice AI' }); }
}
