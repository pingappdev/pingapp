import { StrictMode, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

// The native shell has no server-rendered application state to preserve. Mount
// it as a SPA so an initial redirect cannot race React's shell hydration. The
// website continues using Start's default hydrateRoot client entry.
startTransition(() => {
  createRoot(document).render(
    <StrictMode>
      <StartClient />
    </StrictMode>,
  );
});
