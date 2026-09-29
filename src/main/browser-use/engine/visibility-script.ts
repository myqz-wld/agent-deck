/** Visibility shared by snapshots, selector waits and background keyboard navigation. */
export const OPEN_DOM_VISIBILITY = `
  function styledVisible(node, transparentControl) {
    var current = node;
    for (var depth = 0; current && depth < 128; depth += 1) {
      var view = current.ownerDocument && current.ownerDocument.defaultView;
      var style = view && view.getComputedStyle ? view.getComputedStyle(current) : null;
      if (current.hidden || current.inert) return false;
      if (style && ((current === node && (style.visibility === 'hidden' || style.visibility === 'collapse'))
        || style.display === 'none'
        || (style.opacity === '0' && current !== transparentControl))) return false;
      var root = current.getRootNode && current.getRootNode();
      current = current.parentElement || (root && root.host) || null;
    }
    return !current;
  }
  function ownVisible(node) {
    if (!node || !node.isConnected || !node.getBoundingClientRect) return false;
    var rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && styledVisible(node, null);
  }
  function controlVisible(node) {
    if (ownVisible(node)) return true;
    // A styled native checkbox/radio is often transparent inside its visible label. Keep the
    // native input as the ref so checked/disabled state and click activation remain authoritative.
    if (!node || node.tagName !== 'INPUT'
      || (node.type !== 'checkbox' && node.type !== 'radio') || !node.isConnected) return false;
    var rect = node.getBoundingClientRect();
    var view = node.ownerDocument && node.ownerDocument.defaultView;
    if (rect.width <= 0 || rect.height <= 0 || !view
      || view.getComputedStyle(node).opacity !== '0' || !styledVisible(node, node)) return false;
    return Array.from(node.labels || []).some(function (label) { return ownVisible(label); });
  }
  function visible(node, frameHosts) {
    if (!controlVisible(node)) return false;
    for (var hostIndex = 0; hostIndex < frameHosts.length; hostIndex += 1) {
      if (!ownVisible(frameHosts[hostIndex])) return false;
    }
    return true;
  }
`;
