type VisibilitySource = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

function cancelled() {
  return new DOMException("Card details request cancelled.", "AbortError");
}

function waitForVisible(signal: AbortSignal, visibility: VisibilitySource): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      visibility.removeEventListener("visibilitychange", check);
      signal.removeEventListener("abort", check);
    };
    const check = () => {
      if (signal.aborted) {
        cleanup();
        reject(cancelled());
      } else if (!visibility.hidden) {
        cleanup();
        resolve();
      }
    };
    visibility.addEventListener("visibilitychange", check);
    signal.addEventListener("abort", check);
    check();
  });
}

// Wallet authentication may finish in the background. Fetch only after returning
// to this tab. An app switch during the sensitive fetch requires a new click;
// its late response must not reappear, even if the tab is already visible again.
export async function revealWhenVisible<T>(
  request: () => Promise<T>,
  {
    signal,
    isCurrent,
    visibility = document,
  }: {
    signal: AbortSignal;
    isCurrent: () => boolean;
    visibility?: VisibilitySource;
  },
): Promise<T> {
  if (signal.aborted || !isCurrent()) throw cancelled();
  await waitForVisible(signal, visibility);
  if (signal.aborted || !isCurrent()) throw cancelled();
  let hiddenDuringRequest = false;
  const hide = () => {
    if (visibility.hidden) hiddenDuringRequest = true;
  };
  visibility.addEventListener("visibilitychange", hide);
  try {
    const result = await request();
    if (signal.aborted || !isCurrent() || hiddenDuringRequest || visibility.hidden)
      throw cancelled();
    return result;
  } finally {
    visibility.removeEventListener("visibilitychange", hide);
  }
}
