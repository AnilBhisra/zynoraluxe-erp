/** Client-safe links to the sticker print page (src/app/stickers). Codes only — never an id. */
export function stickerHref(opts: { receipt?: string; pieces?: string[]; reprint?: boolean; back?: string; size?: string }): string {
  const p = new URLSearchParams();
  if (opts.receipt) p.set("receipt", opts.receipt);
  for (const c of opts.pieces ?? []) p.append("piece", c);
  if (opts.size) p.set("size", opts.size);
  if (opts.reprint) p.set("reprint", "1");
  if (opts.back) p.set("back", opts.back);
  return `/stickers?${p.toString()}`;
}
