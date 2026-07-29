export function managedProxyShortId(id: string): string {
  return id.slice(-6)
}

export function managedProxyDisplayName(id: string): string {
  return `managed ${managedProxyShortId(id)}`
}
