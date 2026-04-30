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
        <section className="mx-auto w-full max-w-4xl space-y-6 p-6 md:p-10">
          <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            正在加载…
          </p>
        </section>
      }
    >
      <StepSelectionClient lawType={lawType} storageRoot={storageRoot} runMode={runMode} />
    </Suspense>
  );
}
