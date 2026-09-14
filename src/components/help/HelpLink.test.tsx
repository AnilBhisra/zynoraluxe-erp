import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HelpLink } from "./HelpLink";

describe("HelpLink", () => {
  it("links to the anchored section of /help", () => {
    render(<HelpLink anchor="accounting" />);
    expect(screen.getByRole("link", { name: /મદદ/ })).toHaveAttribute("href", "/help#accounting");
  });

  it("uses a different anchor per module page", () => {
    for (const anchor of ["accounting", "diamond", "metal-jewellery", "costing", "settings"]) {
      const { unmount } = render(<HelpLink anchor={anchor} />);
      expect(screen.getByRole("link")).toHaveAttribute("href", `/help#${anchor}`);
      unmount();
    }
  });
});
