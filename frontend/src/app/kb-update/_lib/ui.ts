/** Shared kb-update route visuals aligned with app tokens (light AI shell). */

export const kbPageShell =
  "h-full min-h-0 w-full overflow-x-hidden overflow-y-auto overscroll-y-contain bg-[var(--app-bg)]";

export const kbSection = (maxWidthClass: string) =>
  `${kbPageShell} mx-auto ${maxWidthClass} space-y-6 p-6 md:p-10`;

export const kbCard =
  "rounded-2xl border border-[var(--app-border)] bg-white shadow-[var(--app-shadow-sm)]";

export const kbCardPadding = "p-5 md:p-6";

export const kbPrimaryBtn =
  "inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-[var(--app-primary)] to-[var(--app-primary-strong)] px-4 py-2 text-sm font-medium text-white shadow-[var(--app-shadow-sm)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45";

export const kbSecondaryBtn =
  "inline-flex items-center justify-center rounded-xl border border-[var(--app-border)] bg-white px-4 py-2 text-sm font-medium text-[var(--app-text)] transition hover:bg-[var(--app-surface-soft)]";

export const kbGhostLink =
  "rounded-xl border border-[var(--app-border)] px-3 py-1.5 text-sm font-medium text-[var(--app-text)] hover:bg-[var(--app-surface-soft)]";

export const kbInput =
  "w-full rounded-xl border border-[var(--app-border)] bg-white px-3 py-2 text-sm text-[var(--app-text)] outline-none transition focus:border-[var(--app-primary)] focus:ring-2 focus:ring-[var(--app-primary)]/20";

export const kbSelect = kbInput;

export function kbJobStatusBadgeClass(status: string): string {
  if (status === "SUCCESS") return "bg-[var(--app-success-soft)] text-[var(--app-success)]";
  if (status === "FAILED") return "bg-[var(--app-danger-soft)] text-[var(--app-danger)]";
  if (status === "RUNNING") return "bg-[var(--app-primary-soft)] text-[var(--app-primary)]";
  if (status === "CANCELLED") return "bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]";
  return "bg-[var(--app-warning-soft)] text-[var(--app-warning)]";
}

export function kbStepStatusBadgeClass(status: string): string {
  if (status === "success")
    return "bg-[var(--app-success-soft)] text-[var(--app-success)] ring-1 ring-[var(--app-success-soft)]";
  if (status === "failed")
    return "bg-[var(--app-danger-soft)] text-[var(--app-danger)] ring-1 ring-[var(--app-danger-soft)]";
  if (status === "running")
    return "bg-[var(--app-primary-soft)] text-[var(--app-primary)] ring-1 ring-[var(--app-primary-soft)]";
  if (status === "skipped")
    return "bg-[var(--app-warning-soft)] text-[var(--app-warning)] ring-1 ring-[var(--app-warning-soft)]";
  return "bg-[var(--app-surface-muted)] text-[var(--app-text-muted)] ring-1 ring-[var(--app-border)]";
}

export function kbStepDotClass(status: string): string {
  if (status === "success") return "bg-[var(--app-success)]";
  if (status === "failed") return "bg-[var(--app-danger)]";
  if (status === "running") return "bg-[var(--app-primary)]";
  if (status === "skipped") return "bg-[var(--app-warning)]";
  return "bg-[var(--app-text-subtle)]";
}
