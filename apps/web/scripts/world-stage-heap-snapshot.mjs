import { readFile } from 'node:fs/promises';

function requireField(fields, name, section) {
  const index = fields.indexOf(name);
  if (index === -1) {
    throw new Error(`Heap snapshot ${section} is missing ${name}`);
  }
  return index;
}

function constructorName(type, name) {
  if (type === 'object' || type === 'native') {
    return name || `(${type})`;
  }
  if (type === 'closure') {
    return name ? `${name} (closure)` : '(anonymous closure)';
  }
  return name ? `(${type}) ${name}` : `(${type})`;
}

function constructorKey(type, name) {
  return `${type}\u0000${name}`;
}

function aggregateName(name) {
  return name.replace(/\s+@(?:0x[0-9a-f]+|\d+)$/i, '');
}

function cleanLabel(value, limit = 120) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
}

export function withinGrowthTolerance(baseline, final, tolerance) {
  return (
    typeof baseline === 'number' &&
    typeof final === 'number' &&
    final <= baseline * (1 + tolerance)
  );
}

function analyzeSnapshot(snapshot, keepGraph) {
  const meta = snapshot?.snapshot?.meta;
  const nodes = snapshot?.nodes;
  const edges = snapshot?.edges;
  const strings = snapshot?.strings;
  if (
    !meta ||
    !Array.isArray(nodes) ||
    !Array.isArray(edges) ||
    !Array.isArray(strings)
  ) {
    throw new Error('Heap snapshot JSON is missing nodes, edges, or strings');
  }

  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodeFieldCount = nodeFields.length;
  const edgeFieldCount = edgeFields.length;
  const nodeTypeOffset = requireField(nodeFields, 'type', 'node_fields');
  const nodeNameOffset = requireField(nodeFields, 'name', 'node_fields');
  const nodeIdOffset = requireField(nodeFields, 'id', 'node_fields');
  const nodeSelfSizeOffset = requireField(
    nodeFields,
    'self_size',
    'node_fields',
  );
  const nodeEdgeCountOffset = requireField(
    nodeFields,
    'edge_count',
    'node_fields',
  );
  const edgeTypeOffset = requireField(edgeFields, 'type', 'edge_fields');
  const edgeNameOffset = requireField(
    edgeFields,
    'name_or_index',
    'edge_fields',
  );
  const edgeToNodeOffset = requireField(
    edgeFields,
    'to_node',
    'edge_fields',
  );
  const nodeTypes = meta.node_types[nodeTypeOffset];
  const edgeTypes = meta.edge_types[edgeTypeOffset];
  const nodeCount = nodes.length / nodeFieldCount;
  if (!Number.isInteger(nodeCount) || nodeCount === 0) {
    throw new Error('Heap snapshot node array has an invalid length');
  }

  const edgeStarts = new Int32Array(nodeCount + 1);
  let edgeCursor = 0;
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
    edgeStarts[nodeIndex] = edgeCursor;
    edgeCursor +=
      nodes[nodeIndex * nodeFieldCount + nodeEdgeCountOffset] * edgeFieldCount;
  }
  edgeStarts[nodeCount] = edgeCursor;
  if (edgeCursor !== edges.length) {
    throw new Error(
      `Heap snapshot edge count mismatch: expected ${edgeCursor}, got ${edges.length}`,
    );
  }
  const edgeIsRetaining = (edgeOffset) =>
    edgeTypes[edges[edgeOffset + edgeTypeOffset]] !== 'weak';

  // Iterative DFS supplies the spanning tree needed by Lengauer-Tarjan and an
  // actual root-to-node edge path for representative retainer chains.
  const dfsByNode = new Int32Array(nodeCount);
  const vertex = new Int32Array(nodeCount + 1);
  const parent = new Int32Array(nodeCount + 1);
  const parentEdge = new Int32Array(nodeCount + 1);
  parentEdge.fill(-1);
  const stackNodes = new Int32Array(nodeCount);
  const stackEdges = new Int32Array(nodeCount);
  const stackEnds = new Int32Array(nodeCount);
  let reachableCount = 1;
  let stackTop = 0;
  dfsByNode[0] = 1;
  vertex[1] = 0;
  stackNodes[0] = 0;
  stackEdges[0] = edgeStarts[0];
  stackEnds[0] = edgeStarts[1];

  while (stackTop >= 0) {
    const edgeOffset = stackEdges[stackTop];
    if (edgeOffset >= stackEnds[stackTop]) {
      stackTop -= 1;
      continue;
    }
    stackEdges[stackTop] += edgeFieldCount;
    if (!edgeIsRetaining(edgeOffset)) continue;
    const targetNodeOffset = edges[edgeOffset + edgeToNodeOffset];
    const targetNodeIndex = targetNodeOffset / nodeFieldCount;
    if (
      !Number.isInteger(targetNodeIndex) ||
      targetNodeIndex < 0 ||
      targetNodeIndex >= nodeCount
    ) {
      throw new Error(`Heap snapshot edge has invalid target ${targetNodeOffset}`);
    }
    if (dfsByNode[targetNodeIndex] !== 0) continue;

    reachableCount += 1;
    dfsByNode[targetNodeIndex] = reachableCount;
    vertex[reachableCount] = targetNodeIndex;
    parent[reachableCount] = dfsByNode[stackNodes[stackTop]];
    parentEdge[reachableCount] = edgeOffset;
    stackTop += 1;
    stackNodes[stackTop] = targetNodeIndex;
    stackEdges[stackTop] = edgeStarts[targetNodeIndex];
    stackEnds[stackTop] = edgeStarts[targetNodeIndex + 1];
  }

  let reachableEdgeCount = 0;
  for (let sourceNode = 0; sourceNode < nodeCount; sourceNode += 1) {
    if (dfsByNode[sourceNode] === 0) continue;
    for (
      let edgeOffset = edgeStarts[sourceNode];
      edgeOffset < edgeStarts[sourceNode + 1];
      edgeOffset += edgeFieldCount
    ) {
      if (!edgeIsRetaining(edgeOffset)) continue;
      const targetNode =
        edges[edgeOffset + edgeToNodeOffset] / nodeFieldCount;
      if (dfsByNode[targetNode] !== 0) reachableEdgeCount += 1;
    }
  }

  const predecessorHead = new Int32Array(reachableCount + 1);
  predecessorHead.fill(-1);
  const predecessorFrom = new Int32Array(reachableEdgeCount);
  const predecessorNext = new Int32Array(reachableEdgeCount);
  let predecessorCursor = 0;
  for (let sourceNode = 0; sourceNode < nodeCount; sourceNode += 1) {
    const sourceDfs = dfsByNode[sourceNode];
    if (sourceDfs === 0) continue;
    for (
      let edgeOffset = edgeStarts[sourceNode];
      edgeOffset < edgeStarts[sourceNode + 1];
      edgeOffset += edgeFieldCount
    ) {
      if (!edgeIsRetaining(edgeOffset)) continue;
      const targetNode =
        edges[edgeOffset + edgeToNodeOffset] / nodeFieldCount;
      const targetDfs = dfsByNode[targetNode];
      if (targetDfs === 0) continue;
      predecessorFrom[predecessorCursor] = sourceDfs;
      predecessorNext[predecessorCursor] = predecessorHead[targetDfs];
      predecessorHead[targetDfs] = predecessorCursor;
      predecessorCursor += 1;
    }
  }

  // Lengauer-Tarjan immediate dominators, using DFS numbers throughout.
  const semi = new Int32Array(reachableCount + 1);
  const idom = new Int32Array(reachableCount + 1);
  const ancestor = new Int32Array(reachableCount + 1);
  const label = new Int32Array(reachableCount + 1);
  const bucketHead = new Int32Array(reachableCount + 1);
  const bucketNext = new Int32Array(reachableCount + 1);
  bucketHead.fill(-1);
  bucketNext.fill(-1);
  for (let dfs = 1; dfs <= reachableCount; dfs += 1) {
    semi[dfs] = dfs;
    label[dfs] = dfs;
  }

  const compressionStack = [];
  function compress(dfs) {
    compressionStack.length = 0;
    let current = dfs;
    while (ancestor[current] !== 0 && ancestor[ancestor[current]] !== 0) {
      compressionStack.push(current);
      current = ancestor[current];
    }
    for (let index = compressionStack.length - 1; index >= 0; index -= 1) {
      const item = compressionStack[index];
      const itemAncestor = ancestor[item];
      if (semi[label[itemAncestor]] < semi[label[item]]) {
        label[item] = label[itemAncestor];
      }
      ancestor[item] = ancestor[itemAncestor];
    }
  }

  function evaluate(dfs) {
    if (ancestor[dfs] === 0) return label[dfs];
    compress(dfs);
    const ancestorLabel = label[ancestor[dfs]];
    return semi[ancestorLabel] < semi[label[dfs]]
      ? ancestorLabel
      : label[dfs];
  }

  for (let dfs = reachableCount; dfs >= 2; dfs -= 1) {
    for (
      let predecessor = predecessorHead[dfs];
      predecessor !== -1;
      predecessor = predecessorNext[predecessor]
    ) {
      const evaluated = evaluate(predecessorFrom[predecessor]);
      if (semi[evaluated] < semi[dfs]) semi[dfs] = semi[evaluated];
    }
    bucketNext[dfs] = bucketHead[semi[dfs]];
    bucketHead[semi[dfs]] = dfs;
    ancestor[dfs] = parent[dfs];

    let bucketItem = bucketHead[parent[dfs]];
    bucketHead[parent[dfs]] = -1;
    while (bucketItem !== -1) {
      const nextBucketItem = bucketNext[bucketItem];
      const evaluated = evaluate(bucketItem);
      idom[bucketItem] =
        semi[evaluated] < semi[bucketItem] ? evaluated : parent[dfs];
      bucketItem = nextBucketItem;
    }
  }
  for (let dfs = 2; dfs <= reachableCount; dfs += 1) {
    if (idom[dfs] !== semi[dfs]) idom[dfs] = idom[idom[dfs]];
  }

  const retainedSizes = new Float64Array(reachableCount + 1);
  for (let dfs = 1; dfs <= reachableCount; dfs += 1) {
    const nodeIndex = vertex[dfs];
    retainedSizes[dfs] =
      nodes[nodeIndex * nodeFieldCount + nodeSelfSizeOffset];
  }
  for (let dfs = reachableCount; dfs >= 2; dfs -= 1) {
    retainedSizes[idom[dfs]] += retainedSizes[dfs];
  }

  // DevTools constructor aggregates use the maximum retained size in a group,
  // avoiding double-counting when same-constructor instances dominate others.
  const aggregates = new Map();
  for (let dfs = 1; dfs <= reachableCount; dfs += 1) {
    const nodeIndex = vertex[dfs];
    const nodeOffset = nodeIndex * nodeFieldCount;
    const type = nodeTypes[nodes[nodeOffset + nodeTypeOffset]];
    const name = aggregateName(
      strings[nodes[nodeOffset + nodeNameOffset]] ?? '',
    );
    const key = constructorKey(type, name);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        key,
        constructor: constructorName(type, name),
        nodeType: type,
        rawName: name,
        count: 0,
        selfSizeBytes: 0,
        retainedSizeBytes: 0,
        representativeDfs: dfs,
      };
      aggregates.set(key, aggregate);
    }
    aggregate.count += 1;
    aggregate.selfSizeBytes += nodes[nodeOffset + nodeSelfSizeOffset];
    if (retainedSizes[dfs] > aggregate.retainedSizeBytes) {
      aggregate.retainedSizeBytes = retainedSizes[dfs];
      aggregate.representativeDfs = dfs;
    }
  }

  const result = {
    aggregates,
    nodeCount,
    reachableCount,
    edgeCount: edges.length / edgeFieldCount,
  };
  if (keepGraph) {
    result.graph = {
      nodes,
      edges,
      strings,
      nodeFieldCount,
      nodeTypeOffset,
      nodeNameOffset,
      nodeIdOffset,
      edgeFieldCount,
      edgeTypeOffset,
      edgeNameOffset,
      nodeTypes,
      edgeTypes,
      vertex,
      parent,
      parentEdge,
    };
  }
  return result;
}

