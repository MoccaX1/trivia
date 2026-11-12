// Wire bounds shared by Login and Register; creation-only rules stay in Register.
export function usernameError(value: string): string | undefined {
  if (!value) return;
  if (value.length > 128) return 'Use at most 128 characters.';
  if (/[^A-Za-z0-9_.-]/.test(value)) return 'Use A–Z, a–z, 0–9, _ . -; no spaces.';
  return;
}
export function passwordBytesError(value: string): string | undefined {
  return new TextEncoder().encode(value).length > 1024
    ? 'Use at most 1024 UTF-8 bytes.'
    : undefined;
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function displayNameError(value: string): string | undefined {
  if (!value) return;
  if (!value.trim()) return 'Choose a name that is not blank.';
  if (/[\p{Cc}\p{Cs}]/u.test(value) || /\p{Cf}/u.test(value.replace(/[\u200c\u200d]/g, '')))
    return 'Use a name without control characters.';
  if ([...segmenter.segment(value)].length > 64) return 'Use at most 64 text characters.';
  return;
}
