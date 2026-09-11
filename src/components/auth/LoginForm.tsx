"use client";

import { useActionState } from "react";

import { login } from "@/app/actions/auth";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="username"
        placeholder="you@company.com"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />

      <Button type="submit" size="lg" disabled={pending} className="mt-1">
        {pending ? "Signing in…" : "Log in"}
      </Button>
    </form>
  );
}