async function analyzeSnapshotFile(path, keepGraph) {
  const source = await readFile(path, 'utf8');
  const snapshot = JSON.parse(source);
  return analyzeSnapshot(snapshot, keepGraph);
}

function nodeLabel(graph, dfs) {
  const nodeIndex = graph.vertex[dfs];
  const nodeOffset = nodeIndex * graph.nodeFieldCount;
  const type = graph.nodeTypes[graph.nodes[nodeOffset + graph.nodeTypeOffset]];
  const name =
    graph.strings[graph.nodes[nodeOffset + graph.nodeNameOffset]] ?? '';
  const id = graph.nodes[nodeOffset + graph.nodeIdOffset];
  return `${constructorName(type, cleanLabel(name))} #${id}`;
}

function edgeLabel(graph, edgeOffset) {
  const type =
    graph.edgeTypes[graph.edges[edgeOffset + graph.edgeTypeOffset]] ?? 'edge';
  const rawName = graph.edges[edgeOffset + graph.edgeNameOffset];
  const name =
    type === 'element' || type === 'hidden'
      ? rawName
      : graph.strings[rawName] ?? rawName;
  return `${type}:${cleanLabel(name, 80)}`;
}

function representativeRetainerChain(analysis, groupKey) {
  const aggregate = analysis.aggregates.get(groupKey);
  const graph = analysis.graph;
  if (!aggregate || !graph) return null;

  const reverseSteps = [];
  let dfs = aggregate.representativeDfs;
  while (dfs > 1 && reverseSteps.length < analysis.reachableCount) {
    const parentDfs = graph.parent[dfs];
    reverseSteps.push({
      from: nodeLabel(graph, parentDfs),
      edge: edgeLabel(graph, graph.parentEdge[dfs]),
      to: nodeLabel(graph, dfs),
    });
    dfs = parentDfs;
  }
  const steps = reverseSteps.reverse();
  const trimmed =
    steps.length <= 12
      ? steps
      : [
          ...steps.slice(0, 5),
          { omittedSteps: steps.length - 12 },
          ...steps.slice(-7),
        ];
  return {
    constructor: aggregate.constructor,
    nodeType: aggregate.nodeType,
    representativeRetainedSizeBytes: aggregate.retainedSizeBytes,
    reachedRoot: dfs === 1,
    totalSteps: steps.length,
    steps: trimmed,
  };
}

