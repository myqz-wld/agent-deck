export interface BrowserViewPresentationLifecyclePort {
  parkAll(): void;
}

let port: BrowserViewPresentationLifecyclePort | null = null;

export function setBrowserViewPresentationLifecyclePort(
  value: BrowserViewPresentationLifecyclePort | null,
): void {
  port = value;
}

export function parkAllBrowserViews(): void {
  port?.parkAll();
}
