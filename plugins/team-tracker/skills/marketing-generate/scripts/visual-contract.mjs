// Requested preferences are separate from the immutable resolved render recipe.
export function mergeDesign(base, patch) {
  const result = structuredClone(base || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid design key');
    if (value === undefined) continue;
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeDesign(result[key], value) : structuredClone(value);
  }
  return result;
}

// Explicit reset at a scope restores project defaults; more specific choices still win.
export function resolveVisualDirection(defaults, ...preferences) {
  let direction = structuredClone(defaults);
  for (const preference of preferences.filter(Boolean)) {
    if (preference.mode === 'project_default') direction = structuredClone(defaults);
    direction = mergeDesign(direction, preference.overrides);
    if (preference.request) direction.user_request = String(preference.request);
  }
  return direction;
}

// Targeted regeneration pins every unspecified field, including copy and source selection.
export function reviseSlides(previous, changes) {
  const indices = new Set(previous.map(slide => slide.order_index));
  for (const change of changes) if (!indices.has(change.order_index)) throw new Error('unknown target slide');
  return previous.map(slide => {
    const change = changes.find(item => item.order_index === slide.order_index);
    return change ? mergeDesign(slide, change) : structuredClone(slide);
  });
}