export async function diffHeapSnapshots(baselinePath, finalPath) {
  const baseline = await analyzeSnapshotFile(baselinePath, false);
  const final = await analyzeSnapshotFile(finalPath, true);
  const keys = new Set([
    ...baseline.aggregates.keys(),
    ...final.aggregates.keys(),
  ]);
  const constructors = [];
  for (const key of keys) {
    const before = baseline.aggregates.get(key);
    const after = final.aggregates.get(key);
    constructors.push({
      key,
      constructor: after?.constructor ?? before?.constructor ?? '(unknown)',
      nodeType: after?.nodeType ?? before?.nodeType ?? 'unknown',
      countAtBaseline: before?.count ?? 0,
      countAtFinal: after?.count ?? 0,
      countDelta: (after?.count ?? 0) - (before?.count ?? 0),
      selfSizeAtBaselineBytes: before?.selfSizeBytes ?? 0,
      selfSizeAtFinalBytes: after?.selfSizeBytes ?? 0,
      selfSizeDeltaBytes:
        (after?.selfSizeBytes ?? 0) - (before?.selfSizeBytes ?? 0),
      retainedSizeAtBaselineBytes: before?.retainedSizeBytes ?? 0,
      retainedSizeAtFinalBytes: after?.retainedSizeBytes ?? 0,
      retainedSizeDeltaBytes:
        (after?.retainedSizeBytes ?? 0) - (before?.retainedSizeBytes ?? 0),
    });
  }
  constructors.sort(
    (left, right) =>
      right.retainedSizeDeltaBytes - left.retainedSizeDeltaBytes ||
      right.selfSizeDeltaBytes - left.selfSizeDeltaBytes ||
      right.countDelta - left.countDelta,
  );
  const positiveGrowth = constructors.filter(
    (entry) =>
      entry.retainedSizeDeltaBytes > 0 &&
      entry.nodeType !== 'synthetic' &&
      entry.nodeType !== 'hidden',
  );
  const topConstructors = (positiveGrowth.length > 0
    ? positiveGrowth
    : constructors
  )
    .slice(0, 20)
    .map(({ key, ...entry }) => entry);
  const topKeys = (positiveGrowth.length > 0 ? positiveGrowth : constructors)
    .slice(0, 3)
    .map((entry) => entry.key);
  const retainerChains = topKeys
    .map((key) => representativeRetainerChain(final, key))
    .filter(Boolean);

  return {
    aggregation:
      'Constructor/name groups; retained size is the maximum dominator-tree retained size within each group, matching DevTools aggregate semantics.',
    baseline: {
      nodeCount: baseline.nodeCount,
      reachableNodeCount: baseline.reachableCount,
      edgeCount: baseline.edgeCount,
    },
    final: {
      nodeCount: final.nodeCount,
      reachableNodeCount: final.reachableCount,
      edgeCount: final.edgeCount,
    },
    topConstructors,
    retainerChains,
  };
}

