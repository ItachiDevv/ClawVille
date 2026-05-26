(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { error: 'no canvas' };
  // R3F stores its root state at canvas.__r3f or via fiber
  const r3f = canvas.__r3f;
  // Try fiber walk
  const fiberKey = Object.keys(canvas).find(k => k.startsWith('__reactFiber'));
  const propsKey = Object.keys(canvas).find(k => k.startsWith('__reactProps'));
  const fiber = fiberKey ? canvas[fiberKey] : null;
  // Walk up fiber to find R3F root
  let scene = null;
  let cur = fiber;
  for (let i = 0; i < 30 && cur; i++) {
    if (cur.stateNode?.scene) {
      scene = cur.stateNode.scene;
      break;
    }
    if (cur.memoizedProps?.scene) {
      scene = cur.memoizedProps.scene;
      break;
    }
    cur = cur.return;
  }
  // R3F v9 — try canvas-attached state
  const r3fState = (canvas)._r3f || (canvas).__r3f;
  // Also probe by querying the global Three.js cache (sometimes scenes are accessible via THREE)
  return {
    hasR3F: !!r3f,
    r3fState: r3fState ? { hasState: true, sceneChildren: r3fState.scene?.children?.length, callsThisFrame: r3fState.gl?.info?.render?.calls } : null,
    fiberFound: !!fiber,
    sceneFromFiber: scene ? { children: scene.children?.length, uuid: scene.uuid?.slice(-6) } : null,
    // Look for slot machine entities or game cove globals
    customGlobals: Object.keys(window).filter(k => k.includes('cove') || k.includes('slot') || k.includes('Cove') || k.includes('Slot')).slice(0, 10),
    visibility: document.visibilityState,
  };
})()
