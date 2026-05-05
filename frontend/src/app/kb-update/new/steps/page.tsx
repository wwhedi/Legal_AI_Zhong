import { Suspense } from "react";
import { StepSelectionClient } from "./StepSelectionClient";

export const dynamic = "force-dynamic";

export default async function StepSelectionPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = (await searchParams) ?? {};
  const lawType = typeof sp.lawType === "string" ? sp.lawType : null;
  const storageRoot = typeof sp.storageRoot === "string" ? sp.storageRoot : null;
  const runMode = typeof sp.runMode === "string" ? sp.runMode : null;
  return (
    <Suspense
      fallback={
        <section className="mx-auto min-h-full w-full max-w-4xl space-y-6 bg-[var(--app-bg)] p-6 md:p-10">
          <p className="rounded-2xl border border-[var(--app-border)] bg-white p-4 text-sm text-[var(--app-text-muted)] shadow-[var(--app-shadow-sm)]">
            正在加载…
          </p>
        </section>
      }
    >
      <StepSelectionClient lawType={lawType} storageRoot={storageRoot} runMode={runMode} />
    </Suspense>
  );
}
