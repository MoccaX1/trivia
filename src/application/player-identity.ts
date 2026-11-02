const usernamePattern = /^[A-Za-z0-9_.-]{1,128}$/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function canonicalUsername(value: string): string {
  if (typeof value !== 'string' || !usernamePattern.test(value) || /[^A-Za-z0-9_.-]/.test(value)) {
    throw new TypeError('Invalid username');
  }
  return value.toLowerCase();
}

export function validateDisplayName(value: string): void {
  // Unicode format characters include ZWJ used by composed emoji; reject controls,
  // surrogates and directional overrides, while retaining legitimate composition.
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    /\p{Cf}/u.test(value.replace(/[\u200c\u200d]/g, '')) ||
    [...segmenter.segment(value)].length > 64
  )
    throw new TypeError('Invalid display name');
}
