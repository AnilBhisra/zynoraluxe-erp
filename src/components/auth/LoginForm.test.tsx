import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const mockLogin = vi.fn();

vi.mock("@/app/actions/auth", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

import { LoginForm } from "./LoginForm";

describe("LoginForm", () => {
  it("renders email and password fields with a submit button", () => {
    mockLogin.mockResolvedValue(undefined);
    render(<LoginForm />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /log in/i })).toBeInTheDocument();
  });

  it("shows the server-returned error message after a failed submission", async () => {
    mockLogin.mockResolvedValue({ error: "Incorrect email or password." });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), "owner@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong-password");
    await user.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Incorrect email or password.");
    });
  });
});