export function renderHeapDiffReport(summary, summaryPath) {
  const heapDiff = summary.heapDiff;
  const lines = [
    '# P1c Heap Retention Naming Report',
    '',
    `**Generated:** ${summary.generatedAt}`,
    `**Lane:** \`${summary.lane}\``,
    `**Loops:** ${summary.completedRoundTrips}/${summary.requestedRoundTrips}`,
    `**Summary:** \`${summaryPath}\``,
    '',
    '## Snapshot diff',
    '',
    `Snapshots were forced-GC captures at loops ${heapDiff.snapshotLoops.join(
      ' and ',
    )}. ${heapDiff.aggregation}`,
    '',
    '| Rank | Constructor | Type | Count at loop 20 | Count at loop 50 | Count delta | Self-size delta | Retained-size delta |',
    '|---:|---|---|---:|---:|---:|---:|---:|',
  ];
  heapDiff.topConstructors.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${entry.constructor.replaceAll('|', '\\|')} | ${entry.nodeType} | ${entry.countAtBaseline} | ${entry.countAtFinal} | ${entry.countDelta} | ${entry.selfSizeDeltaBytes} | ${entry.retainedSizeDeltaBytes} |`,
    );
  });
  lines.push(
    '',
    '## Representative retainer chains',
    '',
    'Each chain follows real snapshot edges on the DFS root path to the',
    'maximum-retained final-snapshot representative. Long paths are trimmed.',
    '',
  );
  heapDiff.retainerChains.forEach((chain, index) => {
    lines.push(
      `### ${index + 1}. ${chain.constructor}`,
      '',
      `Representative retained size: ${chain.representativeRetainedSizeBytes} bytes; root reached: ${chain.reachedRoot}.`,
      '',
    );
    chain.steps.forEach((step) => {
      if ('omittedSteps' in step) {
        lines.push(`- … ${step.omittedSteps} intermediate edges omitted …`);
      } else {
        lines.push(`- ${step.from} —[${step.edge}]→ ${step.to}`);
      }
    });
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

export const testOnly = {
  aggregateName,
  analyzeSnapshot,
};
