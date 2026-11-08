import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyPanel } from "@/components/ui/empty-panel";

/**
 * Shown for a URL that matches no route.
 *
 * Unknown routes used to redirect straight to /runs, which then auto-selected a
 * trace — so a typo'd or stale link opened an unrelated run and looked like it
 * had worked. Naming the path that failed is the difference between "this link
 * is dead" and "this is the wrong trace and I cannot tell".
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex h-full items-center justify-center px-5 py-10 sm:px-10">
      <EmptyPanel
        className="w-full max-w-xl animate-fade-rise"
        titleAs="h1"
        eyebrow="404 / No matching route"
        title="Page not found"
        description={
          <>
            <p>Nothing in Run Phantom matches this address.</p>
            <code className="rp-meta mt-4 block break-all rounded-control border border-rp-line bg-rp-canvas-blue px-3 py-2 text-rp-ink">
              {location.pathname}
            </code>
          </>
        }
        action={
          <Button variant="primary" onClick={() => navigate("/runs", { replace: true })}>
            Back to runs
          </Button>
        }
      />
    </div>
  );
}
