"use client";

import { useActionState, useRef } from "react";

import { createStaffAccount } from "@/app/actions/settings";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function AddStaffForm() {
  const [state, formAction, pending] = useActionState(createStaffAccount, undefined);
  const formRef = useRef<HTMLFormElement>(null);

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const name = formData.get("name");
    const email = formData.get("email");
    if (!window.confirm(`Create a Staff account for ${name} (${email})?`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-4"
      noValidate
    >
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Staff account created.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Name" name="name" required />
        <Field label="Email" name="email" type="email" required />
        <Field
          label="Temporary password"
          name="password"
          type="password"
          minLength={8}
          hint="At least 8 characters"
          required
        />
      </div>

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Creating…" : "Add staff account"}
      </Button>
    </form>
  );
}
