const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function normalizeOtelId(
  value: string | undefined,
  expectedByteLength: number
): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const expectedHexLength = expectedByteLength * 2;
  if (trimmed.length === expectedHexLength && /^[0-9a-f]+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (!BASE64_PATTERN.test(trimmed)) {
    return trimmed;
  }

  try {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length === expectedByteLength) {
      return bytes.toString("hex");
    }
  } catch {
    // Keep the original ID if it is not valid base64.
  }

  return trimmed;
}
