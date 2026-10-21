// Test-only data-router entry: production navigation and server mounting remain coordinator owned.
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Link } from "react-router-dom";
import "@fontsource-variable/inter/wght.css";
import "../src/index.css";
import { ReviewQueuesRoute } from "../src/components/review-queues/ReviewQueuesRoute";
import { EvaluationsPage } from "../src/pages/EvaluationsPage";
import { queryClient } from "../src/query-client";
const router = createBrowserRouter([
  { path:"/tests-e2e/review-queue-component.html",element:<><Link className="sr-only focus:not-sr-only" to="/evaluations">Fixture evaluations navigation</Link><ReviewQueuesRoute /></> },
  { path:"/evaluations",element:<EvaluationsPage /> },
]);
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
