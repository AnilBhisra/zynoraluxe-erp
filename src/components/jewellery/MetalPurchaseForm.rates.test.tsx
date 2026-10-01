/**
 * Phase 8B — Metal Purchase rate clarity. The rate input always names its
 * basis, the total is exact on that basis, both effective rates are shown,
 * the confirmation names the basis to be saved, and the collapsed "More
 * details" section never drops what was typed into it.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMetalPurchase } = vi.hoisted(() => ({ createMetalPurchase: vi.fn(async () => undefined) }));
vi.mock("@/app/actions/metal", () => ({ createMetalPurchase }));

import { MetalPurchaseForm } from "./MetalPurchaseForm";

const purities = [{ id: "p22", metalType: "GOLD", displayName: "22K", finenessPercent: "91.700" }];

function renderForm() {
  render(
    <MetalPurchaseForm
      suppliers={[{ id: "s1", name: "Bullion House", type: "SUPPLIER", stateCode: null }]}
      purities={purities}
      paymentAccounts={[{ id: "pa1", name: "HDFC", method: "BANK" }]}
      gstRates={[{ id: "g3", label: "GST 3%", ratePercent: "3" }]}
    />
  );
}

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  createMetalPurchase.mockClear();
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Metal Purchase — rate basis can never be confused", () => {
  it("labels the rate by basis and totals a FINE rate on the fine weight", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    expect(screen.getByLabelText(/Rate per GROSS gram/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Rate basis"), { target: { value: "PER_FINE_GRAM" } });
    fireEvent.change(screen.getByLabelText(/Rate per FINE gram/), { target: { value: "6500" } });
    expect((screen.getByLabelText(/Total purchase cost/) as HTMLInputElement).value).toBe("59605.00"); // 9.170 g × 6500
    expect(screen.getByTestId("rate-basis-hint")).toHaveTextContent("fine");
    expect(screen.getByTestId("effective-rates-basis")).toHaveTextContent("Per fine gram");
    expect(screen.getByTestId("effective-rates-gross")).toHaveTextContent("₹5,960.5000");
    expect(screen.getByTestId("effective-rates-fine")).toHaveTextContent("₹6,500.0000");
  });

  it("the confirmation names the saved basis, both rates and the payable; the form sends totalManuallyEdited=false", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Rate basis"), { target: { value: "PER_FINE_GRAM" } });
    fireEvent.change(screen.getByLabelText(/Rate per FINE gram/), { target: { value: "6500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metal purchase" }));
    const message = confirmSpy.mock.calls[0][0] as string;
    expect(message).toContain("Rate basis saved: Per fine gram at ₹6500");
    expect(message).toContain("₹5960.5000 per gross gram / ₹6500.0000 per fine gram");
    expect(message).toContain("10.000g gross × 91.700% = 9.170g fine");
    const fd = (createMetalPurchase.mock.calls[0] as unknown[])[1] as FormData;
    expect([fd.get("rateBasis"), fd.get("rate"), fd.get("totalPurchaseCost"), fd.get("totalManuallyEdited")]).toEqual(["PER_FINE_GRAM", "6500", "59605.00", "false"]);
  });

  it("a typed-over total is flagged as manual", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Rate per GROSS gram/), { target: { value: "6000" } });
    fireEvent.change(screen.getByLabelText(/Total purchase cost/), { target: { value: "59000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save metal purchase" }));
    expect(confirmSpy.mock.calls[0][0]).toContain("(Total was typed manually.)");
    const fd = (createMetalPurchase.mock.calls[0] as unknown[])[1] as FormData;
    expect(fd.get("totalManuallyEdited")).toBe("true");
  });

  it("payment, reference and notes typed into More details still save after the section is collapsed", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Rate per GROSS gram/), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: /More details/ }));
    fireEvent.change(screen.getByLabelText("Payment"), { target: { value: "pa1" } });
    fireEvent.change(screen.getByLabelText(/Supplier bill \/ reference/), { target: { value: "INV-77" } });
    fireEvent.change(screen.getByLabelText(/Notes \(optional\)/), { target: { value: "Paid same day" } });
    fireEvent.click(screen.getByRole("button", { name: /Hide more details/ }));
    expect(screen.getByTestId("purchase-more-details")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save metal purchase" }));
    const fd = (createMetalPurchase.mock.calls[0] as unknown[])[1] as FormData;
    expect([fd.get("paymentAccountId"), fd.get("referenceNumber"), fd.get("notes")]).toEqual(["pa1", "INV-77", "Paid same day"]);
  });
});
