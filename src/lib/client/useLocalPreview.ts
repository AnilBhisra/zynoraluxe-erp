import { useCallback, useEffect, useState } from "react";

/**
 * A browser-local preview (object URL) of the photo just uploaded, so the
 * user sees WHAT was uploaded — not only the word "Uploaded". The URL is
 * revoked when replaced and on unmount. Allowed by the CSP's `img-src blob:`.
 */
export function useLocalPreview(): [string | null, (file: File | null) => void] {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url]
  );
  const set = useCallback((file: File | null) => {
    setUrl(file && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null);
  }, []);
  return [url, set];
}
