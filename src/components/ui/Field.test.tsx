import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Field } from "./Field";

/** Every `id` attribute in the rendered DOM must be unique — the defect this
 * whole file guards against is two forms sharing a page each deriving an
 * `id` straight from a field's `name` (e.g. both having an "email" field),
 * which produces invalid duplicate-`id` HTML and breaks `<label>`-click
 * focus for whichever instance loses the collision. */
function assertNoDuplicateIds(container: HTMLElement) {
  const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
  const seen = new Set<string>();
  const duplicates = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  expect(duplicates).toEqual([]);
}

/** Every `<label htmlFor>` must point at an id that actually exists in the
 * DOM — otherwise clicking the label silently does nothing. */
function assertEveryLabelTargetExists(container: HTMLElement) {
  const labels = Array.from(container.querySelectorAll("label[for]"));
  for (const label of labels) {
    const target = label.getAttribute("for")!;
    expect(container.querySelector(`#${CSS.escape(target)}`)).not.toBeNull();
  }
}

describe("Field", () => {
  it("gives two same-named default-input fields distinct, non-colliding ids", () => {
    const { container } = render(
      <>
        <Field label="Email" name="email" />
        <Field label="Email" name="email" />
      </>
    );

    assertNoDuplicateIds(container);
    assertEveryLabelTargetExists(container);

    const inputs = screen.getAllByLabelText("Email");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);
  });

  it("focuses the correct input when its own label is clicked, even with a same-named sibling field", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Field label="Email" name="email" placeholder="first" />
        <Field label="Email" name="email" placeholder="second" />
      </>
    );

    const [firstLabel, secondLabel] = screen.getAllByText("Email");
    const [firstInput, secondInput] = screen.getAllByLabelText("Email");

    await user.click(secondLabel);
    expect(document.activeElement).toBe(secondInput);

    await user.click(firstLabel);
    expect(document.activeElement).toBe(firstInput);
  });

  it("keeps the `name` attribute (form-submission key) untouched regardless of id generation", () => {
    render(<Field label="Email" name="email" />);
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    expect(input.name).toBe("email");
  });

  it("respects an explicit id opt-out instead of generating one", () => {
    render(<Field label="Email" name="email" id="custom-explicit-id" />);
    const input = screen.getByLabelText("Email") as HTMLInputElement;
    expect(input.id).toBe("custom-explicit-id");
  });

  it("force-syncs a custom control's id to the label via cloneElement, even if the child hardcodes a colliding id", () => {
    const { container } = render(
      <>
        <Field label="Type" name="type">
          <select id="type">
            <option value="a">A</option>
          </select>
        </Field>
        <Field label="Type" name="type">
          <select id="type">
            <option value="a">A</option>
          </select>
        </Field>
      </>
    );

    assertNoDuplicateIds(container);
    assertEveryLabelTargetExists(container);

    const selects = screen.getAllByLabelText("Type");
    expect(selects).toHaveLength(2);
    expect(selects[0].id).not.toBe(selects[1].id);
    // Neither generated id is the literal hardcoded string both children
    // wrote in their own JSX — proving the override actually took effect
    // rather than coincidentally matching.
    expect(selects[0].id).not.toBe("type");
    expect(selects[1].id).not.toBe("type");
  });

  it("wires aria-describedby to hint/error ids that stay unique per instance", () => {
    const { container } = render(
      <>
        <Field label="Amount" name="amount" hint="In rupees" />
        <Field label="Amount" name="amount" hint="In rupees" />
      </>
    );

    assertNoDuplicateIds(container);
    const inputs = screen.getAllByLabelText("Amount");
    expect(inputs[0].getAttribute("aria-describedby")).not.toBe(
      inputs[1].getAttribute("aria-describedby")
    );
  });
});
