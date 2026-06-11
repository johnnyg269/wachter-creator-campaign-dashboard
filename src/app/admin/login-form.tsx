"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Card } from "@/components/ui/card";

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "Login failed");
      }
    } catch {
      setError("Login request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="px-6 py-8">
      <div className="mb-4 flex items-center gap-2">
        <Lock size={16} className="text-accent" />
        <h1 className="text-sm font-semibold">Admin access</h1>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-muted" htmlFor="admin-password">
          Password
        </label>
        <input
          id="admin-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
        {error && <p className="text-xs text-negative">{error}</p>}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
