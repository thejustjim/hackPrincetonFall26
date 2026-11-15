// The tank slot may represent real hardware, but its offline example is still
// generated data. Presentation must use observation provenance, not that slot.
export function isSimulatedNode(node, mode) {
  return mode === 'mock' || node?.sim === true || node?.mock === true ||
    node?.latest?.mock === true || node?.lastBefore?.mock === true;
}
