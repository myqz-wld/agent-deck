import { BrowserLeaseRegistryCore } from './browser-lease-registry-core';

let registry: BrowserLeaseRegistryCore | null = null;

/** Shared production registry. Tests may replace it through the repository setX/getX convention. */
export function getBrowserLeaseRegistry(): BrowserLeaseRegistryCore {
  registry ??= new BrowserLeaseRegistryCore();
  return registry;
}

export function setBrowserLeaseRegistry(value: BrowserLeaseRegistryCore | null): void {
  registry = value;
}
