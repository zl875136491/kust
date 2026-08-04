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
