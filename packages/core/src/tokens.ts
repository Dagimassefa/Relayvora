export interface TokenEstimate {
  tokens: number;
  method: 'chars/4';
  /** Always 'estimated': provider tokenizers differ, so never present this as a measured value. */
  confidence: 'estimated';
}

/** Rough, provider-agnostic token estimate for budgeting. Use provider-reported usage for any savings claim. */
export function estimateTokens(text: string): TokenEstimate {
  return { tokens: Math.ceil(text.length / 4), method: 'chars/4', confidence: 'estimated' };
}
