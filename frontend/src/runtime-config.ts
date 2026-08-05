function normalizeBasePath(value: string | null) {
  const trimmed = value?.trim() || '';
  if (!trimmed || trimmed === '/' || /^__[A-Z0-9_]+__$/.test(trimmed)) {
    return '';
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export const APP_BASE_PATH = normalizeBasePath(
  document.querySelector<HTMLMetaElement>('meta[name="kust-base-path"]')?.content ?? null,
);

// Port 5175 is reserved for the visual mock server so it never depends on a backend session.
export const MOCK_MODE = import.meta.env.DEV && (
  window.location.port === '5175' || new URLSearchParams(window.location.search).get('mock') === '1'
);
